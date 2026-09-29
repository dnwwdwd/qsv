import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { Transform, Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'

const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_CELL_BYTES = 1024 * 1024
const MAX_COLUMNS = 4096

export class CsvValidationError extends Error {}

export interface CsvImportOptions {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
  delimiter: ',' | ';' | '\t' | '|'
  header: 'first-row' | 'none'
  quote: '"' | "'"
  headerRow: number
  dataStartRow: number
  dataEndRow: number | null
  skipEmptyLines: boolean
  invalidRows?: 'reject' | 'isolate'
  headerRowCount?: number
  headerJoin?: 'space' | 'slash' | 'underscore'
  headerFill?: boolean
}

export const DEFAULT_CSV_IMPORT_OPTIONS: CsvImportOptions = {
  encoding: 'utf-8', delimiter: ',', header: 'first-row', quote: '"',
  headerRow: 1, dataStartRow: 2, dataEndRow: null, skipEmptyLines: false,
}

export function csvImportOptions(value: unknown): CsvImportOptions {
  if (value === undefined) return { ...DEFAULT_CSV_IMPORT_OPTIONS }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CsvValidationError('CSV 解析配置无效')
  const options = value as Record<string, unknown>
  if (Object.keys(options).some((key) => !['encoding', 'delimiter', 'header', 'quote', 'headerRow', 'dataStartRow', 'dataEndRow', 'skipEmptyLines', 'invalidRows', 'headerRowCount', 'headerJoin', 'headerFill'].includes(key)) ||
    !['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(String(options.encoding)) ||
    ![',', ';', '\t', '|'].includes(String(options.delimiter)) ||
    !['first-row', 'none'].includes(String(options.header))) {
    throw new CsvValidationError('CSV 解析配置无效')
  }
  const header = options.header as CsvImportOptions['header']
  const quote = options.quote ?? '"'
  const headerRow = options.headerRow ?? 1
  const headerRowCount = options.headerRowCount ?? 1
  const dataStartRow = options.dataStartRow ?? (header === 'first-row' ? Number(headerRow) + Number(headerRowCount) : 1)
  const dataEndRow = options.dataEndRow ?? null
  const skipEmptyLines = options.skipEmptyLines ?? false
  if (!['"', "'"].includes(String(quote)) || !Number.isSafeInteger(headerRow) || Number(headerRow) < 1 || Number(headerRow) > 1_000_000 ||
    !Number.isSafeInteger(headerRowCount) || Number(headerRowCount) < 1 || Number(headerRowCount) > 5 ||
    (header === 'none' && Number(headerRowCount) !== 1) ||
    (Number(headerRowCount) > 1 && !['space', 'slash', 'underscore'].includes(String(options.headerJoin))) ||
    (options.headerJoin !== undefined && !['space', 'slash', 'underscore'].includes(String(options.headerJoin))) ||
    (options.headerFill !== undefined && typeof options.headerFill !== 'boolean') ||
    !Number.isSafeInteger(dataStartRow) || Number(dataStartRow) < (header === 'first-row' ? Number(headerRow) + Number(headerRowCount) : 1) || Number(dataStartRow) > 1_000_000_000 ||
    (dataEndRow !== null && (!Number.isSafeInteger(dataEndRow) || Number(dataEndRow) < Number(dataStartRow) || Number(dataEndRow) > 1_000_000_000)) ||
    typeof skipEmptyLines !== 'boolean' || (options.invalidRows !== undefined && !['reject', 'isolate'].includes(String(options.invalidRows)))) throw new CsvValidationError('CSV 表头、数据范围或空行配置无效')
  return { encoding: options.encoding as CsvImportOptions['encoding'], delimiter: options.delimiter as CsvImportOptions['delimiter'], header,
    quote: quote as CsvImportOptions['quote'], headerRow: Number(headerRow), dataStartRow: Number(dataStartRow), dataEndRow: dataEndRow === null ? null : Number(dataEndRow), skipEmptyLines,
    invalidRows: (options.invalidRows ?? 'reject') as CsvImportOptions['invalidRows'], headerRowCount: Number(headerRowCount),
    headerJoin: options.headerJoin as CsvImportOptions['headerJoin'], headerFill: options.headerFill === true }
}

export function isDefaultCsvOptions(options: CsvImportOptions) {
  return options.encoding === 'utf-8' && options.delimiter === ',' && options.header === 'first-row' && options.quote === '"' &&
    options.headerRow === 1 && (options.headerRowCount ?? 1) === 1 && options.dataStartRow === 2 && options.dataEndRow === null &&
    !options.skipEmptyLines && options.invalidRows !== 'isolate'
}

function flattenHeaders(records: string[][], options: CsvImportOptions) {
  const width = Math.max(...records.map((row) => row.length))
  if (width < 1 || width > MAX_COLUMNS) throw new CsvValidationError('合并表头的字段数量超出限制')
  const normalized = records.map((row) => {
    const result = Array.from({ length: width }, (_, index) => row[index] ?? '')
    if (options.headerFill) for (let index = 1; index < result.length; index += 1) {
      if (!result[index]) result[index] = result[index - 1]!
    }
    return result
  })
  const delimiter = options.headerJoin === 'slash' ? '/' : options.headerJoin === 'underscore' ? '_' : ' '
  return Array.from({ length: width }, (_, index) => {
    const parts = normalized.map((row) => row[index]!.trim()).filter(Boolean)
    const name = parts.filter((part, at) => at === 0 || part !== parts[at - 1]).join(delimiter)
    if (Buffer.byteLength(name, 'utf8') > MAX_CELL_BYTES) throw new CsvValidationError('合并后的表头字段超过 1 MiB 限制')
    return name
  })
}

class PreviewComplete extends Error {}

/** 只读取前 20 行数据；返回值不表示其余记录已经校验。 */
export async function previewCsv(path: string, options: CsvImportOptions, signal?: AbortSignal) {
  const decoder = new TextDecoder(options.encoding, { fatal: true })
  const utf8 = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { callback(null, decoder.decode(chunk, { stream: true })) }
      catch { callback(new CsvValidationError(`CSV 包含无效的 ${options.encoding} 字节`)) }
    },
    flush(callback) {
      try { callback(null, decoder.decode()) }
      catch { callback(new CsvValidationError(`CSV 尾部包含无效的 ${options.encoding} 字节`)) }
    },
  })
  const parser = parse({ bom: true, delimiter: options.delimiter, quote: options.quote, relax_quotes: false,
    relax_column_count: true, max_record_size: MAX_RECORD_BYTES, skip_empty_lines: false })
  let headers: string[] = []
  let hasHeader = false
  const headerRecords: string[][] = []
  let sourceRecord = 0
  const rows: string[][] = []
  const sampleErrors: { record: number; reason: string }[] = []
  const clip = (value: string) => value.length > 256 ? `${value.slice(0, 256)}…` : value
  const collect = new Writable({ objectMode: true, write(row: string[], _encoding, callback) {
    try {
      sourceRecord += 1
      if (sourceRecord > 100_000) throw new CsvValidationError('预览最多扫描前 10 万条记录，请提交完整导入任务')
      if (options.header === 'first-row' && !hasHeader && sourceRecord < options.headerRow) { callback(); return }
      if (options.header === 'first-row' && !hasHeader && sourceRecord < options.headerRow + (options.headerRowCount ?? 1)) {
        if (row.length < 1 || row.length > MAX_COLUMNS || row.some((cell) => Buffer.byteLength(cell, 'utf8') > MAX_CELL_BYTES)) {
          throw new CsvValidationError('CSV 表头字段数量或大小超出限制')
        }
        headerRecords.push(row)
        if (headerRecords.length === (options.headerRowCount ?? 1)) {
          headers = headerRecords.length === 1 ? row : flattenHeaders(headerRecords, options)
          hasHeader = true
        }
        callback()
        return
      }
      if (options.dataEndRow !== null && sourceRecord > options.dataEndRow) { callback(new PreviewComplete()); return }
      if (sourceRecord < options.dataStartRow || (options.skipEmptyLines && row.length === 1 && row[0] === '')) { callback(); return }
      if (rows.length >= 20) { callback(new PreviewComplete()); return }
      if (row.length < 1 || row.length > MAX_COLUMNS || row.some((cell) => Buffer.byteLength(cell, 'utf8') > MAX_CELL_BYTES)) {
        if (hasHeader && options.invalidRows === 'isolate') {
          if (sampleErrors.length < 10) sampleErrors.push({ record: sourceRecord, reason: '字段数或单元格大小超出限制' })
          callback(); return
        }
        throw new CsvValidationError('CSV 样本字段数或单元格大小超出限制')
      }
      if (!hasHeader) {
        headers = row.map((_cell, index) => `column_${index + 1}`)
        hasHeader = true
        rows.push(row.slice(0, 30).map(clip))
      } else {
        if (row.length !== headers.length) {
          if (options.invalidRows === 'isolate') {
            if (sampleErrors.length < 10) sampleErrors.push({ record: sourceRecord, reason: `字段数 ${row.length}，预期 ${headers.length}` })
            callback(); return
          }
          throw new CsvValidationError('CSV 样本字段数与表头不一致')
        }
        rows.push(row.slice(0, 30).map(clip))
      }
      callback()
    } catch (error) { callback(error as Error) }
  } })
  try { await pipeline(createReadStream(path), utf8, parser, collect, { signal }) }
  catch (error) {
    if (!(error instanceof PreviewComplete)) {
      if (error instanceof CsvValidationError) throw error
      if (signal?.aborted) throw new CsvValidationError('CSV 预览已取消')
      throw new CsvValidationError('CSV 样本格式不一致或超出限制')
    }
  }
  if (!hasHeader) throw new CsvValidationError('CSV 缺少记录')
  const visibleColumns = Math.min(headers.length, 30)
  return { headers: headers.slice(0, visibleColumns).map(clip), rows,
    sampleRows: rows.length, totalKnown: false as const, columnCount: headers.length, columnsTruncated: headers.length > visibleColumns, sampleErrors }
}

