import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'

export interface ExportScope { startRow: number; endRow: number; columnIds: string[] }
export class ExportScopeError extends Error {}

const cell = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
const line = (values: string[]) => `${values.map(cell).join(',')}\n`

export function validateExportScope(value: ExportScope, totalRows: number, totalColumns: number) {
  if (!value || !Number.isSafeInteger(value.startRow) || !Number.isSafeInteger(value.endRow) ||
    value.startRow < 1 || value.endRow < value.startRow || value.endRow > totalRows ||
    !Array.isArray(value.columnIds) || value.columnIds.length < 1 || value.columnIds.length > totalColumns ||
    new Set(value.columnIds).size !== value.columnIds.length ||
    value.columnIds.some((id) => typeof id !== 'string' || !/^c_(0|[1-9]\d*)$/u.test(id) || Number(id.slice(2)) >= totalColumns)) {
    throw new ExportScopeError('导出行范围或字段选择无效')
  }
}

export async function writeExportScope(inputPath: string, outputPath: string, scope: ExportScope, expectedRows: number,
  expectedColumns: number, signal?: AbortSignal) {
  validateExportScope(scope, expectedRows, expectedColumns)
  const positions = scope.columnIds.map((id) => Number(id.slice(2)))
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  let readRows = 0
  let wroteRows = 0
  let seenHeader = false
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new ExportScopeError('导出已取消')
      if (row.length !== expectedColumns) throw new ExportScopeError('源数据字段数与资源记录不一致')
      if (!seenHeader) {
        seenHeader = true
        if (!output.write(line(positions.map((position) => row[position]!)))) await once(output, 'drain')
        continue
      }
      readRows += 1
      if (readRows >= scope.startRow && readRows <= scope.endRow) {
        if (!output.write(line(positions.map((position) => row[position]!)))) await once(output, 'drain')
        wroteRows += 1
      }
    }
    if (!seenHeader || readRows !== expectedRows || wroteRows !== scope.endRow - scope.startRow + 1) {
      throw new ExportScopeError('源数据行数与资源记录不一致')
    }
    output.end()
    await finished(output)
    return { rows: wroteRows, columns: positions.length }
  } catch (error) { output.destroy(); throw error }
  finally { source.destroy(); parser.destroy() }
}

export async function scanWorkbookCells(inputPath: string, signal?: AbortSignal, scope?: ExportScope) {
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  let row = 0
  let columns = 0
  const selected = scope?.columnIds.map((id) => Number(id.slice(2)))
  try {
    for await (const cells of parser as AsyncIterable<string[]>) {
      row += 1
      if (row === 1) columns = cells.length
      if (row > 1 && cells.length !== columns) throw new ExportScopeError(`第 ${row} 行字段数与表头不一致`)
      if (scope && row > 1 && (row - 1 < scope.startRow || row - 1 > scope.endRow)) continue
      for (const column of selected ?? cells.map((_, index) => index)) {
        if (cells[column] === undefined) throw new ExportScopeError('所选字段不存在')
        if (cells[column]!.length > 32_767) {
          throw new ExportScopeError(`第 ${row} 行、第 ${column + 1} 列超过工作簿单元格 32767 字符限制；请选择文本格式或先清洗该值`)
        }
      }
    }
    if (row === 0) throw new ExportScopeError('输入数据集缺少表头')
    return { rows: row - 1, columns }
  } finally { source.destroy(); parser.destroy() }
}
