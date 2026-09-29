import { lstat, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isCommit, readCommit, syncDirectory, verifyCommit, type DatasetCommit, type ExportCommit } from './commit.ts'
import { type ResourceRow, WebDatabase } from './database.ts'
import { MAX_UPLOAD_BYTES, uploadSizeLimit } from './files.ts'

const TUS_STALE_MS = 7 * 24 * 60 * 60 * 1000

function sourcesMatch(db: WebDatabase, commit: DatasetCommit | ExportCommit, allowMissing = false) {
  const sources = [{ id: commit.sourceId, hash: commit.sourceHash }, ...(commit.additionalSources ?? [])]
  return sources.every((source) => {
    const current = db.getResource(commit.ownerKey, source.id)
    return current ? current.content_hash === source.hash : allowMissing
  })
}

function sourceIds(commit: DatasetCommit | ExportCommit) { return [commit.sourceId, ...(commit.additionalSources ?? []).map((source) => source.id)] }

function exportColumnCount(db: WebDatabase, commit: ExportCommit) {
  return commit.columnCount ?? Math.max(...sourceIds(commit).map((id) => db.getResource(commit.ownerKey, id)?.column_count ?? 0))
}

function validTusRecord(value: unknown, id: string, workspaceId: string): value is { size: number; offset: number } {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const meta = record.metadata as Record<string, unknown> | undefined
  let formatLimit: number
  try { formatLimit = uploadSizeLimit(String(meta?.filename)) } catch { return false }
  return record.id === id && Number.isSafeInteger(record.size) && Number(record.size) >= 1 && Number(record.size) <= MAX_UPLOAD_BYTES && Number(record.size) <= formatLimit &&
    Number.isSafeInteger(record.offset) && Number(record.offset) >= 0 && Number(record.offset) <= Number(record.size) &&
    meta !== undefined && typeof meta.filename === 'string' && typeof meta.uploadKey === 'string' &&
    /^[A-Za-z0-9_-]{16,128}$/.test(meta.uploadKey) && /^[0-9a-f]{64}$/.test(String(meta.sha256)) &&
    /^[0-9a-f]{64}$/.test(String(meta.fingerprint)) &&
    (meta.workspaceId === undefined || meta.workspaceId === workspaceId)
}

