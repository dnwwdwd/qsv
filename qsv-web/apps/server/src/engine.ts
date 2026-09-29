import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const VERSION = '23.0.1'
const MAX_OUTPUT = 64 * 1024
const TIMEOUT_MS = 15_000
const REQUIRED_COMMANDS = ['count', 'index', 'slice'] as const

class ProbeError extends Error {}

export interface EngineProbe {
  version: string | null
  sha256: string | null
  platform: string
  verified: boolean
  reason: string | null
  operations: Record<'table.count' | 'table.preview.indexed', boolean>
}

async function run(binary: string, args: string[]) {
  return runFile(binary, args, {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    encoding: 'utf8',
    env: { ...process.env, QSV_AUTOINDEX_SIZE: '0' },
  })
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** 只在服务启动时运行固定 fixture；不接收客户端命令或文件路径。 */
export async function probeEngine(binary: string | undefined, expectedSha256: string | undefined): Promise<EngineProbe> {
  const result: EngineProbe = {
    version: null,
    sha256: null,
    platform: `${process.platform}-${process.arch}`,
    verified: false,
    reason: null,
    operations: { 'table.count': false, 'table.preview.indexed': false },
  }
  if (!binary) {
    result.reason = '未配置 QSV_BIN，数据处理能力不可用'
    return result
  }
  if (!expectedSha256 || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    result.reason = '未配置有效的 QSV_SHA256，无法验证固定二进制'
    return result
  }

  try {
    result.sha256 = await fileSha256(binary)
    if (result.sha256 !== expectedSha256.toLowerCase()) {
      result.reason = 'qsv 二进制 SHA-256 与配置不一致'
      return result
    }

    const version = (await run(binary, ['--version'])).stdout.trim()
    result.version = version
    if (!version.startsWith(`qsv ${VERSION}-`)) {
      result.reason = `要求 qsv ${VERSION}，实际版本不匹配`
      return result
    }

    const list = (await run(binary, ['--list'])).stdout
    for (const command of REQUIRED_COMMANDS) {
      if (!new RegExp(`^\\s+${command}\\s`, 'm').test(list)) {
        result.reason = `固定二进制缺少 ${command} 命令`
        return result
      }
    }

    const directory = await mkdtemp(join(tmpdir(), 'qsv-web-probe-'))
    try {
      const csv = join(directory, 'fidelity.csv')
      await writeFile(csv, '编号,金额,日期,备注\n000123,0.01,2026-09-26,中文\n12345678901234567890,1.20,2026年9月26日,"含,逗号"\n')
      await run(binary, ['index', csv])
      const count = (await run(binary, ['count', csv])).stdout.trim()
      if (count !== '2') throw new ProbeError('count 结果与固定样本不符')
      result.operations['table.count'] = true

      const slice = (await run(binary, ['slice', '--start', '0', '--len', '2', '--json', csv])).stdout
      const rows = JSON.parse(slice) as Record<string, string>[]
      if (rows.length !== 2 || rows[0]?.['编号'] !== '000123' || rows[1]?.['编号'] !== '12345678901234567890' || rows[1]?.['备注'] !== '含,逗号') {
        throw new ProbeError('索引行块或文本保真检查失败')
      }
      result.operations['table.preview.indexed'] = true
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    result.verified = true
    return result
  } catch (error) {
    result.reason = error instanceof ProbeError ? error.message : 'qsv 命令无法运行或输出无法解析'
    result.operations['table.count'] = false
    result.operations['table.preview.indexed'] = false
    return result
  }
}
