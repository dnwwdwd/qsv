import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'
import Database from 'better-sqlite3'

export type ReshapeConfig =
  | { kind: 'split-column'; columnId: string; delimiter: string; direction: 'columns' | 'rows';
      maxParts: number; keepEmpty: boolean; overflow: 'error' | 'join-last' }
  | { kind: 'group-join'; keyIds: string[]; valueId: string; separator: string }
  | { kind: 'transpose' }

export class ReshapeError extends Error {}
const column = (id: string) => Number(id.slice(2))
const field = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
const line = (values: string[]) => `${values.map(field).join(',')}\n`

export function validateReshapeConfig(config: ReshapeConfig, headers: string[], rows: number) {
  const validColumn = (id: unknown) => typeof id === 'string' && /^c_(\d+)$/u.test(id) && column(id) < headers.length
  if (!config || !['split-column', 'group-join', 'transpose'].includes(config.kind)) throw new ReshapeError('重组规则无效')
  if (config.kind === 'split-column') {
    if (!validColumn(config.columnId) || typeof config.delimiter !== 'string' || !config.delimiter ||
      config.delimiter.length > 16 || !['columns', 'rows'].includes(config.direction) ||
      !Number.isSafeInteger(config.maxParts) || config.maxParts < 2 || config.maxParts > 32 ||
      typeof config.keepEmpty !== 'boolean' || !['error', 'join-last'].includes(config.overflow) ||
      (config.direction === 'columns' && headers.length + config.maxParts > 4096) ||
      (config.direction === 'rows' && rows * config.maxParts > 10_000_000)) throw new ReshapeError('分隔列参数无效或预计输出超过 1000 万行')
  } else if (config.kind === 'group-join') {
    if (!Array.isArray(config.keyIds) || !config.keyIds.length || config.keyIds.length > 8 ||
      config.keyIds.some((id) => !validColumn(id)) || new Set(config.keyIds).size !== config.keyIds.length ||
      !validColumn(config.valueId) || typeof config.separator !== 'string' || config.separator.length > 16) {
      throw new ReshapeError('按键组合参数无效')
    }
  } else if (rows > 4095 || headers.length > 4096 || rows * headers.length > 1_000_000) {
    throw new ReshapeError('转置最多支持 4095 行及 100 万个单元格，请先缩小数据范围')
  }
}

