import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'
import { decode as iconvDecode, encode as iconvEncode } from 'iconv-lite'
import type { ExportScope } from './export-scope.ts'

function protectFormula(value: string) {
  return /^\s*[=+\-@]/u.test(value) || /^[\t\r]/u.test(value) ? `'${value}` : value
}

export interface TextExportOptions { encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'; delimiter: ',' | ';' | '\t' | '|';
  quote: '"' | "'"; newline: 'lf' | 'crlf'; bom: boolean }
export interface JsonExportOptions { emptyAsNull: boolean; types: Record<string, 'text' | 'integer' | 'decimal' | 'boolean' | 'date'> }
export class ExportConfigError extends Error {}
export function validateTextExportOptions(options: TextExportOptions) {
  if (!options || !['utf-8','utf-16le','utf-16be','gb18030'].includes(options.encoding) || ![',',';','\t','|'].includes(options.delimiter) ||
    !['"', "'"].includes(options.quote) || !['lf','crlf'].includes(options.newline) || typeof options.bom !== 'boolean' ||
    options.encoding === 'gb18030' && options.bom) {
    throw new ExportConfigError('文本导出配置无效')
  }
  return options
}
export function validateJsonExportOptions(options: JsonExportOptions, width: number) {
  if (!options || typeof options.emptyAsNull !== 'boolean' || !options.types || typeof options.types !== 'object' ||
    Array.isArray(options.types) || Object.keys(options.types).length > width || Object.entries(options.types).some(([id, type]) =>
      !/^c_(\d+)$/u.test(id) || Number(id.slice(2)) >= width || !['text','integer','decimal','boolean','date'].includes(type))) {
    throw new ExportConfigError('JSON 导出字段类型或空值规则无效')
  }
  return options
}
function jsonField(header: string, raw: string, type: JsonExportOptions['types'][string], emptyAsNull: boolean, rowNumber: number) {
  if (raw === '' && emptyAsNull) return `${JSON.stringify(header)}:null`
  if (type === 'text') return `${JSON.stringify(header)}:${JSON.stringify(raw)}`
  if (raw === '') throw new ExportConfigError(`第 ${rowNumber} 行字段 ${header} 为空，请选择转 null 或文本类型`)
  if (type === 'integer' && !/^-?(?:0|[1-9]\d{0,14})$/u.test(raw)) throw new ExportConfigError(`第 ${rowNumber} 行字段 ${header} 不是 15 位以内整数`)
  if (type === 'decimal' && (!/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,15})?$/u.test(raw) || raw.replace(/[-.0]/gu, '').length > 15)) {
    throw new ExportConfigError(`第 ${rowNumber} 行字段 ${header} 超出 JSON 数值保真限制`)
  }
  if (type === 'boolean' && !['true','false'].includes(raw)) throw new ExportConfigError(`第 ${rowNumber} 行字段 ${header} 不是 true 或 false`)
  if (type === 'date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw)
    if (!match) throw new ExportConfigError(`第 ${rowNumber} 行字段 ${header} 不是 YYYY-MM-DD 日期`)
    const date = new Date(0)
    date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    date.setUTCHours(0, 0, 0, 0)
    if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) ||
      date.getUTCDate() !== Number(match[3])) throw new ExportConfigError(`第 ${rowNumber} 行字段 ${header} 不是有效日期`)
  }
  return `${JSON.stringify(header)}:${type === 'date' ? JSON.stringify(raw) : raw}`
}

export async function inspectJsonExport(inputPath: string, requestedOptions: JsonExportOptions, scope?: ExportScope, signal?: AbortSignal) {
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  let headers: string[] | null = null, rows = 0, checkedRows = 0, nullConversions = 0
  const selected = scope?.columnIds.map((id) => Number(id.slice(2)))
  try {
    for await (const cells of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new ExportConfigError('导出预检已取消')
      if (!headers) {
        headers = cells
        const selectedHeaders = selected ? selected.map((column) => headers![column]) : headers
        if (selectedHeaders.some((value) => !value) || new Set(selectedHeaders).size !== selectedHeaders.length) {
          throw new ExportConfigError('JSON 导出要求所选字段名非空且不重复')
        }
        validateJsonExportOptions(requestedOptions, headers.length)
        continue
      }
      rows += 1
      if (cells.length !== headers.length) throw new ExportConfigError(`第 ${rows} 行字段数与表头不一致`)
      if (scope && (rows < scope.startRow || rows > scope.endRow)) continue
      for (const column of selected ?? headers.map((_, index) => index)) {
        const raw = cells[column]!
        jsonField(headers[column]!, raw, requestedOptions.types[`c_${column}`] ?? 'text', requestedOptions.emptyAsNull, rows)
        if (raw === '' && requestedOptions.emptyAsNull) nullConversions += 1
      }
      checkedRows += 1
    }
    if (!headers) throw new ExportConfigError('输入数据集缺少表头')
    return { rows, columns: headers.length, checkedRows, nullConversions }
  } finally { source.destroy(); parser.destroy() }
}
function encodeCell(value: string, delimiter: string, quote: '"' | "'") {
  return value.includes(delimiter) || value.includes(quote) || /[\r\n]/u.test(value) ? `${quote}${value.replaceAll(quote, quote + quote)}${quote}` : value
}
function encoded(value: string, encoding: TextExportOptions['encoding']) {
  if (encoding === 'utf-8') return Buffer.from(value, 'utf8')
  if (encoding === 'gb18030') {
    const bytes = iconvEncode(value, 'gb18030')
    if (iconvDecode(bytes, 'gb18030') !== value) throw new ExportConfigError('文本含 GB18030 无法无损表达的字符')
    return bytes
  }
  const buffer = Buffer.from(value, 'utf16le')
  if (encoding === 'utf-16be') for (let index = 0; index < buffer.length; index += 2) {
    const byte = buffer[index]!; buffer[index] = buffer[index + 1]!; buffer[index + 1] = byte
  }
  return buffer
}

