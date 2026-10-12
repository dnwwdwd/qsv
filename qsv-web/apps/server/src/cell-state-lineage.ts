import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { rm } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import Database from 'better-sqlite3'
import { parse } from 'csv-parse'

export class CellStateLineageError extends Error {}

function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(values: string[]) { return `${values.map(csvCell).join(',')}\n` }

/** 保留筛选、排序结果中仍存在的 JSON 缺字段与显式 null 来源。映射行号由正式写出器产生。 */
export async function mapCellStates(sourceReport: string, rowMap: string, outputPath: string,
  expectedOutputRows: number, expectedInputRows: number, signal?: AbortSignal) {
  const scratchPath = `${outputPath}.lookup.sqlite`
  const db = new Database(scratchPath)
  const parseFile = (path: string) => {
    const source = createReadStream(path, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    return { source, parser }
  }
  let writer: ReturnType<typeof createWriteStream> | null = null
  const closeWriter = async () => { if (writer) { writer.end(); await finished(writer) } }
  const abortWriter = () => { writer?.destroy() }
  try {
    db.pragma('journal_mode = OFF')
    db.pragma('synchronous = OFF')
    db.exec('CREATE TABLE states (input_row INTEGER NOT NULL, field TEXT NOT NULL, origin_row INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(input_row,field)) WITHOUT ROWID')
    const insert = db.prepare('INSERT INTO states(input_row,field,origin_row,reason) VALUES (?,?,?,?)')
    const stateInput = parseFile(sourceReport)
    let sawHeader = false
    let pending: [number, string, number, string][] = []
    const store = db.transaction((entries: [number, string, number, string][]) => { for (const entry of entries) insert.run(...entry) })
    try {
      for await (const row of stateInput.parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
        if (!sawHeader) {
          sawHeader = true
          if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
            throw new CellStateLineageError('空值来源清单格式无效')
          }
          continue
        }
        const origin = Number(row[0]), inputRow = Number(row[1])
        if (row.length !== 4 || !Number.isSafeInteger(origin) || origin < 1 ||
          !Number.isSafeInteger(inputRow) || inputRow < 1 || inputRow > expectedInputRows) {
          throw new CellStateLineageError('空值来源清单行号无效')
        }
        if (row[3] !== '缺字段已补为空文本' && row[3] !== '显式 null 已转为空文本') continue
        pending.push([inputRow, row[2]!, origin, row[3]!])
        if (pending.length >= 1000) { store(pending); pending = [] }
      }
      if (!sawHeader) throw new CellStateLineageError('空值来源清单为空')
      if (pending.length) store(pending)
    } finally { stateInput.source.destroy(); stateInput.parser.destroy() }
    const lookup = db.prepare('SELECT field,origin_row,reason FROM states WHERE input_row=? ORDER BY field')
    const mapping = parseFile(rowMap)
    let outputRow = 0, stateRows = 0
    try {
      for await (const row of mapping.parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
        const output = Number(row[0]), input = Number(row[1])
        if (row.length !== 2 || !Number.isSafeInteger(output) || output !== ++outputRow ||
          !Number.isSafeInteger(input) || input < 1 || input > expectedInputRows) {
          throw new CellStateLineageError('筛选结果行号映射无效')
        }
        for (const state of lookup.all(input) as { field: string; origin_row: number; reason: string }[]) {
          if (!writer) {
            writer = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
            if (!writer.write(csvLine(['源记录号', '输出行号', '字段', '转换说明']))) await once(writer, 'drain')
          }
          if (!writer.write(csvLine([String(state.origin_row), String(output), state.field, state.reason]))) await once(writer, 'drain')
          stateRows += 1
        }
      }
      if (outputRow !== expectedOutputRows) throw new CellStateLineageError('筛选结果行号映射数量不一致')
      await closeWriter()
      return stateRows ? { file: 'cell-states.csv', rows: stateRows } : undefined
    } finally { mapping.source.destroy(); mapping.parser.destroy() }
  } catch (error) { abortWriter(); throw error }
  finally { db.close(); await rm(scratchPath, { force: true }) }
}