/** 所有分隔操作均以完整 CSV 记录为单位；按键组合与转置有明确的磁盘/内存边界。 */
export async function writeReshapedCsv(inputPath: string, outputPath: string, config: ReshapeConfig,
  expectedRows: number, signal?: AbortSignal, rowMapPath?: string) {
  const scratchPath = `${outputPath}.reshape.sqlite`
  const scratch = config.kind === 'group-join' ? new Database(scratchPath) : null
  if (scratch) {
    scratch.pragma('journal_mode = DELETE')
    scratch.exec('CREATE TABLE groups (key TEXT PRIMARY KEY, key_values TEXT NOT NULL, first_row INTEGER NOT NULL) WITHOUT ROWID; CREATE TABLE items (key TEXT NOT NULL, row_number INTEGER NOT NULL, value TEXT NOT NULL); CREATE INDEX items_key ON items(key,row_number)')
  }
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const write = async (value: string) => { if (!output.write(value)) await once(output, 'drain') }
  const rowMap = rowMapPath && config.kind === 'split-column'
    ? createWriteStream(rowMapPath, { flags: 'wx', mode: 0o600 }) : null
  const writeMap = async (outputRow: number, sourceRow: number) => {
    if (rowMap && !rowMap.write(line([String(outputRow), String(sourceRow)]))) await once(rowMap, 'drain')
  }
  let headers: string[] | null = null
  let rowsIn = 0
  let rowsOut = 0
  let matrixBytes = 0
  const matrix: string[][] = []
  const group = scratch?.prepare('INSERT INTO groups(key,key_values,first_row) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING')
  const item = scratch?.prepare('INSERT INTO items(key,row_number,value) VALUES (?,?,?)')
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new ReshapeError('重组已取消')
      if (!headers) {
        headers = row
        validateReshapeConfig(config, headers, expectedRows)
        if (config.kind === 'split-column') {
          const newHeaders = config.direction === 'columns'
            ? [...headers, ...Array.from({ length: config.maxParts }, (_, index) => `${headers![column(config.columnId)]}_片段${index + 1}`)]
            : [...headers, '片段序号', '片段内容']
          if (new Set(newHeaders).size !== newHeaders.length) throw new ReshapeError('新列名与现有列名重复，请先重命名源字段')
          await write(line(newHeaders))
        }
        continue
      }
      rowsIn += 1
      if (row.length !== headers.length) throw new ReshapeError(`第 ${rowsIn} 行字段数不一致`)
      if (config.kind === 'split-column') {
        const parts = row[column(config.columnId)]!.split(config.delimiter).filter((part) => config.keepEmpty || part !== '')
        if (parts.length > config.maxParts) {
          if (config.overflow === 'error') throw new ReshapeError(`第 ${rowsIn} 行超出 ${config.maxParts} 个片段`)
          parts.splice(config.maxParts - 1, parts.length, parts.slice(config.maxParts - 1).join(config.delimiter))
        }
        if (config.direction === 'columns') {
          await write(line([...row, ...Array.from({ length: config.maxParts }, (_, index) => parts[index] ?? '')]))
          rowsOut += 1; await writeMap(rowsOut, rowsIn)
        }
        else for (let index = 0; index < parts.length; index += 1) {
          if (rowsOut >= 10_000_000) throw new ReshapeError('分隔结果超过 1000 万行')
          await write(line([...row, String(index + 1), parts[index]!]))
          rowsOut += 1; await writeMap(rowsOut, rowsIn)
        }
      } else if (config.kind === 'group-join') {
        const values = config.keyIds.map((id) => row[column(id)] ?? '')
        const key = JSON.stringify(values)
        if (Buffer.byteLength(key) > 8192) throw new ReshapeError('组合键超过 8 KiB')
        group!.run(key, key, rowsIn)
        item!.run(key, rowsIn, row[column(config.valueId)] ?? '')
        if (rowsIn % 1000 === 0 && Number((scratch!.prepare('SELECT COUNT(*) AS total FROM groups').get() as { total: number }).total) > 100_000) {
          throw new ReshapeError('组合分组超过 10 万组上限')
        }
      } else {
        matrixBytes += row.reduce((total, cell) => total + Buffer.byteLength(cell), 0)
        if (matrixBytes > 64 * 1024 * 1024) throw new ReshapeError('转置数据超过 64 MiB 内存预算')
        matrix.push(row)
      }
    }
    if (!headers) throw new ReshapeError('数据集缺少表头')
    if (rowsIn !== expectedRows) throw new ReshapeError('重组输入行数与资源记录不一致')
    if (config.kind === 'group-join') {
      if (Number((scratch!.prepare('SELECT COUNT(*) AS total FROM groups').get() as { total: number }).total) > 100_000) {
        throw new ReshapeError('组合分组超过 10 万组上限')
      }
      const outputHeaders = [...config.keyIds.map((id) => headers![column(id)]!), `${headers[column(config.valueId)]}_组合`]
      if (new Set(outputHeaders).size !== outputHeaders.length) throw new ReshapeError('结果字段名重复')
      await write(line(outputHeaders))
      const selectItems = scratch!.prepare('SELECT value FROM items WHERE key=? ORDER BY row_number')
      for (const entry of scratch!.prepare('SELECT key,key_values FROM groups ORDER BY first_row').iterate() as Iterable<{ key: string; key_values: string }>) {
        const values: string[] = []
        let size = 0
        for (const member of selectItems.iterate(entry.key) as Iterable<{ value: string }>) {
          size += Buffer.byteLength(member.value) + Buffer.byteLength(config.separator)
          if (size > 32767) throw new ReshapeError('组合后的单元格超过 32767 字节；请先缩小分组')
          values.push(member.value)
        }
        await write(line([...(JSON.parse(entry.key_values) as string[]), values.join(config.separator)]))
        rowsOut += 1
      }
    } else if (config.kind === 'transpose') {
      const outputHeaders = ['源字段', ...matrix.map((_, index) => `第${index + 1}行`)]
      await write(line(outputHeaders))
      for (let col = 0; col < headers.length; col += 1) {
        await write(line([headers[col]!, ...matrix.map((row) => row[col]!)]))
        rowsOut += 1
      }
    }
    output.end()
    await finished(output)
    if (rowMap) { rowMap.end(); await finished(rowMap) }
    return { rowsIn, rowsOut }
  } catch (error) { output.destroy(); rowMap?.destroy(); throw error }
  finally { source.destroy(); parser.destroy(); scratch?.close(); if (scratch) await rm(scratchPath, { force: true }) }
}