function csvField(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** 按固定配置流式转换为 UTF-8 逗号分隔 CSV，原文件始终保留。 */
export async function normalizeCsvToFile(inputPath: string, outputPath: string, options: CsvImportOptions, signal?: AbortSignal, reportPath?: string) {
  const decoder = new TextDecoder(options.encoding, { fatal: true })
  const utf8 = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { callback(null, decoder.decode(chunk, { stream: true })) }
      catch { callback(new CsvValidationError(`CSV 包含无效的 ${options.encoding} 字节`)) }
    },
    flush(callback) {
      try { callback(null, decoder.decode()) }
      catch { callback(new CsvValidationError(`CSV 尾部包含无效的 ${options.encoding} 字节`)) }
    },
  })
  const parser = parse({ bom: true, delimiter: options.delimiter, quote: options.quote, relax_quotes: false,
    relax_column_count: true, max_record_size: MAX_RECORD_BYTES, skip_empty_lines: false })
  let headers: string[] = []
  let hasHeader = false
  const headerRecords: string[][] = []
  let rowCount = 0
  let sourceRecord = 0
  let errorCount = 0
  const reportRef: { current: ReturnType<typeof createWriteStream> | null } = { current: null }
  const isolate = (row: string[], reason: string, callback: (error?: Error | null) => void) => {
    if (options.invalidRows !== 'isolate' || !hasHeader) { callback(new CsvValidationError(`CSV 第 ${sourceRecord} 条记录${reason}`)); return }
    errorCount += 1
    if (!reportPath) { callback(); return }
    if (!reportRef.current) {
      const stream = createWriteStream(reportPath, { flags: 'wx', mode: 0o600 })
      stream.on('error', (error) => canonical.destroy(error))
      stream.write('源记录号,原因,已解析字段 JSON\n')
      reportRef.current = stream
    }
    const report = reportRef.current
    const accepted = report.write(`${csvField(String(sourceRecord))},${csvField(reason)},${csvField(JSON.stringify(row))}\n`)
    if (accepted) callback()
    else void once(report, 'drain').then(() => callback(), (error: Error) => callback(error))
  }
  const canonical = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      sourceRecord += 1
      if (!Array.isArray(row) || row.length === 0 || row.length > MAX_COLUMNS) {
        isolate(row, '的字段数量无效', callback); return
      }
      let recordBytes = 0
      for (const cell of row) {
        const cellBytes = Buffer.byteLength(cell, 'utf8')
        if (cellBytes > MAX_CELL_BYTES) { isolate(row, '有单元格超过 1 MiB 限制', callback); return }
        recordBytes += cellBytes + 1
      }
      if (recordBytes > MAX_RECORD_BYTES) { isolate(row, '超过 8 MiB 限制', callback); return }
      if (options.header === 'first-row' && !hasHeader && sourceRecord < options.headerRow) { callback(); return }
      if (options.header === 'first-row' && !hasHeader && sourceRecord < options.headerRow + (options.headerRowCount ?? 1)) {
        headerRecords.push(row)
        if (headerRecords.length === (options.headerRowCount ?? 1)) {
          headers = headerRecords.length === 1 ? row : flattenHeaders(headerRecords, options)
          hasHeader = true
          callback(null, `${headers.map(csvField).join(',')}\n`)
          return
        }
        callback()
        return
      }
      if (sourceRecord < options.dataStartRow || (options.dataEndRow !== null && sourceRecord > options.dataEndRow) ||
        (options.skipEmptyLines && row.length === 1 && row[0] === '')) { callback(); return }
      if (!hasHeader) {
        headers = row.map((_value, index) => `column_${index + 1}`)
        hasHeader = true
        if (Buffer.byteLength(headers.map(csvField).join(',')) > MAX_RECORD_BYTES) {
          throw new CsvValidationError('CSV 表头无效或超过限制')
        }
        rowCount += 1
        callback(null, `${headers.map(csvField).join(',')}\n${row.map(csvField).join(',')}\n`)
        return
      } else if (row.length !== headers.length) {
        isolate(row, `字段数为 ${row.length}，预期 ${headers.length}`, callback); return
      } else rowCount += 1
      callback(null, `${row.map(csvField).join(',')}\n`)
    } catch (error) { callback(error as Error) }
  } })
  try {
    await pipeline(createReadStream(inputPath), utf8, parser, canonical,
      createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
    const report = reportRef.current
    if (report) { report.end(); await finished(report) }
  } catch (error) {
    reportRef.current?.destroy()
    if (error instanceof CsvValidationError) throw error
    if (signal?.aborted) throw new CsvValidationError('CSV 校验已取消')
    throw new CsvValidationError('CSV 记录格式不一致或超过单记录 8 MiB 限制')
  }
  if (!hasHeader) throw new CsvValidationError('CSV 缺少记录')
  return { headers, rowCount, errorCount }
}

