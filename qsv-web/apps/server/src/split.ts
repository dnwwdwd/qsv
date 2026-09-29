import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'
import * as yazl from 'yazl'
import { digestFile } from './files.ts'

export type SplitConfig = ({ mode: 'rows'; size: number } | { mode: 'value'; columnId: string }) & { includeHeader?: boolean }
export interface SplitFile { name: string; value: string | null; rows: number; bytes: number; sha256: string }
export interface SplitManifest { version: 1; mode: SplitConfig['mode']; includeHeader: boolean; sourceRows: number; files: SplitFile[] }
export class SplitError extends Error {}

/** 只统计字段值对应的文件数量，不生成文件；与正式拆分使用相同的 1000 份和键大小限制。 */
export async function countSplitFiles(inputPath: string, columnIndex: number, expectedRows: number, signal?: AbortSignal) {
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  const source = createReadStream(inputPath, { signal })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const values = new Set<string>()
  let width = 0, rows = 0, keyBytes = 0
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new SplitError('拆分预检已取消或超时')
      if (!width) {
        width = row.length
        if (width < 1 || width > 4096 || columnIndex < 0 || columnIndex >= width) throw new SplitError('拆分字段不存在')
        continue
      }
      if (row.length !== width) throw new SplitError(`第 ${rows + 1} 行列数与表头不一致`)
      const value = row[columnIndex]!
      if (!values.has(value)) {
        if (values.size >= 1000) throw new SplitError('拆分文件数量超过 1000 份上限')
        keyBytes += Buffer.byteLength(value, 'utf8')
        if (keyBytes > 4 * 1024 * 1024) throw new SplitError('分组字段值总大小超过 4 MiB 上限')
        values.add(value)
      }
      rows += 1
    }
    if (!width || rows !== expectedRows) throw new SplitError('输入数据行数与资源记录不一致')
    return { fileCount: Math.max(1, values.size), sourceRows: rows }
  } finally { source.destroy(); parser.destroy() }
}

function csvField(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function line(values: string[]) { return `${values.map(csvField).join(',')}\n` }

interface ActiveFile { stream: WriteStream; path: string }

/** 完整记录拆分；每个分块自带表头，列值模式的文件名只使用内容 hash。 */
export async function writeSplitFiles(inputPath: string, directory: string, config: SplitConfig, expectedRows: number, signal?: AbortSignal) {
  await mkdir(directory, { mode: 0o700 })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  const source = createReadStream(inputPath, { signal })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const active = new Map<string, ActiveFile>()
  const files = new Map<string, { name: string; value: string | null; rows: number }>()
  let headers: string[] | null = null
  let rowCount = 0
  let keyBytes = 0

  const closeOldest = async () => {
    const first = active.entries().next().value as [string, ActiveFile] | undefined
    if (!first) return
    active.delete(first[0])
    first[1].stream.end()
    await finished(first[1].stream)
  }
  const write = async (stream: WriteStream, value: string) => {
    if (!stream.write(value)) await once(stream, 'drain')
  }
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new SplitError('拆分已取消')
      if (!headers) {
        headers = row
        if (headers.length < 1 || headers.length > 4096) throw new SplitError('输入表头字段数无效')
        continue
      }
      if (row.length !== headers.length) throw new SplitError(`第 ${rowCount + 1} 行列数与表头不一致`)
      const value = config.mode === 'value' ? row[Number(config.columnId.slice(2))] : null
      if (config.mode === 'value' && value === undefined) throw new SplitError('拆分字段不存在')
      const name = config.mode === 'rows'
        ? `chunk_${String(Math.floor(rowCount / config.size)).padStart(5, '0')}.csv`
        : `part_${createHash('sha256').update(value ?? '').digest('hex')}.csv`
      let file = files.get(name)
      if (!file) {
        if (files.size >= 1000) throw new SplitError('分块数量超过 1000 份上限，请扩大每份行数或缩小字段值范围')
        keyBytes += Buffer.byteLength(value ?? '', 'utf8')
        if (keyBytes > 4 * 1024 * 1024) throw new SplitError('分组字段值总大小超过 4 MiB 上限')
        file = { name, value: value ?? null, rows: 0 }
        files.set(name, file)
      } else if (file.value !== (value ?? null)) throw new SplitError('分组值摘要冲突，拆分已停止')
      let opened = active.get(name)
      if (!opened) {
        if (active.size >= 16) await closeOldest()
        const path = join(directory, name)
        const isNew = file.rows === 0
        const stream = createWriteStream(path, { flags: isNew ? 'wx' : 'a', mode: 0o600 })
        opened = { path, stream }
        active.set(name, opened)
        if (isNew && config.includeHeader !== false) await write(stream, line(headers))
      } else {
        active.delete(name)
        active.set(name, opened)
      }
      await write(opened.stream, line(row))
      file.rows += 1
      rowCount += 1
    }
    if (!headers) throw new SplitError('数据集缺少表头')
    if (rowCount !== expectedRows) throw new SplitError('拆分行数与输入资源记录数不一致')
    if (rowCount === 0) {
      const name = 'chunk_00000.csv'
      const stream = createWriteStream(join(directory, name), { flags: 'wx', mode: 0o600 })
      if (config.includeHeader !== false) await write(stream, line(headers))
      stream.end()
      await finished(stream)
      files.set(name, { name, value: null, rows: 0 })
    }
    while (active.size) await closeOldest()
    const output: SplitFile[] = []
    for (const item of files.values()) {
      const digest = await digestFile(join(directory, item.name), signal)
      output.push({ name: item.name, value: item.value, rows: item.rows, bytes: digest.bytes, sha256: digest.sha256 })
    }
    return { version: 1 as const, mode: config.mode, includeHeader: config.includeHeader !== false, sourceRows: rowCount, files: output }
  } finally {
    source.destroy()
    parser.destroy()
    for (const { stream } of active.values()) stream.destroy()
  }
}

export async function writeSplitZip(directory: string, manifest: SplitManifest, outputPath: string, signal?: AbortSignal) {
  const zip = new yazl.ZipFile()
  const mtime = new Date('1980-01-01T00:00:00Z')
  for (const entry of manifest.files) zip.addFile(join(directory, entry.name), entry.name, { mtime, mode: 0o100600 })
  zip.addFile(join(directory, '..', 'manifest.json'), 'manifest.json', { mtime, mode: 0o100600 })
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
  const archive = await stat(outputPath)
  if (archive.size < 1) throw new SplitError('拆分压缩包为空')
}
