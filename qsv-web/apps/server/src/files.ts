import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import { ensureDurableDirectory, syncDirectory, syncFile } from './commit.ts'

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_WORKBOOK_BYTES = 256 * 1024 * 1024

export class UploadLimitError extends Error {}
export class UploadValidationError extends Error {}

export type UploadFormat = 'csv' | 'tsv' | 'xlsx' | 'xls' | 'xlsm' | 'xlsb' | 'ods' | 'json' | 'jsonl' | 'ndjson' | 'parquet'

export function uploadFormat(name: string): UploadFormat {
  const extension = name.toLowerCase().split('.').at(-1)
  if (!['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'json', 'jsonl', 'ndjson', 'parquet'].includes(String(extension))) {
    throw new UploadValidationError('目前仅支持 CSV、TSV、Excel、ODS、JSON、JSONL 和 Parquet 文件导入')
  }
  return extension as UploadFormat
}

export function uploadSizeLimit(name: string) {
  return ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(uploadFormat(name)) ? MAX_WORKBOOK_BYTES : MAX_UPLOAD_BYTES
}

export function validateUploadName(name: string) {
  if (!name || name.length > 255 || /[\x00-\x1f/\\]/.test(name)) throw new UploadValidationError('文件名无效')
  uploadFormat(name)
}

export function resourceRelpath(workspaceId: string, id: string, file: `original.${UploadFormat}` | 'data.csv' | 'export.csv' | 'export.tsv' | 'export.xlsx' | 'export.ods' | 'export.json' | 'export.jsonl' | 'export.parquet' | 'export.zip') {
  if (!/^[0-9a-f]{24}$/.test(workspaceId) || !/^res_[0-9a-f-]{36}$/.test(id)) throw new Error('资源路径参数无效')
  return join('owners', workspaceId, 'resources', id, file)
}

export async function checkedResourcePath(dataDir: string, workspaceId: string, relpath: string) {
  const base = await realpath(join(dataDir, 'owners', workspaceId))
  const target = await realpath(join(dataDir, relpath))
  if (!target.startsWith(base + sep)) throw new Error('资源路径超出用户目录')
  return target
}

export async function receiveUpload(stream: Readable, dataDir: string, workspaceId: string, name: string) {
  validateUploadName(name)

  const ownerDir = join(dataDir, 'owners', workspaceId)
  const tempDir = join(ownerDir, 'uploads')
  await ensureDurableDirectory(dataDir, join('owners', workspaceId, 'uploads'))
  const tempPath = join(tempDir, `${randomUUID()}.partial`)
  const id = `res_${randomUUID()}`
  const relpath = resourceRelpath(workspaceId, id, `original.${uploadFormat(name)}`)
  const finalPath = join(dataDir, relpath)
  const hash = createHash('sha256')
  const maxBytes = uploadSizeLimit(name)
  let bytes = 0
  let renamed = false
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) return callback(new UploadLimitError(`文件超过 ${maxBytes === MAX_WORKBOOK_BYTES ? '256 MiB' : '5 GiB'} 上限`))
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(stream, meter, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }))
    await syncFile(tempPath)
    await ensureDurableDirectory(dataDir, dirname(relpath))
    await rename(tempPath, finalPath)
    renamed = true
    await syncDirectory(dirname(finalPath))
    return { id, relpath, bytes, sha256: hash.digest('hex'), path: finalPath }
  } catch (error) {
    await rm(tempPath, { force: true })
    if (renamed) await rm(dirname(finalPath), { recursive: true, force: true })
    throw error
  }
}

export async function digestFile(path: string, signal?: AbortSignal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw new Error('文件摘要已中断')
    hash.update(chunk)
  }
  if (signal?.aborted) throw new Error('文件摘要已中断')
  const info = await stat(path)
  return { sha256: hash.digest('hex'), bytes: info.size }
}
