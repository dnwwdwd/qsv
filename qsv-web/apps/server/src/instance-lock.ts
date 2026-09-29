import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { syncDirectory } from './commit.ts'

export async function preparePrivateDataDir(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())) {
    throw new Error('数据目录必须是当前用户拥有的私有普通目录（权限 0700）')
  }
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** 单实例目录锁；旧进程已经消失时才迁走其锁目录。 */
export async function acquireInstanceLock(dataDir: string) {
  const path = join(dataDir, '.server-lock')
  const token = randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 })
      await syncDirectory(dataDir)
      const handle = await open(join(path, 'owner.json'), 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
        await handle.sync()
      } finally { await handle.close() }
      await syncDirectory(path)
      return async () => {
        let owner: { token?: string }
        try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { token?: string } }
        catch { return }
        if (owner.token !== token) return
        await rm(path, { recursive: true, force: true })
        await syncDirectory(dataDir)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: { pid?: number } = {}
      try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid?: number } }
      catch { /* 启动进程可能尚未写入锁信息 */ }
      if (Number.isInteger(owner.pid) && owner.pid! > 0 && pidAlive(owner.pid!)) {
        throw new Error('同一数据目录已有服务实例在运行')
      }
      const info = await stat(path)
      if (Date.now() - info.mtimeMs < 10_000) throw new Error('另一个服务实例正在启动，请稍后重试')
      const stale = join(dataDir, `.server-lock.stale-${randomUUID()}`)
      try { await rename(path, stale) }
      catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw renameError
      }
      await rm(stale, { recursive: true, force: true })
      await syncDirectory(dataDir)
    }
  }
  throw new Error('无法取得数据目录独占锁')
}