export async function inspectTextExport(inputPath: string, requestedOptions: TextExportOptions, scope?: ExportScope, signal?: AbortSignal) {
  const options = validateTextExportOptions(requestedOptions)
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  let rows = 0, columns = 0, checkedRows = 0, formulaCandidates = 0
  const selected = scope?.columnIds.map((id) => Number(id.slice(2)))
  try {
    for await (const cells of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new ExportConfigError('导出预检已取消')
      if (!columns) columns = cells.length
      else {
        rows += 1
        if (cells.length !== columns) throw new ExportConfigError(`第 ${rows} 行字段数与表头不一致`)
        if (scope && (rows < scope.startRow || rows > scope.endRow)) continue
      }
      for (const column of selected ?? cells.map((_, index) => index)) {
        const value = cells[column]
        if (value === undefined) throw new ExportConfigError('所选字段不存在')
        if (rows > 0 && protectFormula(value) !== value) formulaCandidates += 1
        if (options.encoding === 'gb18030') encoded(value, options.encoding)
      }
      if (rows > 0) checkedRows += 1
    }
    if (!columns) throw new ExportConfigError('输入数据集缺少表头')
    return { rows, columns, checkedRows, formulaCandidates }
  } finally { source.destroy(); parser.destroy() }
}

/** 流式输出全表；安全文本模式只改变导出副本，不修改输入数据集。 */
export async function writeTextExport(inputPath: string, outputPath: string, format: 'csv' | 'tsv', safeText: boolean,
  signal?: AbortSignal, requestedOptions?: TextExportOptions) {
  const options = validateTextExportOptions(requestedOptions ?? { encoding: 'utf-8', delimiter: format === 'tsv' ? '\t' : ',',
    quote: '"', newline: 'lf', bom: false })
  const delimiter = options.delimiter
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  let records = 0
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      records += 1
      const values = safeText ? row.map(protectFormula) : row
      const line = `${values.map((cell) => encodeCell(cell, delimiter, options.quote)).join(delimiter)}${options.newline === 'crlf' ? '\r\n' : '\n'}`
      const prefix = records === 1 && options.bom ? options.encoding === 'utf-8' ? Buffer.from([0xef,0xbb,0xbf]) :
        options.encoding === 'utf-16le' ? Buffer.from([0xff,0xfe]) : options.encoding === 'utf-16be' ? Buffer.from([0xfe,0xff]) : Buffer.alloc(0) : Buffer.alloc(0)
      callback(null, prefix.length ? Buffer.concat([prefix, encoded(line, options.encoding)]) : encoded(line, options.encoding))
    } catch (error) { callback(error as Error) }
  } })
  await pipeline(createReadStream(inputPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
  if (records < 1) throw new Error('输入数据集缺少表头')
  return { rows: records - 1 }
}

/** JSON 字段全部按原始文本值写出；无法从 CSV 反推 null 或数字类型。 */
export async function writeJsonExport(inputPath: string, outputPath: string, format: 'json' | 'jsonl',
  signal?: AbortSignal, requestedOptions?: JsonExportOptions) {
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  let headers: string[] | null = null
  let records = 0
  let options: JsonExportOptions = { emptyAsNull: false, types: {} }
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      if (headers === null) {
        if (row.some((header) => !header) || new Set(row).size !== row.length) throw new Error('JSON 导出要求字段名非空且不重复')
        options = validateJsonExportOptions(requestedOptions ?? { emptyAsNull: false, types: {} }, row.length)
        headers = row
        callback(null, format === 'json' ? '[\n' : '')
        return
      }
      if (row.length !== headers.length) throw new Error('记录列数与字段不一致')
      const fields = headers.map((header, index) => jsonField(header, row[index]!, options.types[`c_${index}`] ?? 'text',
        options.emptyAsNull, records + 1))
      const value = `{${fields.join(',')}}`
      callback(null, format === 'jsonl' ? `${value}\n` : `${records++ === 0 ? '' : ',\n'}${value}`)
      if (format === 'jsonl') records += 1
    } catch (error) { callback(error as Error) }
  }, flush(callback) {
    if (!headers) { callback(new Error('输入数据集缺少表头')); return }
    callback(null, format === 'json' ? '\n]\n' : '')
  } })
  await pipeline(createReadStream(inputPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
  return { rows: records }
}
