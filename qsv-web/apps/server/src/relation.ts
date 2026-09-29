import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'
import Database from 'better-sqlite3'

export interface RelationConfig {
  kind: 'inner' | 'left' | 'right' | 'full' | 'left-semi' | 'left-anti'
  leftKeyIds: string[]
  rightKeyIds: string[]
  cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'
  keyType?: 'text' | 'decimal'
  matchEmptyKeys?: boolean
  trimKeys?: boolean
  ignoreCase?: boolean
  unicodeNormalization?: 'none' | 'nfc' | 'nfkc'
  output?: { columns: { side: 'left' | 'right'; id: string }[]; leftSuffix: string; rightSuffix: string; includeSourceRows: boolean }
}
export class RelationError extends Error {}

function column(id: string) { return Number(id.slice(2)) }
function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(row: string[]) { return `${row.map(csvCell).join(',')}\n` }

function relationKeyValues(row: string[], ids: string[], config: RelationConfig) {
  return ids.map((id) => {
    let value = row[column(id)] ?? ''
    if (config.trimKeys) value = value.trim()
    if (!value || config.keyType !== 'decimal') {
      if (config.unicodeNormalization && config.unicodeNormalization !== 'none') value = value.normalize(config.unicodeNormalization.toUpperCase())
      if (config.ignoreCase) value = value.toLowerCase()
      return value
    }
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value)
    if (!match) throw new RelationError(`关联键“${id}”包含无法按十进制数解析的值`)
    const integer = match[2]!.replace(/^0+(?=\d)/u, '')
    const fractional = (match[3] ?? '').replace(/0+$/u, '')
    return `${match[1] === '-' && (integer !== '0' || fractional) ? '-' : ''}${integer}${fractional ? `.${fractional}` : ''}`
  })
}