/** 单元格修正不改变行号；被实际改写的空值不再沿用旧的缺字段或 null 来源。 */
export async function copyCellStatesForEdits(sourceReport: string, outputPath: string, headers: string[],
  edits: { rowIndex: number; columnIndex: number; expectedOldValue: string; newValue: string }[],
  expectedRows: number, signal?: AbortSignal) {
  const replaced = new Set(edits.filter((item) => item.expectedOldValue !== item.newValue)
    .map((item) => `${item.rowIndex + 1}:${headers[item.columnIndex]}`))
  const source = createReadStream(sourceReport, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  let writer: ReturnType<typeof createWriteStream> | null = null
  const closeWriter = async () => { if (writer) { writer.end(); await finished(writer) } }
  const abortWriter = () => { writer?.destroy() }
  let sawHeader = false, stateRows = 0
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
      if (!sawHeader) {
        sawHeader = true
        if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
          throw new CellStateLineageError('空值来源清单格式无效')
        }
        continue
      }
      const origin = Number(row[0]), outputRow = Number(row[1])
      if (row.length !== 4 || !Number.isSafeInteger(origin) || origin < 1 ||
        !Number.isSafeInteger(outputRow) || outputRow < 1 || outputRow > expectedRows) {
        throw new CellStateLineageError('空值来源清单行号无效')
      }
      if (row[3] !== '缺字段已补为空文本' && row[3] !== '显式 null 已转为空文本') continue
      if (replaced.has(`${outputRow}:${row[2]}`)) continue
      if (!writer) {
        writer = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
        if (!writer.write(csvLine(['源记录号', '输出行号', '字段', '转换说明']))) await once(writer, 'drain')
      }
      if (!writer.write(csvLine(row))) await once(writer, 'drain')
      stateRows += 1
    }
    if (!sawHeader) throw new CellStateLineageError('空值来源清单为空')
    await closeWriter()
    return stateRows ? { file: 'cell-states.csv', rows: stateRows } : undefined
  } catch (error) { abortWriter(); throw error }
  finally { source.destroy(); parser.destroy() }
}

/** 严格合并和共同字段合并按输入顺序拼接记录；保留仍在输出中的字段状态。 */
export async function mergeCellStates(inputs: { reportPath?: string; rowCount: number; headers: string[] }[], outputHeaders: string[],
  outputPath: string, includeAbsentFields = false, signal?: AbortSignal) {
  const keptFields = new Set(outputHeaders)
  let writer: ReturnType<typeof createWriteStream> | null = null
  const closeWriter = async () => { if (writer) { writer.end(); await finished(writer) } }
  const abortWriter = () => { writer?.destroy() }
  let offset = 0, stateRows = 0
  const writeState = async (row: string[]) => {
    if (!writer) {
      writer = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
      if (!writer.write(csvLine(['源记录号', '输出行号', '字段', '转换说明']))) await once(writer, 'drain')
    }
    if (!writer.write(csvLine(row))) await once(writer, 'drain')
    stateRows += 1
  }
  try {
    for (const input of inputs) {
      if (input.reportPath) {
        const source = createReadStream(input.reportPath, { signal })
        const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
        source.on('error', (error) => parser.destroy(error))
        source.pipe(parser)
        let sawHeader = false
        try {
          for await (const row of parser as AsyncIterable<string[]>) {
            if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
            if (!sawHeader) {
              sawHeader = true
              if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
                throw new CellStateLineageError('空值来源清单格式无效')
              }
              continue
            }
            const sourceRow = Number(row[1])
            if (row.length !== 4 || !Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > input.rowCount) {
              throw new CellStateLineageError('空值来源清单行号无效')
            }
            if (!keptFields.has(row[2]!) || row[3] !== '缺字段已补为空文本' && row[3] !== '显式 null 已转为空文本') continue
            const mergedRow = offset + sourceRow
            await writeState([String(mergedRow), String(mergedRow), row[2]!, row[3]!])
          }
          if (!sawHeader) throw new CellStateLineageError('空值来源清单为空')
        } finally { source.destroy(); parser.destroy() }
      }
      if (includeAbsentFields) {
        const absent = outputHeaders.filter((field) => !input.headers.includes(field))
        if (input.rowCount * absent.length > 10_000_000 - stateRows) {
          throw new CellStateLineageError('并集补空位置超过 1000 万处，请减少输入行数或改用共同字段')
        }
        for (let row = 1; row <= input.rowCount; row += 1) {
          if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
          const mergedRow = offset + row
          for (const field of absent) await writeState([String(mergedRow), String(mergedRow), field, '缺字段已补为空文本'])
        }
      }
      offset += input.rowCount
    }
    await closeWriter()
    return stateRows ? { file: 'cell-states.csv', rows: stateRows } : undefined
  } catch (error) { abortWriter(); throw error }
}

