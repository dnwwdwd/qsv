import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'
import { ianaLocalTimestamp } from './transform.ts'

export type CompareField = { leftColumnId: string; rightColumnId: string;
  mode: 'text' | 'decimal' | 'calendar-date' | 'instant'; tolerance?: string; relativeTolerance?: string;
  textTrim?: boolean; textIgnoreCase?: boolean; unicode?: 'none' | 'NFC' | 'NFKC';
  dayTolerance?: number; timeToleranceSeconds?: number; leftTimeZone?: string; rightTimeZone?: string }
export type CompareConfig = {
  leftKeyIds: string[]; rightKeyIds: string[]; fields: CompareField[]
  trimKeys: boolean; ignoreKeyCase: boolean
  leftLabel?: string; rightLabel?: string
  duplicatePolicy?: 'isolate' | 'abort' | 'aggregate'
  aggregateMethods?: ('sum' | 'count')[]
  emptyValuePolicy?: 'mode-default' | 'match-both' | 'error'
  parseFailurePolicy?: 'isolate' | 'abort'
  contextLeftIds?: string[]; contextRightIds?: string[]
}

export type CompareSummary = {
  leftRows: number; rightRows: number; equalPairs: number; differentPairs: number; pairErrors: number
  leftOnly: number; rightOnly: number; leftInvalid: number; rightInvalid: number
  leftConflict: number; rightConflict: number; conflictGroups: number; differentFields: number; detailRows: number
  leftAggregatedExtra: number; rightAggregatedExtra: number
}
export class CompareError extends Error {}

function index(id: string) { return Number(id.slice(2)) }
function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvRow(values: string[]) { return `${values.map(csvCell).join(',')}\n` }

function keyFor(row: string[], indices: number[], trim: boolean, ignoreCase: boolean, rowNumber: number) {
  const values = indices.map((column) => {
    const original = row[column] ?? ''
    const adjusted = trim ? original.trim() : original
    return ignoreCase ? adjusted.toLowerCase() : adjusted
  })
  if (values.some((value) => value === '')) return `~${String(rowNumber).padStart(16, '0')}`
  return JSON.stringify(values)
}

/** 为外排序加碰撞安全的复合键与源行号；原字段值保持不变。 */
export async function prepareCompareInput(inputPath: string, outputPath: string, keyIds: string[],
  trimKeys: boolean, ignoreKeyCase: boolean, signal?: AbortSignal) {
  const keyIndices = keyIds.map(index)
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  let width = 0
  let records = 0
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      if (records === 0) {
        width = row.length
        if (keyIndices.some((column) => column < 0 || column >= width)) throw new Error('核对键字段无效')
        records += 1
        callback(null, csvRow(['__compare_key__', '__source_row__', ...row]))
        return
      }
      if (row.length !== width) throw new Error(`第 ${records} 行字段数不一致`)
      const key = keyFor(row, keyIndices, trimKeys, ignoreKeyCase, records)
      callback(null, csvRow([key, String(records), ...row]))
      records += 1
    } catch (error) { callback(error as Error) }
  } })
  await pipeline(createReadStream(inputPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
  if (records < 1) throw new Error('核对输入缺少表头')
  return records - 1
}

type PreparedRow = { key: string; sourceRow: number; values: string[] }

async function* preparedRows(path: string, signal?: AbortSignal): AsyncGenerator<PreparedRow> {
  const source = createReadStream(path)
  const parser = source.pipe(parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 }))
  source.on('error', (error) => parser.destroy(error))
  const abort = () => { source.destroy(new Error('任务已取消')); parser.destroy(new Error('任务已取消')) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    let first = true
    let width = 0
    for await (const record of parser) {
      const row = record as string[]
      if (first) { first = false; width = row.length; continue }
      if (row.length !== width || width < 3) throw new Error('核对排序文件的字段数无效')
      const sourceRow = Number(row[1])
      if (!Number.isSafeInteger(sourceRow) || sourceRow < 1) throw new Error('核对排序文件的源行号无效')
      yield { key: row[0]!, sourceRow, values: row.slice(2) }
    }
  } finally { signal?.removeEventListener('abort', abort); source.destroy(); parser.destroy() }
}