export function validateRelationConfig(config: RelationConfig, leftWidth: number, rightWidth: number) {
  const valid = (id: unknown, width: number) => typeof id === 'string' && /^c_(\d+)$/u.test(id) && column(id) < width
  if (!config || !['inner', 'left', 'right', 'full', 'left-semi', 'left-anti'].includes(config.kind) ||
    !['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].includes(config.cardinality) ||
    !Array.isArray(config.leftKeyIds) || !Array.isArray(config.rightKeyIds) ||
    config.leftKeyIds.length < 1 || config.leftKeyIds.length > 4 ||
    config.leftKeyIds.length !== config.rightKeyIds.length ||
    (config.ignoreCase !== undefined && typeof config.ignoreCase !== 'boolean') ||
    (config.trimKeys !== undefined && typeof config.trimKeys !== 'boolean') ||
    (config.matchEmptyKeys !== undefined && typeof config.matchEmptyKeys !== 'boolean') ||
    (config.keyType !== undefined && !['text', 'decimal'].includes(config.keyType)) ||
    (config.unicodeNormalization !== undefined && !['none', 'nfc', 'nfkc'].includes(config.unicodeNormalization)) ||
    new Set(config.leftKeyIds).size !== config.leftKeyIds.length ||
    new Set(config.rightKeyIds).size !== config.rightKeyIds.length ||
    config.leftKeyIds.some((id) => !valid(id, leftWidth)) || config.rightKeyIds.some((id) => !valid(id, rightWidth))) {
    throw new RelationError('关联类型、匹配键或基数规则无效')
  }
  if (!config.output) throw new RelationError('请选择关联结果字段')
  if (config.output) {
    const output = config.output
    if (!Array.isArray(output.columns) || output.columns.length < 1 || output.columns.length > leftWidth + rightWidth ||
      !output.columns.every((entry) => entry && ['left', 'right'].includes(entry.side) &&
        valid(entry.id, entry.side === 'left' ? leftWidth : rightWidth) &&
        (!['left-semi', 'left-anti'].includes(config.kind) || entry.side === 'left')) ||
      new Set(output.columns.map((entry) => `${entry.side}:${entry.id}`)).size !== output.columns.length ||
      typeof output.includeSourceRows !== 'boolean' ||
      [output.leftSuffix, output.rightSuffix].some((value) => typeof value !== 'string' || value.length > 32 || /[\x00-\x1f]/u.test(value))) {
      throw new RelationError('关联输出字段或重名后缀无效')
    }
  }
}

/** 复制固定输入并附加源行号；同时用磁盘索引检查全部键的基数和输出膨胀。 */
export async function prepareRelation(leftPath: string, rightPath: string, leftPrepared: string, rightPrepared: string,
  indexPath: string, config: RelationConfig, expectedLeft: number, expectedRight: number, signal?: AbortSignal,
  unmatchedReports?: { leftPath: string; rightPath: string }) {
  const preparedKeys = config.keyType === 'decimal' || config.trimKeys || config.ignoreCase ||
    config.unicodeNormalization && config.unicodeNormalization !== 'none'
  const db = new Database(indexPath)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE keys (key TEXT PRIMARY KEY, left_count INTEGER NOT NULL DEFAULT 0, right_count INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID')
  const insertLeft = db.prepare('INSERT INTO keys(key,left_count,right_count) VALUES (?,1,0) ON CONFLICT(key) DO UPDATE SET left_count=left_count+1')
  const insertRight = db.prepare('INSERT INTO keys(key,left_count,right_count) VALUES (?,0,1) ON CONFLICT(key) DO UPDATE SET right_count=right_count+1')
  const addBatch = db.transaction((keys: string[], side: 'left' | 'right') => {
    const stmt = side === 'left' ? insertLeft : insertRight
    for (const key of keys) stmt.run(key)
  })
  const prepareOne = async (inputPath: string, outputPath: string, side: 'left' | 'right', keyIds: string[], expectedRows: number) => {
    const source = createReadStream(inputPath, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    const write = async (value: string) => { if (!output.write(value)) await once(output, 'drain') }
    let headers: string[] | null = null
    let rows = 0
    let pending: string[] = []
    let pendingBytes = 0
    try {
      for await (const row of parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new RelationError('关联已取消')
        if (!headers) {
          headers = row
          await write(csvLine([...row.map((_, index) => `${side}_c_${index}`), `__${side}_source_row__`,
            ...(preparedKeys ? keyIds.map((_, index) => `__${side}_join_key_${index}__`) : [])]))
          continue
        }
        rows += 1
        if (row.length !== headers.length) throw new RelationError(`${side} 第 ${rows} 行字段数不一致`)
        const values = relationKeyValues(row, keyIds, config)
        if (config.matchEmptyKeys || values.every((value) => value !== '')) {
          const key = JSON.stringify(values)
          const bytes = Buffer.byteLength(key, 'utf8')
          if (bytes > 8192) throw new RelationError('关联键超过 8 KiB，无法完成全量基数检查')
          pending.push(key); pendingBytes += bytes
        }
        if (pending.length >= 1000 || pendingBytes >= 2 * 1024 * 1024) { addBatch(pending, side); pending = []; pendingBytes = 0 }
        await write(csvLine([...row, String(rows).padStart(16, '0'),
          ...(config.keyType === 'decimal' ? values.map((value) => value ? `D:${value}` : '') :
            preparedKeys ? values : [])]))
      }
      if (!headers) throw new RelationError(`${side} 输入缺少表头`)
      if (pending.length) addBatch(pending, side)
      if (rows !== expectedRows) throw new RelationError(`${side} 输入行数与资源记录不一致`)
      output.end()
      await finished(output)
      return headers.length + 1
    } catch (error) { output.destroy(); throw error }
    finally { source.destroy(); parser.destroy() }
  }
  const writeUnmatched = async (inputPath: string, reportPath: string, side: 'left' | 'right', keyIds: string[], expectedRows: number) => {
    const source = createReadStream(inputPath, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    const output = createWriteStream(reportPath, { flags: 'wx', mode: 0o600 })
    const lookup = db.prepare(`SELECT ${side === 'left' ? 'right_count' : 'left_count'} AS opposite_count FROM keys WHERE key=?`)
    let rows = 0, unmatched = 0, width = 0
    try {
      if (!output.write(csvLine(['来源行号', '未匹配原因', '匹配键 JSON', '输入记录 JSON']))) await once(output, 'drain')
      for await (const row of parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new RelationError('关联已取消')
        if (!width) { width = row.length; continue }
        rows += 1
        if (row.length !== width) throw new RelationError(`${side} 第 ${rows} 行字段数不一致`)
        const values = relationKeyValues(row, keyIds, config)
        const empty = !config.matchEmptyKeys && values.some((value) => value === '')
        const key = JSON.stringify(values)
        const match = empty ? null : lookup.get(key) as { opposite_count: number } | undefined
        if (empty || !match?.opposite_count) {
          if (!output.write(csvLine([String(rows), empty ? '键为空' : '另一侧无对应键', key, JSON.stringify(row)]))) await once(output, 'drain')
          unmatched += 1
        }
      }
      if (!width || rows !== expectedRows) throw new RelationError(`${side} 未匹配清单输入行数不一致`)
      output.end(); await finished(output)
      return unmatched
    } catch (error) { output.destroy(); throw error }
    finally { source.destroy(); parser.destroy() }
  }
  try {
    const leftWidth = await prepareOne(leftPath, leftPrepared, 'left', config.leftKeyIds, expectedLeft)
    const rightWidth = await prepareOne(rightPath, rightPrepared, 'right', config.rightKeyIds, expectedRight)
    const counts = db.prepare(`SELECT COALESCE(SUM(left_count*right_count),0) AS matched,
      COALESCE(SUM(CASE WHEN right_count>0 THEN left_count ELSE 0 END),0) AS matched_left,
      COALESCE(SUM(CASE WHEN left_count>0 THEN right_count ELSE 0 END),0) AS matched_right,
      COALESCE(MAX(left_count),0) AS max_left,COALESCE(MAX(right_count),0) AS max_right FROM keys`).get() as {
        matched: number; matched_left: number; matched_right: number; max_left: number; max_right: number }
    if ((config.cardinality === 'one-to-one' || config.cardinality === 'one-to-many') && counts.max_left > 1 ||
      (config.cardinality === 'one-to-one' || config.cardinality === 'many-to-one') && counts.max_right > 1) {
      throw new RelationError('完整匹配键检查发现重复，违反所选的一对一或单侧唯一关系')
    }
    const unmatchedLeft = expectedLeft - counts.matched_left
    const unmatchedRight = expectedRight - counts.matched_right
    const expectedRows = config.kind === 'inner' ? counts.matched : config.kind === 'left' ? counts.matched + unmatchedLeft :
      config.kind === 'right' ? counts.matched + unmatchedRight : config.kind === 'full' ? counts.matched + unmatchedLeft + unmatchedRight :
        config.kind === 'left-semi' ? counts.matched_left : unmatchedLeft
    if (!Number.isSafeInteger(expectedRows) || expectedRows > 10_000_000) {
      throw new RelationError('预计关联结果超过 1000 万行上限，请缩小输入或收紧匹配键')
    }
    if (unmatchedReports) {
      const leftCount = await writeUnmatched(leftPath, unmatchedReports.leftPath, 'left', config.leftKeyIds, expectedLeft)
      const rightCount = await writeUnmatched(rightPath, unmatchedReports.rightPath, 'right', config.rightKeyIds, expectedRight)
      if (leftCount !== unmatchedLeft || rightCount !== unmatchedRight) throw new RelationError('未匹配清单与全量基数检查不一致')
    }
    return { expectedRows, leftWidth, rightWidth, matchedPairs: counts.matched, unmatchedLeft, unmatchedRight }
  } finally { db.close() }
}

function relationOutputNames(config: RelationConfig, leftHeaders: string[], rightHeaders: string[]) {
  if (!config.output) throw new RelationError('关联输出配置缺失')
  const columns = config.output.columns
  const includeRightSource = !['left-semi', 'left-anti'].includes(config.kind)
  const rawNames = columns.map((entry) => (entry.side === 'left' ? leftHeaders : rightHeaders)[column(entry.id)] || `第 ${column(entry.id) + 1} 列`)
  const counts = new Map<string, number>()
  rawNames.forEach((name) => counts.set(name, (counts.get(name) ?? 0) + 1))
  const used = new Set<string>()
  const outputNames = rawNames.map((name, index) => {
    const side = columns[index]!.side
    const base = (counts.get(name) ?? 0) > 1 ? `${name}${side === 'left' ? config.output!.leftSuffix : config.output!.rightSuffix}` : name
    let candidate = base, sequence = 2
    while (used.has(candidate)) candidate = `${base}_${sequence++}`
    used.add(candidate)
    return candidate
  })
  if (config.output.includeSourceRows) {
    for (const name of includeRightSource ? ['左表来源行号', '右表来源行号'] : ['左表来源行号']) {
      let candidate = name, sequence = 2
      while (used.has(candidate)) candidate = `${name}_${sequence++}`
      used.add(candidate); outputNames.push(candidate)
    }
  }
  return outputNames
}

export async function projectRelationOutput(inputPath: string, outputPath: string, config: RelationConfig,
  leftHeaders: string[], rightHeaders: string[], expectedRows: number, signal?: AbortSignal) {
  if (!config.output) throw new RelationError('关联输出配置缺失')
  validateRelationConfig(config, leftHeaders.length, rightHeaders.length)
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const write = async (row: string[]) => { if (!output.write(csvLine(row))) await once(output, 'drain') }
  const columns = config.output.columns
  const includeRightSource = !['left-semi', 'left-anti'].includes(config.kind)
  const outputNames = relationOutputNames(config, leftHeaders, rightHeaders)
  let positions: number[] | null = null, rows = 0, width = 0
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new RelationError('关联已取消')
      if (!positions) {
        width = row.length
        positions = columns.map((entry) => row.indexOf(`${entry.side}_c_${column(entry.id)}`))
        if (positions.some((position) => position < 0)) throw new RelationError('关联结果缺少所选输出字段')
        if (config.output.includeSourceRows) {
          const left = row.indexOf('__left_source_row__')
          const right = includeRightSource ? row.indexOf('__right_source_row__') : -1
          if (left < 0 || includeRightSource && right < 0) throw new RelationError('关联结果缺少来源行号')
          positions.push(left)
          if (includeRightSource) positions.push(right)
        }
        await write(outputNames)
        continue
      }
      rows += 1
      if (row.length !== width) throw new RelationError(`关联结果第 ${rows} 行字段数不一致`)
      const values = positions.map((position) => row[position]!)
      if (config.output.includeSourceRows) {
        for (let index = values.length - (includeRightSource ? 2 : 1); index < values.length; index += 1) {
          if (values[index]) values[index] = String(Number(values[index]))
        }
      }
      await write(values)
    }
    if (!positions || rows !== expectedRows) throw new RelationError('关联输出行数与预检不一致')
    output.end(); await finished(output)
    return { rows, headers: outputNames }
  } catch (error) { output.destroy(); throw error }
  finally { source.destroy(); parser.destroy() }
}

/** 根据 joinp 保留的两侧来源行号，为选出的结果字段保留空值来源。 */
export async function relationCellStates(inputPath: string, outputPath: string, config: RelationConfig,
  leftHeaders: string[], rightHeaders: string[], inputReports: (string | undefined)[],
  expectedLeftRows: number, expectedRightRows: number, expectedOutputRows: number, signal?: AbortSignal) {
  if (!config.output) throw new RelationError('关联输出配置缺失')
  const scratchPath = `${outputPath}.lookup.sqlite`
  const db = new Database(scratchPath)
  const openCsv = (path: string) => {
    const source = createReadStream(path, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    return { source, parser }
  }
  let output: ReturnType<typeof createWriteStream> | null = null
  let stateRows = 0
  try {
    db.pragma('journal_mode = OFF')
    db.pragma('synchronous = OFF')
    db.exec('CREATE TABLE states (side TEXT NOT NULL, source_row INTEGER NOT NULL, field TEXT NOT NULL, origin_row INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(side,source_row,field)) WITHOUT ROWID')
    const insert = db.prepare('INSERT INTO states(side,source_row,field,origin_row,reason) VALUES (?,?,?,?,?)')
    const store = db.transaction((rows: [string, number, string, number, string][]) => {
      for (const row of rows) insert.run(...row)
    })
    for (const [sideIndex, report] of inputReports.entries()) {
      if (!report) continue
      const side = sideIndex === 0 ? 'left' : 'right'
      const expected = sideIndex === 0 ? expectedLeftRows : expectedRightRows
      const input = openCsv(report)
      let sawHeader = false
      let pending: [string, number, string, number, string][] = []
      try {
        for await (const row of input.parser as AsyncIterable<string[]>) {
          if (signal?.aborted) throw new RelationError('关联空值来源处理已取消')
          if (!sawHeader) {
            sawHeader = true
            if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
              throw new RelationError('关联输入的空值来源清单格式无效')
            }
            continue
          }
          const origin = Number(row[0]), sourceRow = Number(row[1])
          if (row.length !== 4 || !Number.isSafeInteger(origin) || origin < 1 ||
            !Number.isSafeInteger(sourceRow) || sourceRow < 1 || sourceRow > expected) {
            throw new RelationError('关联输入的空值来源行号无效')
          }
          if (row[3] !== '缺字段已补为空文本' && row[3] !== '显式 null 已转为空文本') continue
          pending.push([side, sourceRow, row[2]!, origin, row[3]!])
          if (pending.length >= 1000) { store(pending); pending = [] }
        }
        if (!sawHeader) throw new RelationError('关联输入的空值来源清单为空')
        if (pending.length) store(pending)
      } finally { input.source.destroy(); input.parser.destroy() }
    }
    const states = db.prepare('SELECT field,origin_row,reason FROM states WHERE side=? AND source_row=?')
    const source = openCsv(inputPath)
    const columns = config.output.columns
    const outputNames = relationOutputNames(config, leftHeaders, rightHeaders)
    const expected = [expectedLeftRows, expectedRightRows]
    let header: string[] | null = null, outputRow = 0, leftAt = -1, rightAt = -1
    const writeState = async (origin: number, row: number, field: string, reason: string) => {
      if (stateRows >= 10_000_000) throw new RelationError('关联结果的空值来源超过 1000 万处，请缩小结果范围')
      if (!output) {
        output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
        if (!output.write(csvLine(['源记录号', '输出行号', '字段', '转换说明']))) await once(output, 'drain')
      }
      if (!output.write(csvLine([String(origin), String(row), field, reason]))) await once(output, 'drain')
      stateRows += 1
    }
    try {
      for await (const row of source.parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new RelationError('关联空值来源处理已取消')
        if (!header) {
          header = row
          leftAt = row.indexOf('__left_source_row__')
          rightAt = row.indexOf('__right_source_row__')
          if (leftAt < 0 || rightAt < 0 && !['left-semi', 'left-anti'].includes(config.kind)) {
            throw new RelationError('关联结果缺少来源行号')
          }
          continue
        }
        outputRow += 1
        if (row.length !== header.length) throw new RelationError('关联结果字段数不一致')
        const sourceRows = [Number(row[leftAt] || 0), rightAt < 0 ? 0 : Number(row[rightAt] || 0)]
        for (let index = 0; index < sourceRows.length; index += 1) {
          const sourceRow = sourceRows[index]!
          if (!Number.isSafeInteger(sourceRow) || sourceRow < 0 || sourceRow > expected[index]!) {
            throw new RelationError('关联结果来源行号无效')
          }
        }
        const existing = sourceRows.map((sourceRow, index) => sourceRow
          ? new Map((states.all(index === 0 ? 'left' : 'right', sourceRow) as {
            field: string; origin_row: number; reason: string }[]).map((state) => [state.field, state] as const))
          : new Map<string, { field: string; origin_row: number; reason: string }>())
        for (let index = 0; index < columns.length; index += 1) {
          const selected = columns[index]!
          const sideIndex = selected.side === 'left' ? 0 : 1
          const sourceRow = sourceRows[sideIndex]!
          const outputField = outputNames[index]!
          if (!sourceRow) {
            await writeState(outputRow, outputRow, outputField, '缺字段已补为空文本')
          } else {
            const field = (sideIndex === 0 ? leftHeaders : rightHeaders)[column(selected.id)]!
            const state = existing[sideIndex]!.get(field)
            if (state) await writeState(state.origin_row, outputRow, outputField, state.reason)
          }
        }
      }
      if (!header || outputRow !== expectedOutputRows) throw new RelationError('关联结果行数与空值来源处理不一致')
      if (output) { output.end(); await finished(output) }
      return stateRows ? { file: 'cell-states.csv', rows: stateRows } : undefined
    } finally { source.source.destroy(); source.parser.destroy() }
  } catch (error) { output?.destroy(); throw error }
  finally { db.close(); await rm(scratchPath, { force: true }) }
}

/** 只读两侧开头的少量记录；返回值明确标记样本范围，不推断完整关联结果。 */
export async function sampleRelation(leftPath: string, rightPath: string, config: RelationConfig,
  leftHeaders: string[], rightHeaders: string[], signal?: AbortSignal) {
  if (!config.output) throw new RelationError('关联样本缺少输出配置')
  validateRelationConfig(config, leftHeaders.length, rightHeaders.length)
  const readSample = async (path: string, expectedWidth: number) => {
    const source = createReadStream(path, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    const result: string[][] = []
    let bytes = 0, headerSeen = false
    try {
      for await (const row of parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new RelationError('关联样本已取消')
        if (row.length !== expectedWidth) throw new RelationError('关联样本字段数与数据集不一致')
        if (!headerSeen) { headerSeen = true; continue }
        bytes += Buffer.byteLength(JSON.stringify(row), 'utf8')
        if (bytes > 2 * 1024 * 1024) throw new RelationError('前 20 行样本超过 2 MiB，无法显示关联样本')
        result.push(row)
        if (result.length >= 20) break
      }
      if (!headerSeen) throw new RelationError('关联样本缺少表头')
      return result
    } finally { source.destroy(); parser.destroy() }
  }
  const leftRows = await readSample(leftPath, leftHeaders.length)
  const rightRows = await readSample(rightPath, rightHeaders.length)
  const keyFor = (row: string[], ids: string[]) => {
    const values = relationKeyValues(row, ids, config)
    return !config.matchEmptyKeys && values.some((value) => value === '') ? null : JSON.stringify(values)
  }
  const rightKeys = rightRows.map((row) => keyFor(row, config.rightKeyIds))
  const matchedRight = new Set<number>()
  const rows: string[][] = []
  const append = (left: string[] | null, right: string[] | null, leftRow: number | null, rightRow: number | null) => {
    if (rows.length >= 20) return
    const values = config.output!.columns.map((entry) => (entry.side === 'left' ? left : right)?.[column(entry.id)] ?? '')
    if (config.output!.includeSourceRows) {
      values.push(leftRow === null ? '' : String(leftRow))
      if (config.kind !== 'left-semi' && config.kind !== 'left-anti') values.push(rightRow === null ? '' : String(rightRow))
    }
    rows.push(values)
  }
  for (const [leftIndex, leftRow] of leftRows.entries()) {
    const key = keyFor(leftRow, config.leftKeyIds)
    const matches = key === null ? [] : rightKeys.flatMap((rightKey, index) => rightKey === key ? [index] : [])
    matches.forEach((index) => matchedRight.add(index))
    if (config.kind === 'left-semi') { if (matches.length) append(leftRow, null, leftIndex + 1, null); continue }
    if (config.kind === 'left-anti') { if (!matches.length) append(leftRow, null, leftIndex + 1, null); continue }
    if (matches.length) for (const rightIndex of matches) append(leftRow, rightRows[rightIndex]!, leftIndex + 1, rightIndex + 1)
    else if (config.kind === 'left' || config.kind === 'full') append(leftRow, null, leftIndex + 1, null)
  }
  if (config.kind === 'right' || config.kind === 'full') for (const [index, row] of rightRows.entries()) {
    if (!matchedRight.has(index)) append(null, row, null, index + 1)
  }
  const headers = relationOutputNames(config, leftHeaders, rightHeaders)
  return { scope: '左、右输入各前 20 行；仅展示其中能够形成的关联', leftSampleRows: leftRows.length,
    rightSampleRows: rightRows.length, headers: headers.slice(0, 30), rows: rows.map((row) => row.slice(0, 30)
      .map((value) => value.length > 256 ? `${value.slice(0, 256)}…` : value)), columnCount: headers.length,
    columnsTruncated: headers.length > 30, sampleRows: rows.length, totalKnown: false as const }
}