/** 横向拼接保留各输入相同行号的状态；短表尾部补出的空单元格记为缺字段。 */
export async function horizontalCellStates(inputs: { reportPath?: string; rowCount: number; headers: string[] }[],
  outputHeaders: string[], outputRows: number, outputPath: string, signal?: AbortSignal) {
  let writer: ReturnType<typeof createWriteStream> | null = null
  const closeWriter = async () => { if (writer) { writer.end(); await finished(writer) } }
  const abortWriter = () => { writer?.destroy() }
  let stateRows = 0, columnOffset = 0
  const writeState = async (row: number, field: string, reason: string) => {
    if (!writer) {
      writer = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
      if (!writer.write(csvLine(['源记录号', '输出行号', '字段', '转换说明']))) await once(writer, 'drain')
    }
    if (!writer.write(csvLine([String(row), String(row), field, reason]))) await once(writer, 'drain')
    stateRows += 1
  }
  try {
    for (const input of inputs) {
      const outputFields = outputHeaders.slice(columnOffset, columnOffset + input.headers.length)
      if (outputFields.length !== input.headers.length) throw new CellStateLineageError('横向拼接字段映射不一致')
      const renamed = new Map(input.headers.map((field, index) => [field, outputFields[index]!] as const))
      if (renamed.size !== input.headers.length) throw new CellStateLineageError('横向拼接输入字段名重复，无法追溯空值来源')
      if (input.reportPath) {
        const source = createReadStream(input.reportPath, { signal })
        const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
        source.on('error', (error) => parser.destroy(error))
        source.pipe(parser)
        let sawHeader = false
        try {
          for await (const row of parser as AsyncIterable<string[]>) {
            if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
            if (!sawHeader) {
              sawHeader = true
              if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
                throw new CellStateLineageError('空值来源清单格式无效')
              }
              continue
            }
            const sourceRow = Number(row[1])
            if (row.length !== 4 || !Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > input.rowCount) {
              throw new CellStateLineageError('横向拼接空值来源记录无效')
            }
            if (row[3] !== '缺字段已补为空文本' && row[3] !== '显式 null 已转为空文本') continue
            const outputField = renamed.get(row[2]!)
            if (!outputField) throw new CellStateLineageError('横向拼接来源字段不在输出中')
            await writeState(sourceRow, outputField, row[3]!)
          }
          if (!sawHeader) throw new CellStateLineageError('空值来源清单为空')
        } finally { source.destroy(); parser.destroy() }
      }
      if ((outputRows - input.rowCount) * outputFields.length > 10_000_000 - stateRows) {
        throw new CellStateLineageError('横向补空位置超过 1000 万处，请先筛选输入或要求行数相同')
      }
      for (let row = input.rowCount + 1; row <= outputRows; row += 1) {
        if (signal?.aborted) throw new CellStateLineageError('空值来源处理已取消')
        for (const field of outputFields) await writeState(row, field, '缺字段已补为空文本')
      }
      columnOffset += input.headers.length
    }
    if (columnOffset !== outputHeaders.length) throw new CellStateLineageError('横向拼接结果字段数量不一致')
    await closeWriter()
    return stateRows ? { file: 'cell-states.csv', rows: stateRows } : undefined
  } catch (error) { abortWriter(); throw error }
}

/** 在 qsv 的逐字段统计后附加原始缺字段与显式 null 数量；两者仍计入原有空文本统计。 */
export async function appendCellStateCountsToStats(statsPath: string, outputPath: string,
  sourceReport: string | undefined, headers: string[], expectedRows: number, signal?: AbortSignal,
  sourceUnavailable = false) {
  const counts = headers.map(() => ({ missing: 0, explicitNull: 0 }))
  if (sourceReport) {
    if (new Set(headers).size !== headers.length) throw new CellStateLineageError('来源字段名重复，无法统计缺字段与显式 null')
    const positions = new Map(headers.map((name, index) => [name, index] as const))
    const source = createReadStream(sourceReport, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    let sawHeader = false
    try {
      for await (const row of parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new CellStateLineageError('空值统计已取消')
        if (!sawHeader) {
          sawHeader = true
          if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
            throw new CellStateLineageError('空值来源清单格式无效')
          }
          continue
        }
        const sourceRow = Number(row[1])
        if (row.length !== 4 || !Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > expectedRows) {
          throw new CellStateLineageError('空值来源清单行号无效')
        }
        const position = positions.get(row[2]!)
        if (position === undefined) continue
        if (row[3] === '缺字段已补为空文本') counts[position]!.missing += 1
        if (row[3] === '显式 null 已转为空文本') counts[position]!.explicitNull += 1
      }
      if (!sawHeader) throw new CellStateLineageError('空值来源清单为空')
    } finally { source.destroy(); parser.destroy() }
  }
  const source = createReadStream(statsPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  let sawHeader = false, rows = 0
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CellStateLineageError('空值统计已取消')
      if (!sawHeader) {
        sawHeader = true
        if (row[0] !== 'field') throw new CellStateLineageError('逐字段统计结果缺少字段名')
        if (!output.write(csvLine([...row, '原缺字段数', '原显式null数']))) await once(output, 'drain')
        continue
      }
      if (rows >= headers.length || row[0] !== headers[rows]) throw new CellStateLineageError('逐字段统计顺序与输入字段不一致')
      const count = counts[rows]!
      if (!output.write(csvLine([...row, sourceUnavailable ? '不可追溯' : String(count.missing),
        sourceUnavailable ? '不可追溯' : String(count.explicitNull)]))) await once(output, 'drain')
      rows += 1
    }
    if (!sawHeader || rows !== headers.length) throw new CellStateLineageError('逐字段统计行数与输入字段不一致')
    output.end(); await finished(output)
  } catch (error) { output.destroy(); throw error }
  finally { source.destroy(); parser.destroy() }
}
