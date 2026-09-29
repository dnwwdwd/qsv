import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'
import Database from 'better-sqlite3'

export interface SetConfig { kind: 'intersection' | 'left-difference' | 'right-difference' | 'union';
  leftKeyIds: string[]; rightKeyIds: string[] }
export class SetOperationError extends Error {}

function column(id: string) { return Number(id.slice(2)) }
function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(row: string[]) { return `${row.map(csvCell).join(',')}\n` }

export function validateSetConfig(config: SetConfig, leftHeaders: string[], rightHeaders: string[]) {
  const valid = (id: unknown, width: number) => typeof id === 'string' && /^c_(\d+)$/u.test(id) && column(id) < width
  if (!config || !['intersection', 'left-difference', 'right-difference', 'union'].includes(config.kind) ||
    !Array.isArray(config.leftKeyIds) || !Array.isArray(config.rightKeyIds) ||
    config.leftKeyIds.length < 1 || config.leftKeyIds.length > 16 ||
    config.leftKeyIds.length !== config.rightKeyIds.length ||
    new Set(config.leftKeyIds).size !== config.leftKeyIds.length || new Set(config.rightKeyIds).size !== config.rightKeyIds.length ||
    config.leftKeyIds.some((id) => !valid(id, leftHeaders.length)) ||
    config.rightKeyIds.some((id) => !valid(id, rightHeaders.length))) throw new SetOperationError('集合运算规则无效')
  if (config.kind === 'union' && JSON.stringify(leftHeaders) !== JSON.stringify(rightHeaders)) {
    throw new SetOperationError('去重并集要求两侧字段名及顺序完全一致')
  }
}

/** 基于指定键的集合语义：每个键只保留其在对应输入中的首条记录，空键作为普通值参与。 */
export async function writeSetOperation(leftPath: string, rightPath: string, outputPath: string, config: SetConfig,
  expectedLeft: number, expectedRight: number, signal?: AbortSignal, lineagePath?: string) {
  const dbPath = `${outputPath}.sets.sqlite`
  const db = new Database(dbPath)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE entries (key TEXT PRIMARY KEY, left_row TEXT, left_order INTEGER, right_row TEXT, right_order INTEGER) WITHOUT ROWID')
  const leftInsert = db.prepare('INSERT INTO entries(key,left_row,left_order) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING')
  const rightInsert = db.prepare('INSERT INTO entries(key,right_row,right_order) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET right_row=COALESCE(entries.right_row,excluded.right_row),right_order=COALESCE(entries.right_order,excluded.right_order)')
  const batchInsert = db.transaction((items: Array<{ key: string; row: string; order: number }>, side: 'left' | 'right') => {
    const stmt = side === 'left' ? leftInsert : rightInsert
    for (const item of items) stmt.run(item.key, item.row, item.order)
  })
  const ingest = async (path: string, side: 'left' | 'right', keyIds: string[], expected: number) => {
    const source = createReadStream(path, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    let headers: string[] | null = null
    let rows = 0
    let pending: Array<{ key: string; row: string; order: number }> = []
    let pendingBytes = 0
    try {
      for await (const row of parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new SetOperationError('集合运算已取消')
        if (!headers) { headers = row; continue }
        rows += 1
        if (row.length !== headers.length) throw new SetOperationError(`${side} 第 ${rows} 行字段数不一致`)
        const key = JSON.stringify(keyIds.map((id) => row[column(id)] ?? ''))
        if (Buffer.byteLength(key, 'utf8') > 8192) throw new SetOperationError('集合键超过 8 KiB')
        const serialized = JSON.stringify(row)
        pending.push({ key, row: serialized, order: rows })
        pendingBytes += Buffer.byteLength(serialized, 'utf8')
        if (pending.length >= 1000 || pendingBytes >= 2 * 1024 * 1024) { batchInsert(pending, side); pending = []; pendingBytes = 0 }
      }
      if (!headers) throw new SetOperationError(`${side} 输入缺少表头`)
      if (pending.length) batchInsert(pending, side)
      if (rows !== expected) throw new SetOperationError(`${side} 输入行数与资源记录不一致`)
      return headers
    } finally { source.destroy(); parser.destroy() }
  }
  try {
    const leftHeaders = await ingest(leftPath, 'left', config.leftKeyIds, expectedLeft)
    const rightHeaders = await ingest(rightPath, 'right', config.rightKeyIds, expectedRight)
    validateSetConfig(config, leftHeaders, rightHeaders)
    const outputHeaders = config.kind === 'right-difference' ? rightHeaders : leftHeaders
    const query = config.kind === 'intersection'
      ? 'SELECT left_row AS cells,left_order,right_order FROM entries WHERE left_row IS NOT NULL AND right_row IS NOT NULL ORDER BY left_order'
      : config.kind === 'left-difference'
        ? 'SELECT left_row AS cells,left_order,right_order FROM entries WHERE left_row IS NOT NULL AND right_row IS NULL ORDER BY left_order'
        : config.kind === 'right-difference'
          ? 'SELECT right_row AS cells,left_order,right_order FROM entries WHERE right_row IS NOT NULL AND left_row IS NULL ORDER BY right_order'
          : 'SELECT COALESCE(left_row,right_row) AS cells,left_order,right_order FROM entries ORDER BY CASE WHEN left_row IS NOT NULL THEN 0 ELSE 1 END,COALESCE(left_order,right_order)'
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    const write = async (value: string) => { if (!output.write(value)) await once(output, 'drain') }
    const lineage = lineagePath ? createWriteStream(lineagePath, { flags: 'wx', mode: 0o600 }) : null
    const writeLineage = async (value: string) => { if (lineage && !lineage.write(value)) await once(lineage, 'drain') }
    let rowsOut = 0
    try {
      await write(csvLine(outputHeaders))
      for (const item of db.prepare(query).iterate() as Iterable<{ cells: string; left_order: number | null; right_order: number | null }>) {
        if (signal?.aborted) throw new SetOperationError('集合运算已取消')
        if (rowsOut >= 10_000_000) throw new SetOperationError('集合结果超过 1000 万行上限')
        await write(csvLine(JSON.parse(item.cells) as string[]))
        rowsOut += 1
        const sourceRow = config.kind === 'right-difference' || config.kind === 'union' && item.left_order === null
          ? expectedLeft + (item.right_order ?? 0) : item.left_order ?? 0
        if (!Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > expectedLeft + expectedRight) {
          throw new SetOperationError('集合结果来源行号无效')
        }
        await writeLineage(`${rowsOut},${sourceRow}\n`)
      }
      output.end()
      await finished(output)
      if (lineage) { lineage.end(); await finished(lineage) }
      return { rowsIn: expectedLeft + expectedRight, rowsOut, headers: outputHeaders }
    } catch (error) { output.destroy(); lineage?.destroy(); throw error }
  } finally { db.close(); await rm(dbPath, { force: true }) }
}
