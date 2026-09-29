import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { Transform } from 'node:stream'
import parserStream from 'stream-json'
import type { Token } from 'stream-json/parser.js'
import { projectStructuredRecord, readStructuredJson, StructuredJsonError, type StructureOptions } from './json-structure.ts'

const MAX_CELL_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_COLUMNS = 4096

export class JsonImportError extends Error {}
export interface JsonImportOptions extends StructureOptions { nulls: 'reject' | 'empty'; missing: 'reject' | 'empty'; newFields?: 'reject' | 'ignore' | 'include'; projection?: string[]; dataPath?: string; typeConflict?: 'text' | 'reject';
  invalidRecords?: 'reject' | 'isolate' }
export const DEFAULT_JSON_OPTIONS: JsonImportOptions = { nulls: 'reject', missing: 'reject', newFields: 'reject' }

export function jsonImportOptions(value: unknown): JsonImportOptions {
  if (value === undefined) return { ...DEFAULT_JSON_OPTIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JsonImportError('JSON 导入配置无效')
  const options = value as Record<string, unknown>
  if (Object.keys(options).some((key) => !['nulls', 'missing', 'newFields', 'projection', 'nested', 'arrays', 'explodePath', 'dataPath', 'typeConflict', 'invalidRecords'].includes(key)) ||
    !['reject', 'empty'].includes(String(options.nulls)) || !['reject', 'empty'].includes(String(options.missing)) ||
    (options.newFields !== undefined && !['reject', 'ignore', 'include'].includes(String(options.newFields))) ||
    (options.typeConflict !== undefined && !['text', 'reject'].includes(String(options.typeConflict))) ||
    (options.invalidRecords !== undefined && !['reject', 'isolate'].includes(String(options.invalidRecords))) ||
    (options.nested !== undefined && !['reject', 'flatten', 'stringify'].includes(String(options.nested))) ||
    (options.arrays !== undefined && !['reject', 'stringify', 'explode'].includes(String(options.arrays))) ||
    ((options.arrays === 'explode') !== (typeof options.explodePath === 'string' && options.explodePath.length > 1)) ||
    (typeof options.explodePath === 'string' && (options.explodePath.length > 1024 || !options.explodePath.startsWith('/'))) ||
    (options.dataPath !== undefined && (typeof options.dataPath !== 'string' || options.dataPath.length < 2 || options.dataPath.length > 1024 || !options.dataPath.startsWith('/'))) ||
    (options.projection !== undefined && (!Array.isArray(options.projection) || options.projection.length < 1 || options.projection.length > MAX_COLUMNS ||
      options.projection.some((field: unknown) => typeof field !== 'string' || field.length < 1 || Buffer.byteLength(field, 'utf8') > MAX_CELL_BYTES) ||
      new Set(options.projection).size !== options.projection.length))) {
    throw new JsonImportError('JSON 导入配置无效')
  }
  return { nulls: options.nulls as JsonImportOptions['nulls'], missing: options.missing as JsonImportOptions['missing'],
    newFields: (options.newFields ?? 'reject') as JsonImportOptions['newFields'], projection: options.projection as string[] | undefined,
    nested: (options.nested ?? 'reject') as JsonImportOptions['nested'], arrays: (options.arrays ?? 'reject') as JsonImportOptions['arrays'],
    explodePath: options.explodePath as string | undefined, dataPath: options.dataPath as string | undefined,
    typeConflict: (options.typeConflict ?? 'text') as JsonImportOptions['typeConflict'],
    invalidRecords: (options.invalidRecords ?? 'reject') as JsonImportOptions['invalidRecords'] }
}

function csvField(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function line(values: string[]) { return `${values.map(csvField).join(',')}\n` }

type SelectedRecord = { sourceRecord: number; record: Map<string, string | null>; error?: never } |
  { sourceRecord: number; record?: never; error: string }
async function* selectedRecords(path: string, format: 'json' | 'jsonl', options: JsonImportOptions, signal?: AbortSignal): AsyncGenerator<SelectedRecord> {
  if (!options.dataPath && (options.nested ?? 'reject') === 'reject' && (options.arrays ?? 'reject') === 'reject' && (options.typeConflict ?? 'text') === 'text') {
    let sourceRecord = 0
    for await (const record of readRecords(path, format, signal)) yield { sourceRecord: ++sourceRecord, record }
    return
  }
  try {
    const expectedKinds = new Map<string, string>()
    let sourceRecord = 0
    for await (const root of readStructuredJson(path, format, signal, options.dataPath)) {
      sourceRecord += 1
      let projected: ReturnType<typeof projectStructuredRecord>
      try { projected = projectStructuredRecord(root, options) }
      catch (error) {
        if (options.invalidRecords === 'isolate' && error instanceof StructuredJsonError) {
          yield { sourceRecord, error: error.message }; continue
        }
        throw error
      }
      for (const record of projected) {
        let conflict: string | null = null
        if (options.typeConflict === 'reject') for (const [key, kind] of record.kinds) {
          if (kind === 'null') continue
          const expected = expectedKinds.get(key)
          if (expected && expected !== kind) { conflict = `字段 ${key.slice(0, 80)} 类型从 ${expected} 变为 ${kind}`; break }
        }
        if (conflict) {
          if (options.invalidRecords === 'isolate') { yield { sourceRecord, error: conflict }; continue }
          throw new JsonImportError(`第 ${sourceRecord} 条源记录${conflict}`)
        }
        if (options.typeConflict === 'reject') for (const [key, kind] of record.kinds) {
          if (kind !== 'null') expectedKinds.set(key, kind)
          }
        yield { sourceRecord, record: record.cells }
      }
    }
  } catch (error) {
    if (error instanceof StructuredJsonError) throw new JsonImportError(error.message)
    throw error
  }
}

/** 流式读取顶层对象数组或连续 JSON 对象；只接收表状的原始值。数字不经过 JS Number。 */
async function* readRecords(path: string, format: 'json' | 'jsonl', signal?: AbortSignal): AsyncGenerator<Map<string, string | null>> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const utf8 = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { callback(null, decoder.decode(chunk, { stream: true })) }
    catch { callback(new JsonImportError('JSON 文件包含无效的 UTF-8 字节')) }
  }, flush(callback) {
    try { callback(null, decoder.decode()) }
    catch { callback(new JsonImportError('JSON 文件尾部包含无效的 UTF-8 字节')) }
  } })
  const source = createReadStream(path, { signal })
  const parser = parserStream({ jsonStreaming: format === 'jsonl', packValues: false, streamValues: true })
  source.on('error', (error) => parser.destroy(error))
  utf8.on('error', (error) => parser.destroy(error))
  source.pipe(utf8).pipe(parser)
  let inRootArray = false
  let rootClosed = false
  let current: Map<string, string | null> | null = null
  let key: string | null = null
  let tokenKind: 'key' | 'string' | 'number' | null = null
  let buffer = ''
  let bufferBytes = 0
  let recordBytes = 0
  let recordNumber = 0
  const append = (value: string) => {
    buffer += value
    bufferBytes += Buffer.byteLength(value, 'utf8')
    if (bufferBytes > MAX_CELL_BYTES) throw new JsonImportError(`第 ${recordNumber + 1} 条记录的字段或字段名超过 1 MiB`)
  }
  const finishValue = (value: string | null) => {
    if (!current || key === null) throw new JsonImportError(`第 ${recordNumber + 1} 条记录结构无效`)
    if (current.has(key)) throw new JsonImportError(`第 ${recordNumber + 1} 条记录有重复字段：${key.slice(0, 80)}`)
    current.set(key, value)
    recordBytes += Buffer.byteLength(key, 'utf8') + (value === null ? 0 : Buffer.byteLength(value, 'utf8')) + 2
    if (recordBytes > MAX_RECORD_BYTES || current.size > MAX_COLUMNS) throw new JsonImportError(`第 ${recordNumber + 1} 条记录超过 8 MiB 或 4096 列限制`)
    key = null
  }
  try {
    for await (const raw of parser) {
      if (signal?.aborted) throw new JsonImportError('JSON 导入已取消')
      const token = raw as Token
      switch (token.name) {
        case 'startArray':
          if (format === 'json' && !inRootArray && !rootClosed && !current) { inRootArray = true; break }
          throw new JsonImportError('嵌套数组需要先选择展开或字符串化策略')
        case 'endArray':
          if (format !== 'json' || !inRootArray || current) throw new JsonImportError('JSON 顶层数组结构无效')
          inRootArray = false
          rootClosed = true
          break
        case 'startObject':
          if (current || (format === 'json' && !inRootArray) || rootClosed) throw new JsonImportError('仅支持顶层对象数组或每行一个对象；嵌套对象需要先展开')
          current = new Map()
          recordBytes = 0
          key = null
          break
        case 'endObject':
          if (!current || key !== null || tokenKind) throw new JsonImportError(`第 ${recordNumber + 1} 条记录结构无效`)
          recordNumber += 1
          yield current
          current = null
          break
        case 'startKey':
          if (!current || key !== null || tokenKind) throw new JsonImportError(`第 ${recordNumber + 1} 条记录字段无效`)
          tokenKind = 'key'; buffer = ''; bufferBytes = 0
          break
        case 'endKey':
          if (tokenKind !== 'key') throw new JsonImportError('JSON 字段名称无效')
          key = buffer
          tokenKind = null
          break
        case 'startString':
          if (!current || key === null || tokenKind) throw new JsonImportError('JSON 文本位置无效')
          tokenKind = 'string'; buffer = ''; bufferBytes = 0
          break
        case 'endString':
          if (tokenKind !== 'string') throw new JsonImportError('JSON 文本结构无效')
          finishValue(buffer)
          tokenKind = null
          break
        case 'startNumber':
          if (!current || key === null || tokenKind) throw new JsonImportError('JSON 数值位置无效')
          tokenKind = 'number'; buffer = ''; bufferBytes = 0
          break
        case 'endNumber':
          if (tokenKind !== 'number') throw new JsonImportError('JSON 数值结构无效')
          finishValue(buffer)
          tokenKind = null
          break
        case 'stringChunk':
          if (tokenKind !== 'key' && tokenKind !== 'string') throw new JsonImportError('JSON 文本片段无效')
          append(token.value)
          break
        case 'numberChunk':
          if (tokenKind !== 'number') throw new JsonImportError('JSON 数值片段无效')
          append(token.value)
          break
        case 'nullValue':
          finishValue(null)
          break
        case 'trueValue':
          finishValue('true')
          break
        case 'falseValue':
          finishValue('false')
          break
        case 'keyValue':
        case 'stringValue':
        case 'numberValue':
        case 'whitespace':
          // 已处理流式片段；关闭 packValues 后不会生成对应的完整值。
          break
      }
    }
    if (format === 'json' && !rootClosed) throw new JsonImportError('JSON 文件需要包含完整的顶层对象数组')
    if (current || tokenKind) throw new JsonImportError('JSON 文件末尾记录不完整')
  } catch (error) {
    if (error instanceof JsonImportError) throw error
    if (signal?.aborted) throw new JsonImportError('JSON 导入已取消')
    throw new JsonImportError(`JSON 格式无效，靠近第 ${recordNumber + 1} 条记录`)
  } finally {
    source.destroy()
    utf8.destroy()
    parser.destroy()
  }
}

