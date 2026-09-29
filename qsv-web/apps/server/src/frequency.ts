import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import Database from 'better-sqlite3'
import { parse } from 'csv-parse'

export class FrequencyError extends Error {}

function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(values: string[]) { return `${values.map(csvCell).join(',')}\n` }

export async function writeFrequencyTop(inputPath: string, outputPath: string, columnId: string,
  headers: string[], expectedRows: number, scratchLimitBytes: number, signal?: AbortSignal) {
  const index = Number(/^c_(\d+)$/u.exec(columnId)?.[1])
  if (!Number.isInteger(index) || index < 0 || index >= headers.length) throw new FrequencyError('频率字段无效')
  const scratchPath = `${outputPath}.frequency.sqlite`
  const db = new Database(scratchPath)
  const input = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  input.on('error', (error) => parser.destroy(error))
  input.pipe(parser)
  let rowsIn = 0
  let sawHeader = false
  try {
    db.pragma('journal_mode = OFF')
    db.pragma('synchronous = OFF')
    const pageBytes = db.pragma('page_size', { simple: true }) as number
    db.pragma(`max_page_count = ${Math.floor(scratchLimitBytes / pageBytes)}`)
    db.exec('CREATE TABLE frequencies (value TEXT PRIMARY KEY COLLATE BINARY, amount INTEGER NOT NULL) WITHOUT ROWID')
    const increment = db.prepare('INSERT INTO frequencies(value, amount) VALUES (?, 1) ON CONFLICT(value) DO UPDATE SET amount = amount + 1')
    db.exec('BEGIN')
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new FrequencyError('频率任务已取消')
      if (!sawHeader) {
        sawHeader = true
        if (row.length !== headers.length || row.some((value, at) => value !== headers[at])) {
          throw new FrequencyError('输入表头与固定资源版本不一致')
        }
        continue
      }
      rowsIn += 1
      if (row.length !== headers.length) throw new FrequencyError(`第 ${rowsIn} 行字段数不一致`)
      const value = row[index] ?? ''
      if (Buffer.byteLength(value, 'utf8') > 16 * 1024) throw new FrequencyError(`第 ${rowsIn} 行的频率值超过 16 KiB`)
      increment.run(value)
      if (rowsIn % 1000 === 0) { db.exec('COMMIT'); db.exec('BEGIN') }
    }
    db.exec('COMMIT')
    if (!sawHeader || rowsIn !== expectedRows) throw new FrequencyError('频率输入行数与资源记录不一致')
    const distinctValues = (db.prepare('SELECT COUNT(*) AS amount FROM frequencies').get() as { amount: number }).amount
    const top = db.prepare('SELECT value, amount FROM frequencies ORDER BY amount DESC, value ASC LIMIT 20')
      .all() as { value: string; amount: number }[]
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    const write = async (value: string) => { if (!output.write(value)) await once(output, 'drain') }
    try {
      await write(csvLine(['值', '记录数', '全表占比(%)']))
      for (const item of top) {
        if (signal?.aborted) throw new FrequencyError('频率任务已取消')
        await write(csvLine([item.value, String(item.amount), rowsIn ? (item.amount / rowsIn * 100).toFixed(6) : '0']))
      }
      output.end()
      await finished(output)
    } catch (error) { output.destroy(); throw error }
    return { rowsIn, rowsOut: top.length, distinctValues, headers: ['值', '记录数', '全表占比(%)'] }
  } catch (error) {
    try { if (db.inTransaction) db.exec('ROLLBACK') } catch { /* 临时索引直接删除。 */ }
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_FULL') {
      throw new FrequencyError(`频率索引超过 ${Math.floor(scratchLimitBytes / 1048576)} MiB 临时空间限制，请先筛选数据或缩小字段值`)
    }
    throw error
  } finally {
    input.destroy()
    parser.destroy()
    db.close()
    await rm(scratchPath, { force: true })
  }
}