/** 完整扫描原文件；不把截断样本当作正式解析结果。 */
export async function inspectCsv(path: string, signal?: AbortSignal) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const source = createReadStream(path)
  const utf8 = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { callback(null, decoder.decode(chunk, { stream: true })) }
      catch { callback(new CsvValidationError('CSV 包含无效的 UTF-8 字节')) }
    },
    flush(callback) {
      try { callback(null, decoder.decode()) }
      catch { callback(new CsvValidationError('CSV 尾部包含无效的 UTF-8 字节')) }
    },
  })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: MAX_RECORD_BYTES, skip_empty_lines: false })
  let headers: string[] = []
  let hasHeader = false
  let rowCount = 0
  try {
    const collect = new Writable({ objectMode: true, write(row: string[], _encoding, callback) {
      try {
        if (row.length === 0 || row.length > MAX_COLUMNS) throw new CsvValidationError('CSV 字段数量无效')
        let recordBytes = 0
        for (const cell of row) {
          const cellBytes = Buffer.byteLength(cell, 'utf8')
          if (cellBytes > MAX_CELL_BYTES) throw new CsvValidationError('CSV 单元格超过 1 MiB 限制')
          recordBytes += cellBytes + 1
        }
        if (recordBytes > MAX_RECORD_BYTES) throw new CsvValidationError('CSV 单记录超过 8 MiB 限制')
        if (!hasHeader) { headers = row; hasHeader = true }
        else rowCount += 1
        callback()
      } catch (error) { callback(error as Error) }
    } })
    await pipeline(source, utf8, parser, collect, { signal })
  } catch (error) {
    if (error instanceof CsvValidationError) throw error
    if (signal?.aborted) throw new CsvValidationError('CSV 校验已取消')
    throw new CsvValidationError('CSV 记录格式不一致或超过单记录 8 MiB 限制')
  }
  if (!hasHeader || headers.length === 0) throw new CsvValidationError('CSV 缺少表头')
  return { headers, rowCount }
}