type JsonConversion = { field: string; reason: string }
function cells(record: Map<string, string | null>, headers: string[], options: JsonImportOptions, rowNumber: number,
  conversions?: JsonConversion[]) {
  const allowed = new Set(headers)
  if (!options.projection && options.newFields !== 'ignore') {
    for (const key of record.keys()) if (!allowed.has(key)) throw new JsonImportError(`第 ${rowNumber} 条记录出现新字段：${key.slice(0, 80)}；当前采用首条记录的字段结构`)
  } else if (!options.projection && options.newFields === 'ignore') {
    for (const key of record.keys()) if (!allowed.has(key)) conversions?.push({ field: key, reason: '新字段已按配置忽略' })
  }
  return headers.map((header) => {
    if (!record.has(header)) {
      if (options.missing === 'reject') throw new JsonImportError(`第 ${rowNumber} 条记录缺少字段：${header.slice(0, 80)}`)
      conversions?.push({ field: header, reason: '缺字段已补为空文本' })
      return ''
    }
    const value = record.get(header)
    if (value === null) {
      if (options.nulls === 'reject') throw new JsonImportError(`第 ${rowNumber} 条记录的 ${header.slice(0, 80)} 是 null`)
      conversions?.push({ field: header, reason: '显式 null 已转为空文本' })
      return ''
    }
    return value ?? ''
  })
}

