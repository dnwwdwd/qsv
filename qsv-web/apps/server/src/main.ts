import { createApp } from './app.ts'
import { probeEngine } from './engine.ts'
import { WebDatabase } from './database.ts'
import { WorkbenchService } from './service.ts'
import { recoverStartup } from './recovery.ts'
import { acquireInstanceLock, preparePrivateDataDir } from './instance-lock.ts'
import { OidcAuth } from './oidc-auth.ts'
import { readFile } from 'node:fs/promises'

const expectedSha256 = process.env.QSV_SHA256 ?? (process.env.QSV_SHA256_FILE ?
  (await readFile(process.env.QSV_SHA256_FILE, 'utf8')).trim() : undefined)
const probe = await probeEngine(process.env.QSV_BIN, expectedSha256)
const authMode = process.env.AUTH_MODE === 'lazycat' ? 'lazycat' : 'local'
const dataDir = process.env.QSV_DATA_DIR ?? '/tmp/qsv-web-dev-data'
const port = Number(process.env.PORT ?? 5274)
const oidc = authMode === 'lazycat' ? await OidcAuth.create(process.env) : undefined
if (authMode === 'lazycat' && !process.env.QSV_WEB_DIST) throw new Error('懒猫模式缺少前端静态文件目录')
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须是 1–65535 之间的整数')
}
await preparePrivateDataDir(dataDir)
const releaseLock = await acquireInstanceLock(dataDir)
let database: WebDatabase | undefined
try {
  database = new WebDatabase(dataDir)
  const recovered = await recoverStartup(database, dataDir)
  process.stdout.write(`恢复检查：原文件 ${recovered.rawRestored}，数据集 ${recovered.importsRestored}，导出 ${recovered.exportsRestored}，中断任务 ${recovered.interrupted}，清理临时文件 ${recovered.partialsRemoved}、孤儿目录 ${recovered.orphanDirectoriesRemoved}、过期续传 ${recovered.tusExpired}\n`)
} catch (error) {
  try { database?.close() } finally { await releaseLock() }
  throw error
}
if (!database) throw new Error('数据库初始化失败')
const service = new WorkbenchService(database, dataDir, process.env.QSV_BIN ?? '', probe.version ?? 'unavailable')
const app = createApp(probe, { service, authMode, oidc, webDist: process.env.QSV_WEB_DIST })

try {
  const host = authMode === 'lazycat' ? '0.0.0.0' : '127.0.0.1'
  await app.listen({ host, port })
  process.stdout.write(`qsv Web API: http://${host}:${port}\n`)
} catch (error) {
  process.stderr.write(`qsv Web API 启动失败：${error instanceof Error ? error.message : '未知错误'}\n`)
  database.close()
  await releaseLock()
  throw error
}

let retentionTask: Promise<void> | null = null
const runRetention = () => {
  if (retentionTask) return
  const task: Promise<void> = service.purgeExpiredTrashedResources().then((result) => {
    if (result.purged || result.failed || result.remainingMayExist) {
      process.stdout.write(`回收站过期清理：已清理 ${result.purged} 项，失败 ${result.failed} 项${result.remainingMayExist ? '；其余将在下次继续' : ''}\n`)
    }
  }).catch((error: unknown) => {
    process.stderr.write(`回收站过期清理失败：${error instanceof Error ? error.message : '未知错误'}\n`)
  }).finally(() => { if (retentionTask === task) retentionTask = null })
  retentionTask = task
}
const retentionTimer = setInterval(runRetention, 6 * 60 * 60 * 1000)
retentionTimer.unref()
runRetention()

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    if (stopping) return
    stopping = true
    let code = 0
    clearInterval(retentionTimer)
    if (retentionTask) await retentionTask
    try { await service.shutdown() }
    catch (error) { code = 1; process.stderr.write(`停止任务失败：${error instanceof Error ? error.message : '未知错误'}\n`) }
    try { await app.close() }
    catch { code = 1 }
    try { database.close() } catch { code = 1 }
    try { await releaseLock() } catch { code = 1 }
    process.exit(code)
  })
}