/** 依据拆分时写出的行映射及转置的行列关系，重建稀疏空值来源清单。 */
export async function reshapeCellStates(outputCsv: string, outputPath: string, config: ReshapeConfig,
  inputHeaders: string[], inputReport: string | undefined, rowMapPath: string | undefined,
  expectedInputRows: number, expectedOutputRows: number, signal?: AbortSignal) {
  if (config.kind === 'group-join') return undefined
  const scratchPath = `${outputPath}.lookup.sqlite`
  const db = new Database(scratchPath)
  const openCsv = (path: string) => {
    const source = createReadStream(path, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    return { source, parser }
  }
  let writer: ReturnType<typeof createWriteStream> | null = null
  let stateRows = 0
  try {
    db.pragma('journal_mode = OFF')
    db.pragma('synchronous = OFF')
    db.exec('CREATE TABLE states (source_row INTEGER NOT NULL, field TEXT NOT NULL, origin_row INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(source_row,field)) WITHOUT ROWID; CREATE INDEX states_field ON states(field,source_row)')
    if (inputReport) {
      const source = openCsv(inputReport)
      const insert = db.prepare('INSERT INTO states(source_row,field,origin_row,reason) VALUES (?,?,?,?)')
      const store = db.transaction((rows: [number, string, number, string][]) => { for (const row of rows) insert.run(...row) })
      let headerSeen = false, pending: [number, string, number, string][] = []
      try {
        for await (const row of source.parser as AsyncIterable<string[]>) {
          if (signal?.aborted) throw new ReshapeError('重组空值来源处理已取消')
          if (!headerSeen) {
            headerSeen = true
            if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
              throw new ReshapeError('重组输入的空值来源清单格式无效')
            }
            continue
          }
          const origin = Number(row[0]), sourceRow = Number(row[1])
          if (row.length !== 4 || !Number.isSafeInteger(origin) || origin < 1 ||
            !Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > expectedInputRows) {
            throw new ReshapeError('重组输入的空值来源行号无效')
          }
          if (!inputHeaders.includes(row[2]!) || row[3] !== '缺字段已补为空文本' && row[3] !== '显式 null 已转为空文本') continue
          pending.push([sourceRow, row[2]!, origin, row[3]!])
          if (pending.length >= 1000) { store(pending); pending = [] }
        }
        if (!headerSeen) throw new ReshapeError('重组输入的空值来源清单为空')
        if (pending.length) store(pending)
      } finally { source.source.destroy(); source.parser.destroy() }
    }
    const writeState = async (origin: number, outputRow: number, fieldName: string, reason: string) => {
      if (stateRows >= 10_000_000) throw new ReshapeError('重组结果的空值来源超过 1000 万处，请缩小输入')
      if (!writer) {
        writer = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
        if (!writer.write(line(['源记录号', '输出行号', '字段', '转换说明']))) await once(writer, 'drain')
      }
      if (!writer.write(line([String(origin), String(outputRow), fieldName, reason]))) await once(writer, 'drain')
      stateRows += 1
    }
    if (config.kind === 'transpose') {
      if (expectedOutputRows !== inputHeaders.length) throw new ReshapeError('转置输出行数不一致')
      const select = db.prepare('SELECT source_row,origin_row,reason FROM states WHERE field=? ORDER BY source_row')
      for (let outputRow = 1; outputRow <= inputHeaders.length; outputRow += 1) {
        if (signal?.aborted) throw new ReshapeError('重组空值来源处理已取消')
        for (const state of select.iterate(inputHeaders[outputRow - 1]!) as Iterable<{
          source_row: number; origin_row: number; reason: string }>) {
          await writeState(state.origin_row, outputRow, `第${state.source_row}行`, state.reason)
        }
      }
    } else {
      if (!rowMapPath) throw new ReshapeError('拆分结果缺少行号映射')
      const output = openCsv(outputCsv), mapping = openCsv(rowMapPath)
      const select = db.prepare('SELECT field,origin_row,reason FROM states WHERE source_row=?')
      const mapIterator = (mapping.parser as AsyncIterable<string[]>)[Symbol.asyncIterator]()
      let outputHeaders: string[] | null = null, outputRow = 0
      try {
        for await (const row of output.parser as AsyncIterable<string[]>) {
          if (signal?.aborted) throw new ReshapeError('重组空值来源处理已取消')
          if (!outputHeaders) { outputHeaders = row; continue }
          outputRow += 1
          if (row.length !== outputHeaders.length) throw new ReshapeError('拆分结果字段数不一致')
          const next = await mapIterator.next()
          const sourceRow = Number(next.value?.[1])
          if (next.done || next.value?.length !== 2 || Number(next.value[0]) !== outputRow ||
            !Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > expectedInputRows) {
            throw new ReshapeError('拆分结果行号映射无效')
          }
          const original = new Map((select.all(sourceRow) as { field: string; origin_row: number; reason: string }[])
            .map((state) => [state.field, state] as const))
          for (const [fieldName, state] of original) await writeState(state.origin_row, outputRow, fieldName, state.reason)
          const selected = inputHeaders[column(config.columnId)]!
          const sourceState = original.get(selected)
          if (config.direction === 'rows') {
            if (sourceState && row[inputHeaders.length + 1] === '') {
              await writeState(sourceState.origin_row, outputRow, '片段内容', sourceState.reason)
            }
          } else {
            const parts = row[column(config.columnId)]!.split(config.delimiter)
              .filter((part) => config.keepEmpty || part !== '')
            if (parts.length > config.maxParts) {
              parts.splice(config.maxParts - 1, parts.length, parts.slice(config.maxParts - 1).join(config.delimiter))
            }
            for (let index = 0; index < config.maxParts; index += 1) {
              const name = outputHeaders[inputHeaders.length + index]!
              if (index >= parts.length) await writeState(outputRow, outputRow, name, '缺字段已补为空文本')
              else if (parts[index] === '' && sourceState) {
                await writeState(sourceState.origin_row, outputRow, name, sourceState.reason)
              }
            }
          }
        }
        if (!outputHeaders || outputRow !== expectedOutputRows || !(await mapIterator.next()).done) {
          throw new ReshapeError('拆分结果行数与来源映射不一致')
        }
      } finally { output.source.destroy(); output.parser.destroy(); mapping.source.destroy(); mapping.parser.destroy() }
    }
    if (writer) { writer.end(); await finished(writer) }
    return stateRows ? { file: 'cell-states.csv', rows: stateRows } : undefined
  } catch (error) { writer?.destroy(); throw error }
  finally { db.close(); await rm(scratchPath, { force: true }) }
}