class GroupReader {
  private pending: PreparedRow | null = null
  private readonly iterator: AsyncIterator<PreparedRow>
  constructor(iterator: AsyncIterator<PreparedRow>) { this.iterator = iterator }
  async next() {
    const first = this.pending ?? (await this.iterator.next()).value ?? null
    this.pending = null
    if (!first) return null
    const rows = [first]
    let bytes = Buffer.byteLength(JSON.stringify(first))
    while (true) {
      const next = (await this.iterator.next()).value ?? null
      if (!next) break
      if (next.key !== first.key) { this.pending = next; break }
      rows.push(next)
      bytes += Buffer.byteLength(JSON.stringify(next))
      if (rows.length > 512 || bytes > 2 * 1024 * 1024) throw new Error('同一核对键的记录超过单组预算')
    }
    return { key: first.key, rows }
  }
}

export async function inspectSortedKeys(path: string, keyIds: string[], expectedRows: number, signal?: AbortSignal) {
  const iterator = preparedRows(path, signal)[Symbol.asyncIterator]()
  const reader = new GroupReader(iterator)
  const indices = keyIds.map(index)
  const result = { rows: 0, emptyKeys: 0, duplicateGroups: 0, duplicateRows: 0,
    normalizedCollisionGroups: 0, samples: [] as { key: string; rows: number[]; rawKeys: string[] }[] }
  try {
    for (let group = await reader.next(); group; group = await reader.next()) {
      result.rows += group.rows.length
      if (group.key.startsWith('~')) { result.emptyKeys += group.rows.length; continue }
      if (group.rows.length < 2) continue
      result.duplicateGroups += 1
      result.duplicateRows += group.rows.length
      const rawKeys = [...new Set(group.rows.map((row) => JSON.stringify(indices.map((column) => row.values[column] ?? ''))))]
      if (rawKeys.length > 1) result.normalizedCollisionGroups += 1
      if (result.samples.length < 10) result.samples.push({ key: group.key.slice(0, 160),
        rows: group.rows.slice(0, 20).map((row) => row.sourceRow), rawKeys: rawKeys.slice(0, 4).map((value) => value.slice(0, 160)) })
    }
    if (result.rows !== expectedRows) throw new CompareError('核对键预检行数与输入数据集不一致')
    return result
  } finally { await iterator.return?.(undefined) }
}

