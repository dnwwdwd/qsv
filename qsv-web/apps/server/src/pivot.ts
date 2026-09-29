import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'
import { validateAggregateConfig, writeGroupedAggregate, type AggregateMeasure } from './aggregate.ts'

export interface PivotConfig { rowColumnId: string; pivotColumnId: string; measure: AggregateMeasure }
export class PivotError extends Error {}
const index = (id: string) => Number(id.slice(2))
const field = (value: string) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
const line = (row: string[]) => `${row.map(field).join(',')}\n`

export function validatePivotConfig(config: PivotConfig, headers: string[]) {
  if (!config || typeof config.rowColumnId !== 'string' || typeof config.pivotColumnId !== 'string' ||
    config.rowColumnId === config.pivotColumnId) throw new PivotError('透视的行字段和列字段必须不同')
  try { validateAggregateConfig({ groupColumnIds: [config.rowColumnId, config.pivotColumnId], measures: [config.measure] },
    headers.length, headers) }
  catch { throw new PivotError('透视字段或聚合指标无效') }
}

/** 先做全量分组，再按首次出现顺序展开；列数和单元格数超过预算时不发布结果。 */
export async function writePivot(inputPath: string, outputPath: string, config: PivotConfig, headers: string[],
  expectedRows: number, signal?: AbortSignal) {
  validatePivotConfig(config, headers)
  const groupedPath = `${outputPath}.groups.csv`
  try {
    await writeGroupedAggregate(inputPath, groupedPath, { groupColumnIds: [config.rowColumnId, config.pivotColumnId],
      measures: [config.measure] }, expectedRows, signal)
    const source = createReadStream(groupedPath, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    const columns: string[] = []
    const rows = new Map<string, Map<string, string>>()
    let headerSeen = false
    try {
      for await (const row of parser as AsyncIterable<string[]>) {
        if (signal?.aborted) throw new PivotError('透视已取消')
        if (!headerSeen) { headerSeen = true; continue }
        if (row.length !== 3) throw new PivotError('聚合结果字段数无效')
        const [rowValue, columnValue, measureValue] = row as [string, string, string]
        if (!columns.includes(columnValue)) {
          if (columns.length >= 100) throw new PivotError('透视列超过 100 个，请缩小列字段种类')
          columns.push(columnValue)
        }
        let cells = rows.get(rowValue)
        if (!cells) {
          if (rows.size >= 1000) throw new PivotError('透视行超过 1000 组，请先筛选或汇总')
          cells = new Map()
          rows.set(rowValue, cells)
        }
        cells.set(columnValue, measureValue)
      }
      if (!headerSeen) throw new PivotError('聚合结果缺少表头')
    } finally { source.destroy(); parser.destroy() }
    const outputHeaders = [headers[index(config.rowColumnId)]!, ...columns.map((value) => `${config.measure.name} · ${value || '（空值）'}`)]
    if (outputHeaders.length > 101 || new Set(outputHeaders).size !== outputHeaders.length) {
      throw new PivotError('透视结果列名重复或超过上限')
    }
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    const write = async (value: string) => { if (!output.write(value)) await once(output, 'drain') }
    try {
      await write(line(outputHeaders))
      for (const [rowValue, cells] of rows) {
        if (signal?.aborted) throw new PivotError('透视已取消')
        await write(line([rowValue, ...columns.map((column) => cells.get(column) ?? '')]))
      }
      output.end()
      await finished(output)
      return { rowsOut: rows.size, columnsOut: outputHeaders.length }
    } catch (error) { output.destroy(); throw error }
  } finally { await rm(groupedPath, { force: true }) }
}
