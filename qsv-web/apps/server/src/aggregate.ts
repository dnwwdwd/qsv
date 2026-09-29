import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'

export type AggregateMeasure = { operation: 'count' | 'sum' | 'min' | 'max' | 'avg'; columnId?: string;
  name: string; precision?: number }
export interface AggregateConfig { groupColumnIds: string[]; measures: AggregateMeasure[] }
export class AggregateError extends Error {}

function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(row: string[]) { return `${row.map(csvCell).join(',')}\n` }
function column(id: string) { return Number(id.slice(2)) }

export function validateAggregateConfig(config: AggregateConfig, width: number, headers: string[]) {
  const valid = (id: unknown) => typeof id === 'string' && /^c_(\d+)$/u.test(id) && column(id) < width
  if (!config || !Array.isArray(config.groupColumnIds) || config.groupColumnIds.length < 1 ||
    config.groupColumnIds.length > 4 || new Set(config.groupColumnIds).size !== config.groupColumnIds.length ||
    config.groupColumnIds.some((id) => !valid(id)) || !Array.isArray(config.measures) ||
    config.measures.length < 1 || config.measures.length > 8) throw new AggregateError('分组或指标数量无效')
  const outputNames = config.groupColumnIds.map((id) => headers[column(id)] ?? '')
  for (const measure of config.measures) {
    if (!measure || !['count', 'sum', 'min', 'max', 'avg'].includes(measure.operation) ||
      (measure.operation !== 'count' && !valid(measure.columnId)) ||
      typeof measure.name !== 'string' || !measure.name.trim() || measure.name.length > 120 ||
      (measure.operation === 'sum' || measure.operation === 'avg') &&
      (!Number.isInteger(measure.precision) || Number(measure.precision) < 0 || Number(measure.precision) > 18)) {
      throw new AggregateError('聚合指标配置无效')
    }
    outputNames.push(measure.name)
  }
  if (outputNames.some((name) => !name) || new Set(outputNames).size !== outputNames.length) {
    throw new AggregateError('聚合结果字段名必须非空且不重复')
  }
}

const scale = 10n ** 18n
function scaledDecimal(value: string) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value)
  if (!match || match[2]!.length + (match[3]?.length ?? 0) > 38 || (match[3]?.length ?? 0) > 18) return null
  const coefficient = BigInt(match[2]!) * scale + BigInt((match[3] ?? '').padEnd(18, '0'))
  return match[1] === '-' ? -coefficient : coefficient
}
function decimalText(value: bigint, precision: number, denominator = 1n) {
  const negative = value < 0n
  const absolute = negative ? -value : value
  const divisor = denominator * 10n ** BigInt(18 - precision)
  const rounded = (absolute + divisor / 2n) / divisor
  const digits = rounded.toString().padStart(precision + 1, '0')
  return `${negative && rounded !== 0n ? '-' : ''}${precision ? `${digits.slice(0, -precision)}.${digits.slice(-precision)}` : digits}`
}

interface State { group: string[]; count: number; values: Array<{ total: bigint; count: number; min: string | null; max: string | null }> }

/** 一次扫描做确定性分组；金额汇总使用 18 位固定小数的整数运算。 */
export async function writeGroupedAggregate(inputPath: string, outputPath: string, config: AggregateConfig,
  expectedRows: number, signal?: AbortSignal) {
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const groups = new Map<string, State>()
  let headers: string[] | null = null
  let rowsIn = 0
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new AggregateError('汇总已取消')
      if (!headers) { headers = row; validateAggregateConfig(config, headers.length, headers); continue }
      rowsIn += 1
      if (row.length !== headers.length) throw new AggregateError(`第 ${rowsIn} 行字段数不一致`)
      const group = config.groupColumnIds.map((id) => row[column(id)] ?? '')
      const key = JSON.stringify(group)
      if (Buffer.byteLength(key, 'utf8') > 8192) throw new AggregateError('分组键超过 8 KiB')
      let state = groups.get(key)
      if (!state) {
        if (groups.size >= 100_000) throw new AggregateError('分组超过 10 万组，请减少分组字段或先筛选')
        state = { group, count: 0, values: config.measures.map(() => ({ total: 0n, count: 0, min: null, max: null })) }
        groups.set(key, state)
      }
      state.count += 1
      config.measures.forEach((measure, index) => {
        if (measure.operation === 'count') return
        const value = row[column(measure.columnId!)] ?? ''
        if (value === '') return
        const slot = state!.values[index]!
        if (measure.operation === 'sum' || measure.operation === 'avg') {
          const numeric = scaledDecimal(value)
          if (numeric === null) throw new AggregateError(`第 ${rowsIn} 行 ${measure.name} 的数值无法按十进制解析`)
          slot.total += numeric
          slot.count += 1
        } else {
          slot.min = slot.min === null || value < slot.min ? value : slot.min
          slot.max = slot.max === null || value > slot.max ? value : slot.max
        }
      })
    }
    if (!headers) throw new AggregateError('数据集缺少表头')
    if (rowsIn !== expectedRows) throw new AggregateError('汇总输入行数与资源记录不一致')
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    const write = async (value: string) => { if (!output.write(value)) await once(output, 'drain') }
    try {
      await write(csvLine([...config.groupColumnIds.map((id) => headers![column(id)]!), ...config.measures.map((item) => item.name)]))
      for (const state of groups.values()) {
        if (signal?.aborted) throw new AggregateError('汇总已取消')
        const values = config.measures.map((measure, index) => {
          const slot = state.values[index]!
          if (measure.operation === 'count') return String(state.count)
          if (measure.operation === 'min') return slot.min ?? ''
          if (measure.operation === 'max') return slot.max ?? ''
          if (!slot.count) return ''
          return decimalText(slot.total, measure.precision ?? 2, measure.operation === 'avg' ? BigInt(slot.count) : 1n)
        })
        await write(csvLine([...state.group, ...values]))
      }
      output.end()
      await finished(output)
      return { rowsIn, rowsOut: groups.size, headers: [...config.groupColumnIds.map((id) => headers![column(id)]!),
        ...config.measures.map((item) => item.name)] }
    } catch (error) { output.destroy(); throw error }
  } finally { source.destroy(); parser.destroy() }
}
