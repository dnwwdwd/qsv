import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'

export class CellEditError extends Error {}
export interface CellPatch { rowId: string; columnId: string; expectedOldValue: string; newValue: string }
export function validateCellPatches(sourceId: string, patches: CellPatch[], rowCount: number, width: number) {
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 10_000) throw new CellEditError('一次需修正 1 至 10000 个单元格')
  const seen = new Set<string>()
  const result = patches.map((patch) => {
    if (!patch || typeof patch !== 'object' || typeof patch.rowId !== 'string' || typeof patch.columnId !== 'string' ||
      typeof patch.expectedOldValue !== 'string' || typeof patch.newValue !== 'string' ||
      Buffer.byteLength(patch.newValue) > 8 * 1024 * 1024 || Buffer.byteLength(patch.expectedOldValue) > 8 * 1024 * 1024 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(patch.newValue)) throw new CellEditError('单元格修正内容无效')
    const row = patch.rowId.startsWith(`${sourceId}:`) ? /^(\d+)$/u.exec(patch.rowId.slice(sourceId.length + 1)) : null
    const column = /^c_(\d+)$/u.exec(patch.columnId)
    const rowIndex = row ? Number(row[1]) : -1, columnIndex = column ? Number(column[1]) : -1
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || rowIndex >= rowCount || !Number.isSafeInteger(columnIndex) ||
      columnIndex < 0 || columnIndex >= width || seen.has(`${rowIndex}:${columnIndex}`)) throw new CellEditError('单元格位置无效或重复')
    seen.add(`${rowIndex}:${columnIndex}`)
    return { rowIndex, columnIndex, expectedOldValue: patch.expectedOldValue, newValue: patch.newValue }
  })
  return result.sort((a, b) => a.rowIndex - b.rowIndex || a.columnIndex - b.columnIndex)
}
function csvLine(row: string[]) { return `${row.map((value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')}\n` }
export async function writeCellEdits(inputPath: string, outputPath: string, expectedHeaders: string[],
  edits: ReturnType<typeof validateCellPatches>, expectedRows: number, signal?: AbortSignal) {
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error)); source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  let headerSeen = false, rows = 0, nextEdit = 0, changed = 0
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CellEditError('修正任务已取消')
      if (!headerSeen) {
        if (JSON.stringify(row) !== JSON.stringify(expectedHeaders)) throw new CellEditError('数据集字段结构已变化')
        headerSeen = true
      } else {
        if (row.length !== expectedHeaders.length) throw new CellEditError(`第 ${rows + 1} 行字段数不一致`)
        while (edits[nextEdit]?.rowIndex === rows) {
          const edit = edits[nextEdit]!
          if (row[edit.columnIndex] !== edit.expectedOldValue) throw new CellEditError(`第 ${rows + 1} 行原值已变化，请重新检查修正草稿`)
          row[edit.columnIndex] = edit.newValue
          if (edit.expectedOldValue !== edit.newValue) changed += 1
          nextEdit += 1
        }
        rows += 1
      }
      if (!output.write(csvLine(row))) await once(output, 'drain')
    }
    if (!headerSeen || rows !== expectedRows || nextEdit !== edits.length) throw new CellEditError('修正输入行数与已选单元格无法核对')
    output.end(); await finished(output)
    return { rows, changed }
  } catch (error) { output.destroy(); throw error }
  finally { source.destroy(); parser.destroy() }
}