async function directories(path: string) {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** 只凭已同步、与数据库引用一致的文件凭据恢复；其余执行标为中断。 */
export async function recoverStartup(db: WebDatabase, dataDir: string) {
  let rawRestored = 0
  let importsRestored = 0
  let exportsRestored = 0
  const checked = new Set<string>()
  const ownersDir = join(dataDir, 'owners')
  for (const workspaceId of await directories(ownersDir)) {
    if (!/^[0-9a-f]{24}$/.test(workspaceId)) continue
    const resourcesDir = join(ownersDir, workspaceId, 'resources')
    for (const resourceId of await directories(resourcesDir)) {
      if (!/^res_[0-9a-f-]{36}$/.test(resourceId)) continue
      const resourceDir = join(resourcesDir, resourceId)
      try {
        const marker = JSON.parse(await readFile(join(resourceDir, '.purged'), 'utf8')) as { resourceId?: string; ownerKey?: string }
        if (marker.resourceId === resourceId && /^[0-9a-f]{64}$/u.test(marker.ownerKey ?? '') &&
          marker.ownerKey!.slice(0, 24) === workspaceId &&
          !db.db.prepare('SELECT 1 FROM resources WHERE id=?').get(resourceId)) {
          await rm(resourceDir, { recursive: true, force: true })
          continue
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const manifestPath = join(resourcesDir, resourceId, 'commit.json')
      let value: unknown
      try { value = await readCommit(manifestPath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new Error(`资源 ${resourceId} 的提交凭据无法读取`, { cause: error })
      }
      if (!isCommit(value) || value.workspaceId !== workspaceId || value.resourceId !== resourceId) {
        throw new Error(`资源 ${resourceId} 的提交凭据无效`)
      }
      const commit = value
      const row = db.getResource(commit.ownerKey, resourceId)
      let verified = false
      try { verified = await verifyCommit(dataDir, commit) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!verified) {
        if (row?.status === 'ready') throw new Error(`已登记资源 ${resourceId} 的文件校验失败`)
        continue
      }
      if (row?.status === 'ready') {
        const details = JSON.parse(row.metadata_json) as Record<string, unknown>
        if (row.kind !== commit.kind || row.storage_relpath !== commit.relpath ||
          row.content_hash !== `sha256:${commit.sha256}` || row.byte_size !== commit.bytes || details.originalName !== commit.name) {
          throw new Error(`已登记资源 ${resourceId} 与提交凭据不一致`)
        }
        if (commit.kind === 'raw') {
          if (details.uploadKey !== commit.uploadKey) throw new Error(`原文件 ${resourceId} 的上传键与凭据不一致`)
        } else {
          const job = db.getJob(commit.ownerKey, commit.jobId)
          if (row.row_count !== commit.rowCount ||
            (commit.kind === 'dataset' && (row.column_count !== commit.headers.length || JSON.stringify(details.headers) !== JSON.stringify(commit.headers) ||
              (commit.compareSummary && JSON.stringify(details.compareSummary) !== JSON.stringify(commit.compareSummary)) ||
              (commit.qualitySummary && JSON.stringify(details.qualitySummary) !== JSON.stringify(commit.qualitySummary)))) ||
            (commit.kind === 'export' && (row.format !== commit.format ||
              (commit.columnCount !== undefined || sourceIds(commit).every((id) => Boolean(db.getResource(commit.ownerKey, id)))) &&
              row.column_count !== exportColumnCount(db, commit))) ||
            row.producer_job_id !== commit.jobId ||
            row.source_ids_json !== JSON.stringify(sourceIds(commit)) || !sourcesMatch(db, commit, true) ||
            job?.state !== 'succeeded' || job.engine_version !== commit.engineVersion ||
            job.input_ids_json !== JSON.stringify(sourceIds(commit)) ||
            (JSON.parse(job.summary_json) as { outputId?: string }).outputId !== resourceId) {
            throw new Error(`资源 ${resourceId} 的元数据与提交凭据不一致`)
          }
        }
        checked.add(resourceId)
        continue
      }
      if (commit.kind === 'raw' && !row) {
        if (db.findRawByUploadKey(commit.ownerKey, commit.uploadKey)) {
          throw new Error(`资源 ${resourceId} 的上传键与已有资源冲突`)
        }
        const restored: ResourceRow = {
          id: commit.resourceId, owner_key: commit.ownerKey, kind: 'raw', status: 'ready',
          name: commit.name, format: commit.name.toLowerCase().split('.').at(-1)!, group_id: commit.resourceId, version: 1,
          source_ids_json: '[]', producer_job_id: null, storage_relpath: commit.relpath,
          content_hash: `sha256:${commit.sha256}`, byte_size: commit.bytes,
          row_count: null, column_count: null,
          metadata_json: JSON.stringify({ originalName: commit.name, parseState: 'pending', uploadKey: commit.uploadKey, commitVersion: 1 }),
          created_at: commit.createdAt, updated_at: commit.createdAt, deleted_at: null,
        }
        db.insertResource(restored)
        checked.add(resourceId)
        rawRestored += 1
      }
      if (commit.kind === 'dataset' && row?.kind === 'dataset' && row.status === 'building') {
        const job = db.getJob(commit.ownerKey, commit.jobId)
        const source = db.getResource(commit.ownerKey, commit.sourceId)
        if (!job || !source || !['queued', 'running', 'interrupted'].includes(job.state) ||
          row.producer_job_id !== job.id || !sourcesMatch(db, commit) ||
          row.source_ids_json !== JSON.stringify(sourceIds(commit)) ||
          job.input_ids_json !== JSON.stringify(sourceIds(commit)) ||
          job.engine_version !== commit.engineVersion ||
          (JSON.parse(job.summary_json) as { outputId?: string }).outputId !== resourceId) continue
        db.completeImport(commit.ownerKey, resourceId, {
          status: 'ready', row_count: commit.rowCount, column_count: commit.headers.length,
          storage_relpath: commit.relpath, content_hash: `sha256:${commit.sha256}`,
          byte_size: commit.bytes, metadata_json: commit.metadataSnapshot ? JSON.stringify(commit.metadataSnapshot) : JSON.stringify({
            ...(JSON.parse(row.metadata_json) as Record<string, unknown>),
            originalName: commit.name, headers: commit.headers, indexState: 'ready', profileState: 'pending', commitVersion: 1,
            parseConfig: (JSON.parse(job.spec_json) as { csv?: unknown }).csv,
            sheetName: (JSON.parse(job.spec_json) as { sheetName?: string | null }).sheetName ?? null,
            ...(commit.compareSummary ? { compareSummary: commit.compareSummary } : {}),
            ...(commit.qualitySummary ? { qualitySummary: commit.qualitySummary } : {}),
          }),
        }, job.id, commit.rowCount, job.kind === 'filter' || job.kind === 'dedup' || job.kind === 'analyze' || job.kind === 'quality' ? source.row_count ?? commit.rowCount
          : job.kind === 'combine' || job.kind === 'compare' || job.kind === 'sql' ? sourceIds(commit).reduce((sum, id) => sum + (db.getResource(commit.ownerKey, id)?.row_count ?? 0), 0)
            : commit.rowCount)
        checked.add(resourceId)
        importsRestored += 1
      }
      if (commit.kind === 'export' && row?.kind === 'export' && row.status === 'building') {
        const job = db.getJob(commit.ownerKey, commit.jobId)
        const source = db.getResource(commit.ownerKey, commit.sourceId)
        if (!job || (job.kind !== 'export' && job.kind !== 'split') || !source || !sourcesMatch(db, commit) ||
          !['queued', 'running', 'interrupted'].includes(job.state) || row.producer_job_id !== job.id ||
          row.source_ids_json !== JSON.stringify(sourceIds(commit)) || row.format !== commit.format ||
          job.engine_version !== commit.engineVersion ||
          job.input_ids_json !== JSON.stringify(sourceIds(commit)) ||
          (JSON.parse(job.summary_json) as { outputId?: string }).outputId !== resourceId) continue
        db.completeImport(commit.ownerKey, resourceId, {
          status: 'ready', row_count: commit.rowCount, column_count: exportColumnCount(db, commit),
          storage_relpath: commit.relpath, content_hash: `sha256:${commit.sha256}`, byte_size: commit.bytes,
          metadata_json: JSON.stringify({ ...(JSON.parse(row.metadata_json) as Record<string, unknown>), originalName: commit.name, commitVersion: 1 }),
        }, job.id, commit.rowCount, sourceIds(commit).reduce((sum, id) => sum + (db.getResource(commit.ownerKey, id)?.row_count ?? 0), 0))
        checked.add(resourceId)
        exportsRestored += 1
      }
    }
  }
  for (const id of db.committedReadyResourceIds()) {
    if (!checked.has(id)) throw new Error(`已登记资源 ${id} 缺少有效的提交凭据`)
  }
  const interrupted = db.interruptUnfinished()
  let partialsRemoved = 0
  let orphanDirectoriesRemoved = 0
  let tusExpired = 0
  for (const workspaceId of await directories(ownersDir)) {
    if (!/^[0-9a-f]{24}$/.test(workspaceId)) continue
    const ownerDir = join(ownersDir, workspaceId)
    const uploadsDir = join(ownerDir, 'uploads')
    try {
      for (const entry of await readdir(uploadsDir, { withFileTypes: true })) {
        if (entry.isFile() && /^[0-9a-f-]{36}\.partial$/.test(entry.name)) {
          await rm(join(uploadsDir, entry.name))
          partialsRemoved += 1
        }
      }
      await syncDirectory(uploadsDir)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const tusDir = join(uploadsDir, 'tus')
    let tusEntries: string[] = []
    try { tusEntries = await readdir(tusDir) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const tusIds = new Set(tusEntries.filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).map((name) => name.slice(0, -5)))
    for (const id of tusIds) {
      const metadataPath = join(tusDir, `${id}.json`)
      const dataPath = join(tusDir, id)
      const metadataInfo = await lstat(metadataPath)
      let dataInfo: Awaited<ReturnType<typeof lstat>> | null = null
      try { dataInfo = await lstat(dataPath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      let valid = metadataInfo.isFile() && !metadataInfo.isSymbolicLink() && dataInfo?.isFile() && !dataInfo.isSymbolicLink()
      if (valid) {
        try { valid = validTusRecord(JSON.parse(await readFile(metadataPath, 'utf8')) as unknown, id, workspaceId) }
        catch { valid = false }
      }
      if (!valid || !dataInfo || Math.max(metadataInfo.mtimeMs, dataInfo.mtimeMs) < Date.now() - TUS_STALE_MS) {
        await rm(metadataPath, { force: true })
        await rm(dataPath, { force: true })
        tusExpired += 1
      }
    }
    for (const id of tusEntries) {
      if (!/^[0-9a-f]{32}$/.test(id) || tusIds.has(id)) continue
      const path = join(tusDir, id)
      if ((await stat(path)).mtimeMs < Date.now() - TUS_STALE_MS) {
        await rm(path, { force: true })
        tusExpired += 1
      }
    }
    if (tusExpired > 0) await syncDirectory(tusDir)
    const previewsDir = join(ownerDir, 'previews')
    let abandonedTrials = 0
    for (const name of await directories(previewsDir)) {
      if (!/^recipe-trial-[A-Za-z0-9_-]{6,}$/u.test(name)) continue
      await rm(join(previewsDir, name), { recursive: true, force: true })
      orphanDirectoriesRemoved += 1
      abandonedTrials += 1
    }
    if (abandonedTrials) await syncDirectory(previewsDir)
    const resourcesDir = join(ownerDir, 'resources')
    let ownerOrphansRemoved = 0
    for (const resourceId of await directories(resourcesDir)) {
      if (!/^res_[0-9a-f-]{36}$/.test(resourceId)) continue
      const resourceDir = join(resourcesDir, resourceId)
      const row = db.db.prepare('SELECT status FROM resources WHERE id=?').get(resourceId) as { status: string } | undefined
      if (!row || row.status === 'failed') {
        await rm(resourceDir, { recursive: true, force: true })
        orphanDirectoriesRemoved += 1
        ownerOrphansRemoved += 1
      }
    }
    if (ownerOrphansRemoved > 0) await syncDirectory(resourcesDir)
  }
  return { rawRestored, importsRestored, exportsRestored, interrupted, partialsRemoved, orphanDirectoriesRemoved, tusExpired }
}