function decimal(value: string) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value)
  if (!match) return null
  const fraction = match[3] ?? ''
  if (match[2]!.length + fraction.length > 38 || fraction.length > 18) return null
  const coefficient = BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`)
  return { coefficient, scale: fraction.length }
}

function decimalDifference(left: string, right: string, tolerance: string, relativeTolerance = '0') {
  const a = decimal(left)
  const b = decimal(right)
  const t = decimal(tolerance)
  const relative = decimal(relativeTolerance)
  if (!a || !b || !t || !relative || t.coefficient < 0n || relative.coefficient < 0n) return null
  const scale = Math.max(a.scale, b.scale, t.scale)
  const leftScaled = a.coefficient * (10n ** BigInt(scale - a.scale))
  const rightScaled = b.coefficient * (10n ** BigInt(scale - b.scale))
  const toleranceScaled = t.coefficient * (10n ** BigInt(scale - t.scale))
  const difference = leftScaled - rightScaled
  const absolute = difference < 0n ? -difference : difference
  const reference = [leftScaled, rightScaled].map((value) => value < 0n ? -value : value).reduce((max, value) => value > max ? value : max, 0n)
  const relativePass = absolute * 10n ** BigInt(relative.scale) <= reference * relative.coefficient
  const digits = absolute.toString().padStart(scale + 1, '0')
  const display = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
  return { equal: absolute <= toleranceScaled || relativePass, difference: display }
}

function decimalSum(values: string[]) {
  const parsed = values.map(decimal)
  if (parsed.some((value) => !value)) throw new CompareError('重复键聚合只支持有效十进制数；请检查原值或改用隔离策略')
  const scale = Math.max(0, ...parsed.map((value) => value!.scale))
  const sum = parsed.reduce((total, value) => total + value!.coefficient * 10n ** BigInt(scale - value!.scale), 0n)
  const negative = sum < 0n
  const digits = (negative ? -sum : sum).toString().padStart(scale + 1, '0')
  const result = `${negative ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`
  if (result.replace(/[^0-9]/gu, '').length > 38) throw new CompareError('重复键聚合结果超过 38 位十进制数限制')
  return result
}

function calendarDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return null
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null
  return Math.floor(date.getTime() / 86_400_000)
}

function instant(value: string, timeZone?: string) {
  if (timeZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(value)) {
    try { return instant(ianaLocalTimestamp(value, timeZone, 'UTC', 0)) } catch { return null }
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match || calendarDay(match[1]!) === null) return null
  const hour = Number(match[2]); const minute = Number(match[3]); const second = Number(match[4])
  if (hour > 23 || minute > 59 || second > 59) return null
  const offset = match[6] === 'Z' ? 0 : (match[6]![0] === '-' ? -1 : 1) *
    (Number(match[6]!.slice(1, 3)) * 60 + Number(match[6]!.slice(4, 6)))
  if (Math.abs(offset) > 14 * 60 || match[6] !== 'Z' && Number(match[6]!.slice(4, 6)) > 59) return null
  const milliseconds = (calendarDay(match[1]!)! * 86_400 + hour * 3600 + minute * 60 + second - offset * 60) * 1000 +
    Number((match[5] ?? '').padEnd(3, '0'))
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

function compareField(left: string, right: string, field: CompareField, emptyValuePolicy: CompareConfig['emptyValuePolicy']) {
  if ((left === '' || right === '') && emptyValuePolicy === 'error') {
    return { state: 'error', difference: '', reason: '比较字段含空值，按所选规则归为解析异常', leftNormalized: left, rightNormalized: right }
  }
  if ((left === '' || right === '') && emptyValuePolicy === 'match-both') {
    return { state: left === '' && right === '' ? 'equal' : 'different', difference: '',
      reason: left === '' && right === '' ? '两侧均为空值，按所选规则视为一致' : '只有一侧为空值，按所选规则视为差异',
      leftNormalized: left, rightNormalized: right }
  }
  if (field.mode === 'text') {
    const normalize = (value: string) => {
      const trimmed = field.textTrim ? value.trim() : value
      const unicode = field.unicode && field.unicode !== 'none' ? trimmed.normalize(field.unicode) : trimmed
      return field.textIgnoreCase ? unicode.toLowerCase() : unicode
    }
    const leftNormalized = normalize(left); const rightNormalized = normalize(right)
    return { state: leftNormalized === rightNormalized ? 'equal' : 'different', difference: '',
      reason: `文本比较；首尾空白${field.textTrim ? '忽略' : '保留'}，大小写${field.textIgnoreCase ? '忽略' : '区分'}，Unicode ${field.unicode ?? 'none'}`,
      leftNormalized, rightNormalized }
  }
  if (field.mode === 'decimal') {
    const result = decimalDifference(left, right, field.tolerance ?? '0', field.relativeTolerance ?? '0')
    if (!result) return { state: 'error', difference: '', reason: '数值不是受支持的十进制文本', leftNormalized: '', rightNormalized: '' }
    return { state: result.equal ? 'equal' : 'different', difference: result.difference,
      reason: `绝对差值 ≤ ${field.tolerance ?? '0'}，或 ≤ ${field.relativeTolerance ?? '0'} × max(|左值|,|右值|)；两值均为零时相对容差为零`,
      leftNormalized: left, rightNormalized: right }
  }
  if (field.mode === 'calendar-date') {
    const a = calendarDay(left); const b = calendarDay(right)
    if (a === null || b === null) return { state: 'error', difference: '', reason: '日历日期必须为有效的 YYYY-MM-DD', leftNormalized: '', rightNormalized: '' }
    const days = Math.abs(a - b)
    return { state: days <= (field.dayTolerance ?? 0) ? 'equal' : 'different', difference: String(days),
      reason: `相差日历日不超过 ${field.dayTolerance ?? 0} 天`, leftNormalized: left, rightNormalized: right }
  }
  const a = instant(left, field.leftTimeZone); const b = instant(right, field.rightTimeZone)
  if (a === null || b === null) return { state: 'error', difference: '', reason: '时间点须带明确偏移，或指定有效且唯一的本地时区时间', leftNormalized: '', rightNormalized: '' }
  const seconds = Math.abs(a - b) / 1000
  return { state: seconds <= (field.timeToleranceSeconds ?? 0) ? 'equal' : 'different', difference: String(seconds),
    reason: `按 UTC 时间点比较，相差不超过 ${field.timeToleranceSeconds ?? 0} 秒；无偏移输入时区：左 ${field.leftTimeZone ?? '未设置'}，右 ${field.rightTimeZone ?? '未设置'}`,
    leftNormalized: new Date(a).toISOString(), rightNormalized: new Date(b).toISOString() }
}

function newSummary(leftRows: number, rightRows: number): CompareSummary {
  return { leftRows, rightRows, equalPairs: 0, differentPairs: 0, pairErrors: 0, leftOnly: 0, rightOnly: 0,
    leftInvalid: 0, rightInvalid: 0, leftConflict: 0, rightConflict: 0, conflictGroups: 0, differentFields: 0,
    detailRows: 0, leftAggregatedExtra: 0, rightAggregatedExtra: 0 }
}

/** 按完整排序结果分组核对。每条输入记录只进入一个分类。 */
export async function compareSortedInputs(leftPath: string, rightPath: string, outputPath: string,
  config: CompareConfig, leftHeaders: string[], rightHeaders: string[], leftRows: number, rightRows: number,
  signal?: AbortSignal) {
  const summary = newSummary(leftRows, rightRows)
  const leftIterator = preparedRows(leftPath, signal)[Symbol.asyncIterator]()
  const rightIterator = preparedRows(rightPath, signal)[Symbol.asyncIterator]()
  const leftReader = new GroupReader(leftIterator)
  const rightReader = new GroupReader(rightIterator)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const write = async (row: string[]) => {
    if (signal?.aborted) throw new Error('任务已取消')
    if (!output.write(csvRow(row))) await once(output, 'drain')
    summary.detailRows += 1
  }
  const context = (category: string, row: PreparedRow | null, group: PreparedRow[], ids: string[] | undefined, headers: string[]) => {
    if (!ids?.length) return ''
    const rows = config.duplicatePolicy === 'aggregate' && ['equal', 'different', 'pair_error'].includes(category) && group.length
      ? group : row ? [row] : []
    return rows.length ? JSON.stringify(rows.map((member) => ({ row: member.sourceRow,
      fields: ids.map((id) => ({ id, name: headers[index(id)] ?? id, value: member.values[index(id)] ?? '' })) }))) : ''
  }
  const detail = (category: string, key: string, left: PreparedRow | null, right: PreparedRow | null,
    field = '', leftValue = '', rightValue = '', difference = '', reason = '', fieldState = '',
    leftNormalized = '', rightNormalized = '', leftGroup: PreparedRow[] = [], rightGroup: PreparedRow[] = []) =>
    [category, fieldState, key, left ? String(left.sourceRow) : '', right ? String(right.sourceRow) : '',
      field, leftValue, rightValue, leftNormalized, rightNormalized, difference, reason,
      leftGroup.map((row) => row.sourceRow).join(','), rightGroup.map((row) => row.sourceRow).join(','),
      context(category, left, leftGroup, config.contextLeftIds, leftHeaders),
      context(category, right, rightGroup, config.contextRightIds, rightHeaders)]
  try {
    output.write(csvRow(['category', 'fieldStatus', 'key', 'leftRow', 'rightRow', 'field', 'leftValue', 'rightValue',
      'leftNormalized', 'rightNormalized', 'difference', 'reason', 'leftGroupRows', 'rightGroupRows', 'leftContext', 'rightContext']))
    let left = await leftReader.next()
    let right = await rightReader.next()
    while (left || right) {
      if (signal?.aborted) throw new Error('任务已取消')
      if (left?.key.startsWith('~')) {
        for (const row of left.rows) { summary.leftInvalid += 1; await write(detail('invalid_left_key', left.key, row, null, '', '', '', '', '复合键含空值')) }
        left = await leftReader.next()
        continue
      }
      if (right?.key.startsWith('~')) {
        for (const row of right.rows) { summary.rightInvalid += 1; await write(detail('invalid_right_key', right.key, null, row, '', '', '', '', '复合键含空值')) }
        right = await rightReader.next()
        continue
      }
      const relation = !left ? 1 : !right ? -1 : Buffer.compare(Buffer.from(left.key), Buffer.from(right.key))
      if (relation < 0) {
        if (left!.rows.length > 1) {
          if (config.duplicatePolicy === 'abort') throw new CompareError('左侧存在重复核对键，按所选策略停止执行')
          if (config.duplicatePolicy === 'aggregate') {
            summary.conflictGroups += 1
            for (const row of left!.rows) { summary.leftOnly += 1; await write(detail('left_only', left!.key, row, null,
              '', '', '', '', '右侧无此键；左侧组保留全部来源行', '', '', '', left!.rows)) }
            left = await leftReader.next()
            continue
          }
          summary.conflictGroups += 1
          for (const row of left!.rows) { summary.leftConflict += 1; await write(detail('key_conflict', left!.key, row, null, '', '', '', '', '左侧复合键重复', '', '', '', left!.rows)) }
        } else { summary.leftOnly += 1; await write(detail('left_only', left!.key, left!.rows[0]!, null)) }
        left = await leftReader.next()
        continue
      }
      if (relation > 0) {
        if (right!.rows.length > 1) {
          if (config.duplicatePolicy === 'abort') throw new CompareError('右侧存在重复核对键，按所选策略停止执行')
          if (config.duplicatePolicy === 'aggregate') {
            summary.conflictGroups += 1
            for (const row of right!.rows) { summary.rightOnly += 1; await write(detail('right_only', right!.key, null, row,
              '', '', '', '', '左侧无此键；右侧组保留全部来源行', '', '', '', [], right!.rows)) }
            right = await rightReader.next()
            continue
          }
          summary.conflictGroups += 1
          for (const row of right!.rows) { summary.rightConflict += 1; await write(detail('key_conflict', right!.key, null, row, '', '', '', '', '右侧复合键重复', '', '', '', [], right!.rows)) }
        } else { summary.rightOnly += 1; await write(detail('right_only', right!.key, null, right!.rows[0]!)) }
        right = await rightReader.next()
        continue
      }
      if (left!.rows.length > 1 || right!.rows.length > 1) {
        if (config.duplicatePolicy === 'abort') throw new CompareError('存在重复核对键，按所选策略停止执行')
        if (config.duplicatePolicy !== 'aggregate') {
          summary.conflictGroups += 1
          const conflictReason = left!.rows.length > 1 && right!.rows.length > 1 ? '两侧复合键均重复'
            : left!.rows.length > 1 ? '左侧复合键重复，右侧成员受影响' : '右侧复合键重复，左侧成员受影响'
          for (const row of left!.rows) { summary.leftConflict += 1; await write(detail('key_conflict', left!.key, row, null,
            '', '', '', '', conflictReason, '', '', '', left!.rows, right!.rows)) }
          for (const row of right!.rows) { summary.rightConflict += 1; await write(detail('key_conflict', right!.key, null, row,
            '', '', '', '', conflictReason, '', '', '', left!.rows, right!.rows)) }
        }
      }
      if (left!.rows.length === 1 && right!.rows.length === 1 || config.duplicatePolicy === 'aggregate') {
        const leftRow = left!.rows[0]!
        const rightRow = right!.rows[0]!
        if (config.duplicatePolicy === 'aggregate') {
          if (left!.rows.length > 1 || right!.rows.length > 1) summary.conflictGroups += 1
          summary.leftAggregatedExtra += left!.rows.length - 1
          summary.rightAggregatedExtra += right!.rows.length - 1
        }
        const fieldResults = config.fields.map((field, fieldIndex) => {
          const leftIndex = index(field.leftColumnId)
          const rightIndex = index(field.rightColumnId)
          const leftRaw = left!.rows.map((row) => row.values[leftIndex] ?? '')
          const rightRaw = right!.rows.map((row) => row.values[rightIndex] ?? '')
          const aggregate = config.duplicatePolicy === 'aggregate'
          const method = config.aggregateMethods?.[fieldIndex]
          const leftValue = aggregate ? method === 'count' ? String(leftRaw.length) : decimalSum(leftRaw) : leftRaw[0]!
          const rightValue = aggregate ? method === 'count' ? String(rightRaw.length) : decimalSum(rightRaw) : rightRaw[0]!
          const leftOriginal = aggregate ? JSON.stringify(leftRaw) : leftValue
          const rightOriginal = aggregate ? JSON.stringify(rightRaw) : rightValue
          if (leftOriginal.length > 32_767 || rightOriginal.length > 32_767) throw new CompareError('重复键聚合原值列表超过单元格长度限制')
          return { field, leftValue: leftOriginal, rightValue: rightOriginal,
            result: compareField(leftValue, rightValue, field, config.emptyValuePolicy),
            aggregateReason: aggregate ? `按 ${method?.toUpperCase()} 聚合；左侧来源行 ${left!.rows.map((row) => row.sourceRow).join(',')}；右侧来源行 ${right!.rows.map((row) => row.sourceRow).join(',')}` : '',
            name: `${leftHeaders[leftIndex]} ↔ ${rightHeaders[rightIndex]}` }
        })
        const category = fieldResults.some((item) => item.result.state === 'error') ? 'pair_error'
          : fieldResults.some((item) => item.result.state === 'different') ? 'different' : 'equal'
        if (category === 'pair_error' && config.parseFailurePolicy === 'abort') {
          throw new CompareError('比较字段解析失败，按所选策略停止执行')
        }
        if (category === 'pair_error') summary.pairErrors += 1
        else if (category === 'different') summary.differentPairs += 1
        else summary.equalPairs += 1
        for (const item of fieldResults) {
          if (item.result.state === 'different') summary.differentFields += 1
          await write(detail(category, left!.key, leftRow, rightRow, item.name,
            item.leftValue, item.rightValue, item.result.difference,
            item.aggregateReason ? `${item.aggregateReason}；${item.result.reason}` : item.result.reason, item.result.state,
            item.result.leftNormalized, item.result.rightNormalized, left!.rows.length > 1 ? left!.rows : [],
            right!.rows.length > 1 ? right!.rows : []))
        }
      }
      left = await leftReader.next()
      right = await rightReader.next()
    }
    if (summary.leftRows !== summary.leftInvalid + summary.leftConflict + summary.leftOnly + summary.equalPairs + summary.differentPairs + summary.pairErrors + summary.leftAggregatedExtra ||
      summary.rightRows !== summary.rightInvalid + summary.rightConflict + summary.rightOnly + summary.equalPairs + summary.differentPairs + summary.pairErrors + summary.rightAggregatedExtra) {
      throw new Error('核对数量守恒检查失败')
    }
    output.end()
    await once(output, 'finish')
    return summary
  } catch (error) { output.destroy(); throw error }
  finally { await leftIterator.return?.(undefined); await rightIterator.return?.(undefined) }
}
