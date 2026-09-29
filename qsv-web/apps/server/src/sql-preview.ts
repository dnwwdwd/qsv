import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'

export class SqlPreviewError extends Error {}
const MAX_SAMPLE_BYTES = 64 * 1024 * 1024
const MAX_PREVIEW_CELL = 256

function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(row: string[]) { return `${row.map(csvCell).join(',')}\n` }

/** 每份输入最多取 200 条完整记录；可从固定行范围开始，保留原 CSV 文本单元格。 */
export async function writeSqlInputSample(inputPath: string, outputPath: string, expectedColumns: number,
  signal?: AbortSignal, range?: { startRow: number; endRow: number }) {
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  let rows = 0
  let sourceRows = 0
  let bytes = 0
  let headerSeen = false
  try {
    for await (const value of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new SqlPreviewError('SQL 样本预览已取消')
      if (value.length !== expectedColumns) throw new SqlPreviewError('样本输入字段数与数据集结构不一致')
      if (headerSeen) {
        sourceRows += 1
        if (sourceRows < (range?.startRow ?? 1)) continue
        if (sourceRows > (range?.endRow ?? Number.MAX_SAFE_INTEGER) || rows >= 200) break
      }
      const text = csvLine(value)
      bytes += Buffer.byteLength(text)
      if (bytes > MAX_SAMPLE_BYTES) throw new SqlPreviewError('200 条样本超过 64 MiB，请缩小输入字段或直接运行完整任务')
      if (!output.write(text)) await once(output, 'drain')
      if (headerSeen) rows += 1
      else headerSeen = true
    }
    output.end()
    await finished(output)
    if (!headerSeen) throw new SqlPreviewError('样本输入缺少表头')
    return { rows, bytes }
  } catch (error) { output.destroy(); throw error }
  finally { source.destroy(); parser.destroy() }
}

/** 预览返回最多 200 行和 30 列；完整查询结果不会进入浏览器。 */
export async function readSqlPreview(path: string, signal?: AbortSignal) {
  const source = createReadStream(path, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  let headers: string[] | null = null
  const rows: string[][] = []
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new SqlPreviewError('SQL 样本预览已取消')
      if (!headers) { headers = row; continue }
      if (row.length !== headers.length) throw new SqlPreviewError('SQL 样本结果列数不一致')
      if (rows.length >= 200) break
      rows.push(row.slice(0, 30).map((value) => value.length > MAX_PREVIEW_CELL ? `${value.slice(0, MAX_PREVIEW_CELL)}…` : value))
    }
    if (!headers) throw new SqlPreviewError('SQL 样本查询没有返回表头')
    return { headers: headers.slice(0, 30), rows, sampleRows: rows.length, totalKnown: false as const,
      columnCount: headers.length, columnsTruncated: headers.length > 30 }
  } finally { source.destroy(); parser.destroy() }
}