export async function normalizeJsonToFile(inputPath: string, outputPath: string, format: 'json' | 'jsonl', options: JsonImportOptions,
  signal?: AbortSignal, reportPath?: string, conversionReportPath?: string) {
  let headers: string[] | null = options.projection ? [...options.projection] : null
  if (!headers && options.newFields === 'include') {
    const discovered = new Set<string>()
    for await (const item of selectedRecords(inputPath, format, options, signal)) {
      if (!item.record) continue
      for (const key of item.record.keys()) {
        discovered.add(key)
        if (discovered.size > MAX_COLUMNS) throw new JsonImportError('JSON 文件字段超过 4096 列限制')
      }
    }
    headers = [...discovered]
    if (!headers.length) throw new JsonImportError('JSON 文件没有可导入的对象记录')
  }
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const reportRef: { current: ReturnType<typeof createWriteStream> | null } = { current: null }
  const conversionRef: { current: ReturnType<typeof createWriteStream> | null } = { current: null }
  let rowCount = 0, errorCount = 0, conversionCount = 0
  const writeError = async (sourceRecord: number, reason: string, record?: Map<string, string | null>) => {
    errorCount += 1
    if (!reportPath) return
    if (!reportRef.current) {
      const stream = createWriteStream(reportPath, { flags: 'wx', mode: 0o600 })
      stream.on('error', (error) => output.destroy(error))
      reportRef.current = stream
      if (!stream.write(line(['源记录号', '原因', '记录 JSON']))) await once(stream, 'drain')
    }
    const report = reportRef.current
    if (!report.write(line([String(sourceRecord), reason.slice(0, 512), record ? JSON.stringify(Object.fromEntries(record)) : '']))) await once(report, 'drain')
  }
  const writeConversions = async (sourceRecord: number, outputRow: number, conversions: JsonConversion[]) => {
    conversionCount += conversions.length
    if (!conversions.length || !conversionReportPath) return
    if (!conversionRef.current) {
      const stream = createWriteStream(conversionReportPath, { flags: 'wx', mode: 0o600 })
      stream.on('error', (error) => output.destroy(error))
      conversionRef.current = stream
      if (!stream.write(line(['源记录号', '输出行号', '字段', '转换说明']))) await once(stream, 'drain')
    }
    const report = conversionRef.current
    for (const conversion of conversions) {
      if (!report.write(line([String(sourceRecord), String(outputRow), conversion.field, conversion.reason]))) await once(report, 'drain')
    }
  }
  try {
    if (headers && !output.write(line(headers))) await once(output, 'drain')
    for await (const item of selectedRecords(inputPath, format, options, signal)) {
      if (!item.record) { await writeError(item.sourceRecord, item.error ?? '记录无效'); continue }
      const record = item.record
      if (!headers) {
        headers = [...record.keys()]
        if (headers.length < 1 || headers.length > MAX_COLUMNS) throw new JsonImportError('首条 JSON 记录缺少字段或超过 4096 列')
        if (!output.write(line(headers))) await once(output, 'drain')
      }
      let values: string[]
      const conversions: JsonConversion[] = []
      try { values = cells(record, headers, options, item.sourceRecord, conversions) }
      catch (error) {
        if (options.invalidRecords !== 'isolate' || !(error instanceof JsonImportError)) throw error
        await writeError(item.sourceRecord, error.message, record)
        continue
      }
      if (!output.write(line(values))) await once(output, 'drain')
      await writeConversions(item.sourceRecord, rowCount + 1, conversions)
      rowCount += 1
    }
    if (!headers) throw new JsonImportError('JSON 文件没有可导入的对象记录')
    output.end()
    await finished(output)
    const report = reportRef.current
    if (report) { report.end(); await finished(report) }
    const conversionReport = conversionRef.current
    if (conversionReport) { conversionReport.end(); await finished(conversionReport) }
    return { headers, rowCount, errorCount, conversionCount }
  } catch (error) {
    output.destroy()
    reportRef.current?.destroy()
    conversionRef.current?.destroy()
    throw error
  }
}

