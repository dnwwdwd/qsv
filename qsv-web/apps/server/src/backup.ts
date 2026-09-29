import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type Dirent } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'
import { isCommit, readCommit, syncDirectory, syncFile, verifyCommit, ensureDurableDirectory } from './commit.ts'
import { digestFile } from './files.ts'
import { acquireInstanceLock, preparePrivateDataDir } from './instance-lock.ts'
import { WebDatabase } from './database.ts'
import { recoverStartup } from './recovery.ts'

interface BackupFile { path: string; sha256: string; bytes: number }
interface BackupManifest { version: 1; createdAt: number; files: BackupFile[]; resourceCount: number }
interface StoredResource { id: string; owner_key: string; kind: string; status: string; storage_relpath: string; content_hash: string | null; metadata_json: string }

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const OLD_STAGING_GRACE_MS = 60 * 60 * 1000

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

async function cleanupAbandonedStaging(target: string) {
  const parent = dirname(target)
  const prefix = `${basename(target)}.partial-`
  let entries: Dirent[]
  try { entries = await readdir(parent, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  let removed = 0
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue
    const suffix = entry.name.slice(prefix.length)
    const current = /^(\d+)-[0-9a-f-]{36}$/.exec(suffix)
    const old = /^[0-9a-f-]{36}$/.test(suffix)
    if (!current && !old) continue
    const path = join(parent, entry.name)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`暂存路径类型无效：${path}`)
    if (current && pidAlive(Number(current[1])) && Date.now() - info.mtimeMs < OLD_STAGING_GRACE_MS) {
      throw new Error('同一目标的备份或恢复仍在运行')
    }
    if (old && Date.now() - info.mtimeMs < OLD_STAGING_GRACE_MS) throw new Error('同一目标有较新的旧暂存目录，请稍后重试')
    await rm(path, { recursive: true, force: true })
    removed += 1
  }
  if (removed > 0) await syncDirectory(parent)
}

function keepStagingAlive(path: string) {
  const timer = setInterval(() => { void utimes(path, new Date(), new Date()).catch(() => {}) }, 30_000)
  timer.unref()
  return () => clearInterval(timer)
}

function contained(base: string, target: string) {
  const rel = relative(resolve(base), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function portable(path: string) { return path.split(sep).join('/') }

function validBackupPath(path: string) {
  return path === 'meta.sqlite' || (/^owners\/[0-9a-f]{24}\/(resources|jobs|config)\/.+/.test(path) &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..' || part.includes('\\')))
}

async function copyAndHash(source: string, target: string): Promise<BackupFile> {
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length
    hash.update(chunk)
    callback(null, chunk)
  } })
  await pipeline(createReadStream(source), meter, createWriteStream(target, { flags: 'wx', mode: 0o600 }))
  await syncFile(target)
  return { path: '', sha256: hash.digest('hex'), bytes }
}

async function walkFiles(root: string, relpath: string, result: string[]) {
  const directory = join(root, relpath)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.endsWith('.partial')) continue
    const child = join(relpath, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`备份路径包含符号链接：${child}`)
    if (entry.isDirectory()) await walkFiles(root, child, result)
    else if (entry.isFile()) result.push(child)
    else throw new Error(`备份路径不是普通文件：${child}`)
  }
}

function manifestShape(value: unknown): value is BackupManifest {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<BackupManifest>
  return item.version === 1 && Number.isSafeInteger(item.createdAt) && Number.isSafeInteger(item.resourceCount) &&
    Array.isArray(item.files) && item.files.length > 0 && item.files.length <= 100_000 &&
    item.files.every((file) => file && validBackupPath(file.path) && /^[0-9a-f]{64}$/.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes >= 0)
}

