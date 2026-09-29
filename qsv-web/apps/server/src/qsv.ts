import { spawn } from 'node:child_process'

const DEFAULT_MAX_OUTPUT = 256 * 1024

export class QsvCommandError extends Error {}
export class QsvOutputLimitError extends QsvCommandError {}

/** 参数只由已校验的服务端操作构造，调用方不得传入任意客户端 argv。 */
export async function runQsv(binary: string, args: string[], signal?: AbortSignal, maxOutput = DEFAULT_MAX_OUTPUT, timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let settled = false
    let terminating = false
    let oversized = false
    let timedOut = false
    let outputBytes = 0
    let killTimer: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    const onAbort = () => {
      if (terminating) return
      terminating = true
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* 进程已退出 */ }
        killTimer = setTimeout(() => {
          try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* 进程已退出 */ }
        }, 5000)
      }
    }
    const append = (chunk: Buffer, keep: boolean) => {
      if (oversized) return
      outputBytes += chunk.length
      if (outputBytes > maxOutput) {
        oversized = true
        onAbort()
        return
      }
      if (keep) stdout.push(chunk)
    }
    if (timeoutMs > 0) deadline = setTimeout(() => { timedOut = true; onAbort() }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer) => { append(chunk, true) })
    child.stderr.on('data', (chunk: Buffer) => { append(chunk, false) })
    child.once('error', () => {
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      if (deadline) clearTimeout(deadline)
      reject(new QsvCommandError('qsv 进程无法启动'))
    })
    child.once('close', (code) => {
      if (settled) return
      signal?.removeEventListener('abort', onAbort)
      if (killTimer) clearTimeout(killTimer)
      if (deadline) clearTimeout(deadline)
      if (signal?.aborted) return reject(new QsvCommandError('任务已取消'))
      if (timedOut) return reject(new QsvCommandError('qsv 执行超时'))
      if (oversized) return reject(new QsvOutputLimitError('qsv 输出超过限制'))
      if (code !== 0) return reject(new QsvCommandError('qsv 命令执行失败'))
      resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}