export async function previewJson(inputPath: string, format: 'json' | 'jsonl', options: JsonImportOptions) {
  let headers: string[] | null = options.projection ? [...options.projection] : null
  const records: SelectedRecord[] = []
  let validRecords = 0
  for await (const item of selectedRecords(inputPath, format, options)) {
    if (!headers && item.record) {
      headers = [...item.record.keys()]
      if (headers.length < 1 || headers.length > MAX_COLUMNS) throw new JsonImportError('首条 JSON 记录缺少字段或超过 4096 列')
    }
    records.push(item)
    if (item.record) validRecords += 1
    if (options.newFields === 'include' && !options.projection && item.record && headers) {
      for (const key of item.record.keys()) if (!headers.includes(key)) headers.push(key)
      if (headers.length > MAX_COLUMNS) throw new JsonImportError('JSON 样本字段超过 4096 列限制')
    }
    if (validRecords >= 20 || records.length >= 100) break
  }
  if (!headers) throw new JsonImportError('JSON 文件没有可预览的对象记录')
  const rows: string[][] = []
  const sampleErrors: { record: number; reason: string }[] = []
  const sampleConversions: { record: number; field: string; reason: string }[] = []
  for (const item of records) {
    if (!item.record) { if (sampleErrors.length < 10) sampleErrors.push({ record: item.sourceRecord, reason: item.error ?? '记录无效' }); continue }
    try {
      const conversions: JsonConversion[] = []
      rows.push(cells(item.record, headers, options, item.sourceRecord, conversions).slice(0, 30)
        .map((value) => value.length > 256 ? `${value.slice(0, 256)}…` : value))
      for (const conversion of conversions.slice(0, Math.max(0, 10 - sampleConversions.length))) {
        sampleConversions.push({ record: item.sourceRecord, ...conversion })
      }
    }
    catch (error) {
      if (options.invalidRecords !== 'isolate' || !(error instanceof JsonImportError)) throw error
      if (sampleErrors.length < 10) sampleErrors.push({ record: item.sourceRecord, reason: error.message })
    }
  }
  return { headers: headers.slice(0, 30).map((value) => value.length > 256 ? `${value.slice(0, 256)}…` : value), rows,
    sampleRows: rows.length, totalKnown: false as const, columnCount: headers.length, columnsTruncated: headers.length > 30,
    sampleErrors, sampleConversions }
}