/** 服务必须先停止；独占目录后才创建 SQLite 快照与资源文件清单。 */
export async function createBackup(dataDir: string, outputDir: string) {
  const source = resolve(dataDir)
  const output = resolve(outputDir)
  if (contained(source, output) || source === output) throw new Error('备份目录不能位于数据目录内')
  await preparePrivateDataDir(source)
  await lstat(join(source, 'meta.sqlite'))
  try { await lstat(output); throw new Error('备份目标已存在，不能覆盖') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const release = await acquireInstanceLock(source)
  const staging = `${output}.partial-${process.pid}-${randomUUID()}`
  let snapshot: Database.Database | null = null
  let stopHeartbeat: (() => void) | null = null
  try {
    await cleanupAbandonedStaging(output)
    await mkdir(staging, { recursive: false, mode: 0o700 })
    stopHeartbeat = keepStagingAlive(staging)
    const recoveryDb = new WebDatabase(source)
    try { await recoverStartup(recoveryDb, source) } finally { recoveryDb.close() }
    const live = new Database(join(source, 'meta.sqlite'), { readonly: true, fileMustExist: true })
    try { await live.backup(join(staging, 'meta.sqlite')) } finally { live.close() }
    await syncFile(join(staging, 'meta.sqlite'))
    snapshot = new Database(join(staging, 'meta.sqlite'), { readonly: true, fileMustExist: true })
    if (snapshot.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('SQLite 快照校验失败')
    const resources = snapshot.prepare("SELECT id,owner_key,kind,status,storage_relpath,content_hash,metadata_json FROM resources WHERE storage_relpath IS NOT NULL AND status IN ('ready','trashed')").all() as StoredResource[]
    const selected = new Set<string>(['meta.sqlite'])
    for (const row of resources) {
      const workspaceId = row.owner_key.slice(0, 24)
      const resourceRoot = join('owners', workspaceId, 'resources', row.id)
      const expected = `${portable(resourceRoot)}/`
      if (!/^[0-9a-f]{64}$/.test(row.owner_key) || !/^res_[0-9a-f-]{36}$/.test(row.id) ||
        !portable(row.storage_relpath).startsWith(expected)) throw new Error(`资源 ${row.id} 的文件路径无效`)
      const mainPath = resolve(source, row.storage_relpath)
      if (!contained(source, mainPath)) throw new Error(`资源 ${row.id} 的文件路径越界`)
      const mainDigest = await digestFile(mainPath)
      if (row.content_hash !== `sha256:${mainDigest.sha256}`) throw new Error(`资源 ${row.id} 的内容摘要不匹配`)
      if (row.kind === 'dataset') await lstat(`${mainPath}.idx`)
      const details = JSON.parse(row.metadata_json) as Record<string, unknown>
      if (details.commitVersion === 1) {
        const commit = await readCommit(join(source, resourceRoot, 'commit.json'))
        if (!isCommit(commit) || commit.resourceId !== row.id || !await verifyCommit(source, commit)) {
          throw new Error(`资源 ${row.id} 的提交凭据不完整`)
        }
      }
      const files: string[] = []
      await walkFiles(source, resourceRoot, files)
      for (const file of files) selected.add(portable(file))
    }
    const ownersPath = join(source, 'owners')
    let ownerEntries: Dirent[] = []
    try { ownerEntries = await readdir(ownersPath, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const owner of ownerEntries) {
      if (!owner.isDirectory() || !/^[0-9a-f]{24}$/.test(owner.name)) continue
      for (const group of ['jobs', 'config'] as const) {
        const relpath = join('owners', owner.name, group)
        let info: Awaited<ReturnType<typeof lstat>>
        try { info = await lstat(join(source, relpath)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`备份目录类型无效：${relpath}`)
        const files: string[] = []
        await walkFiles(source, relpath, files)
        for (const file of files) selected.add(portable(file))
      }
    }
    snapshot.close()
    snapshot = null
    const files: BackupFile[] = []
    for (const path of [...selected].sort()) {
      if (!validBackupPath(path)) throw new Error(`备份文件路径无效：${path}`)
      const relpath = join(...path.split('/'))
      const target = join(staging, relpath)
      if (path !== 'meta.sqlite') {
        await ensureDurableDirectory(staging, dirname(relpath))
        const digest = await copyAndHash(join(source, relpath), target)
        files.push({ path, sha256: digest.sha256, bytes: digest.bytes })
      } else {
        const digest = await digestFile(target)
        files.push({ path, sha256: digest.sha256, bytes: digest.bytes })
      }
    }
    const manifest: BackupManifest = { version: 1, createdAt: Date.now(), files, resourceCount: resources.length }
    if (!manifestShape(manifest) || Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES) {
      throw new Error('备份文件数量或清单大小超过当前版本可恢复的上限')
    }
    const manifestPath = join(staging, 'backup-manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    await syncFile(manifestPath)
    await syncDirectory(staging)
    await rename(staging, output)
    await syncDirectory(dirname(output))
    return { output, resourceCount: resources.length, fileCount: files.length }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    stopHeartbeat?.()
    snapshot?.close()
    await release()
  }
}

/** 只恢复到不存在的新目录；逐文件验证后才发布。 */
export async function restoreBackup(backupDir: string, targetDir: string) {
  const backup = resolve(backupDir)
  const target = resolve(targetDir)
  if (contained(backup, target) || backup === target) throw new Error('恢复目标不能位于备份目录内')
  const backupInfo = await lstat(backup)
  if (!backupInfo.isDirectory() || backupInfo.isSymbolicLink()) throw new Error('备份目录不是普通目录')
  try { await lstat(target); throw new Error('恢复目标已存在，不能覆盖') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const manifestPath = join(backup, 'backup-manifest.json')
  const manifestInfo = await lstat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_MANIFEST_BYTES) throw new Error('备份清单类型或大小无效')
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifestShape(value)) throw new Error('备份清单无效')
  const paths = new Set(value.files.map((file) => file.path))
  if (paths.size !== value.files.length || !paths.has('meta.sqlite')) throw new Error('备份文件清单重复或缺少数据库')
  await cleanupAbandonedStaging(target)
  const staging = `${target}.partial-${process.pid}-${randomUUID()}`
  let stopHeartbeat: (() => void) | null = null
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 })
    stopHeartbeat = keepStagingAlive(staging)
    for (const file of value.files) {
      const relpath = join(...file.path.split('/'))
      let parent = backup
      for (const part of file.path.split('/').slice(0, -1)) {
        parent = join(parent, part)
        const parentInfo = await lstat(parent)
        if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`备份路径包含非普通目录：${file.path}`)
      }
      const source = join(backup, relpath)
      const info = await lstat(source)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`备份文件类型无效：${file.path}`)
      if (dirname(relpath) !== '.') await ensureDurableDirectory(staging, dirname(relpath))
      const actual = await copyAndHash(source, join(staging, relpath))
      if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`备份文件校验失败：${file.path}`)
    }
    const database = new Database(join(staging, 'meta.sqlite'), { readonly: true, fileMustExist: true })
    try {
      if (database.pragma('quick_check', { simple: true }) !== 'ok' ||
        (database.pragma('user_version', { simple: true }) as number) > 4) throw new Error('备份数据库校验失败或版本过高')
      const resources = database.prepare("SELECT id,owner_key,kind,status,storage_relpath,content_hash,metadata_json FROM resources WHERE storage_relpath IS NOT NULL AND status IN ('ready','trashed')").all() as StoredResource[]
      if (resources.length !== value.resourceCount) throw new Error('备份资源数量与数据库不一致')
      for (const row of resources) {
        const workspaceId = row.owner_key.slice(0, 24)
        const resourceRoot = `owners/${workspaceId}/resources/${row.id}`
        const mainRelpath = portable(row.storage_relpath)
        if (!/^[0-9a-f]{64}$/.test(row.owner_key) || !/^res_[0-9a-f-]{36}$/.test(row.id) ||
          !mainRelpath.startsWith(`${resourceRoot}/`) || !paths.has(mainRelpath)) {
          throw new Error(`备份资源 ${row.id} 的文件缺失或路径无效`)
        }
        const mainPath = resolve(staging, row.storage_relpath)
        if (!contained(staging, mainPath)) throw new Error(`备份资源 ${row.id} 的路径越界`)
        const digest = await digestFile(mainPath)
        if (row.content_hash !== `sha256:${digest.sha256}`) throw new Error(`备份资源 ${row.id} 的内容摘要不一致`)
        if (row.kind === 'dataset' && !paths.has(`${mainRelpath}.idx`)) throw new Error(`备份资源 ${row.id} 的索引缺失`)
        const details = JSON.parse(row.metadata_json) as Record<string, unknown>
        if (details.commitVersion === 1) {
          const commitRelpath = `${resourceRoot}/commit.json`
          if (!paths.has(commitRelpath)) throw new Error(`备份资源 ${row.id} 的提交凭据缺失`)
          const commit = await readCommit(join(staging, commitRelpath))
          if (!isCommit(commit) || commit.resourceId !== row.id || commit.ownerKey !== row.owner_key ||
            commit.kind !== row.kind || commit.relpath !== row.storage_relpath ||
            row.content_hash !== `sha256:${commit.sha256}` || !await verifyCommit(staging, commit)) {
            throw new Error(`备份资源 ${row.id} 的提交凭据不一致`)
          }
        }
      }
    } finally { database.close() }
    await syncDirectory(staging)
    await rename(staging, target)
    await syncDirectory(dirname(target))
    return { target, resourceCount: value.resourceCount, fileCount: value.files.length }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  } finally {
    stopHeartbeat?.()
  }
}
