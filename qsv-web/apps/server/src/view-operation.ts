import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'
import Database from 'better-sqlite3'
import { compileSafePattern, PatternError } from './safe-pattern.ts'

export type FilterCondition = { columnId: string; operator: 'equals' | 'not-equals' | 'contains' | 'starts' | 'ends' |
  'is-empty' | 'not-empty' | 'between' | 'in' | 'pattern'; value?: string; other?: string; values?: string[] }
export type SortCondition = { columnId: string; direction: 'asc' | 'desc'; empty: 'first' | 'last' }
export interface ViewPlan { combine: 'and' | 'or'; conditions: FilterCondition[]; sorts: SortCondition[];
  groups?: { combine: 'and' | 'or'; conditions: FilterCondition[] }[] }
export class ViewPlanError extends Error {}

function column(id: string) { return Number(id.slice(2)) }
function csvCell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function csvLine(values: string[]) { return `${values.map(csvCell).join(',')}\n` }

export function validateViewPlan(raw: ViewPlan, width: number): ViewPlan {
  if (!raw || (raw.combine !== 'and' && raw.combine !== 'or') || !Array.isArray(raw.conditions) ||
    !Array.isArray(raw.sorts) || raw.conditions.length > 16 || raw.sorts.length > 4 ||
    (raw.groups !== undefined && (!Array.isArray(raw.groups) || raw.groups.length < 1 || raw.groups.length > 4 ||
      raw.conditions.length > 0 || raw.groups.some((group) => !group || !['and', 'or'].includes(group.combine) ||
        !Array.isArray(group.conditions) || group.conditions.length < 1)))) throw new ViewPlanError('筛选或排序配置无效')
  const allConditions = raw.groups ? raw.groups.flatMap((group) => group.conditions) : raw.conditions
  if (allConditions.length > 16 || allConditions.length + raw.sorts.length === 0) throw new ViewPlanError('筛选条件数量无效')
  const validColumn = (id: unknown) => typeof id === 'string' && /^c_(\d+)$/u.test(id) && column(id) < width
  for (const condition of allConditions) {
    if (!condition || !validColumn(condition.columnId) || !['equals', 'not-equals', 'contains', 'starts', 'ends',
      'is-empty', 'not-empty', 'between', 'in', 'pattern'].includes(condition.operator)) throw new ViewPlanError('筛选字段或运算符无效')
    if (['equals', 'not-equals', 'contains', 'starts', 'ends', 'between', 'pattern'].includes(condition.operator) &&
      (typeof condition.value !== 'string' || condition.value.length > 512)) throw new ViewPlanError('筛选值无效')
    if (condition.operator === 'pattern') {
      try { compileSafePattern(condition.value!) }
      catch (error) { throw new ViewPlanError(error instanceof PatternError ? error.message : '表达式无效') }
    }
    if (condition.operator === 'between' && (typeof condition.other !== 'string' || condition.other.length > 512 ||
      condition.value! > condition.other)) throw new ViewPlanError('文本范围无效')
    if (condition.operator === 'in' && (!Array.isArray(condition.values) || condition.values.length < 1 ||
      condition.values.length > 100 || condition.values.some((value) => typeof value !== 'string' || value.length > 512))) {
      throw new ViewPlanError('集合值无效')
    }
  }
  for (const sort of raw.sorts) if (!sort || !validColumn(sort.columnId) ||
    !['asc', 'desc'].includes(sort.direction) || !['first', 'last'].includes(sort.empty)) throw new ViewPlanError('排序规则无效')
  if (new Set(raw.sorts.map((sort) => sort.columnId)).size !== raw.sorts.length) throw new ViewPlanError('排序字段不能重复')
  return raw
}

function matches(row: string[], condition: FilterCondition, pattern?: (value: string) => boolean) {
  const value = row[column(condition.columnId)] ?? ''
  switch (condition.operator) {
    case 'equals': return value === condition.value
    case 'not-equals': return value !== condition.value
    case 'contains': return value.includes(condition.value ?? '')
    case 'starts': return value.startsWith(condition.value ?? '')
    case 'ends': return value.endsWith(condition.value ?? '')
    case 'is-empty': return value === ''
    case 'not-empty': return value !== ''
    case 'between': return value >= (condition.value ?? '') && value <= (condition.other ?? '')
    case 'in': return condition.values?.includes(value) ?? false
    case 'pattern': return pattern?.(value) ?? false
  }
}

/** 全表条件计算，排序使用私有临时 SQLite 文件，按源行号稳定处理并列值。 */
export async function writeFilteredSortedCsv(inputPath: string, outputPath: string, plan: ViewPlan,
  expectedRows: number, signal?: AbortSignal, lineagePath?: string) {
  const source = createReadStream(inputPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const write = async (text: string) => { if (!output.write(text)) await once(output, 'drain') }
  const lineage = lineagePath ? createWriteStream(lineagePath, { flags: 'wx', mode: 0o600 }) : null
  const writeLineage = async (sourceRow: number) => {
    if (lineage && !lineage.write(csvLine([String(rowsOut), String(sourceRow)]))) await once(lineage, 'drain')
  }
  const scratchPath = `${outputPath}.sort.sqlite`
  let scratch: Database.Database | null = null
  let insertBatch: ((entries: Array<{ sourceRow: number; cells: string; sorts: string[] }>) => void) | null = null
  let pending: Array<{ sourceRow: number; cells: string; sorts: string[] }> = []
  let pendingBytes = 0
  let rowsIn = 0
  let rowsOut = 0
  let headers: string[] | null = null
  const groups = plan.groups ?? (plan.conditions.length ? [{ combine: plan.combine, conditions: plan.conditions }] : [])
  const patterns = groups.map((group) => group.conditions.map((condition) =>
    condition.operator === 'pattern' ? compileSafePattern(condition.value ?? '') : undefined))
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new ViewPlanError('筛选或排序已取消')
      if (!headers) {
        headers = row
        validateViewPlan(plan, headers.length)
        await write(csvLine(headers))
        if (plan.sorts.length) {
          scratch = new Database(scratchPath)
          scratch.pragma('journal_mode = DELETE')
          const sortColumns = plan.sorts.map((_, index) => `s${index} TEXT NOT NULL`).join(',')
          scratch.exec(`CREATE TABLE selected (source_row INTEGER PRIMARY KEY, cells TEXT NOT NULL, ${sortColumns})`)
          const names = plan.sorts.map((_, index) => `s${index}`).join(',')
          const markers = plan.sorts.map(() => '?').join(',')
          const insert = scratch.prepare(`INSERT INTO selected(source_row,cells,${names}) VALUES (?, ?, ${markers})`)
          insertBatch = scratch.transaction((entries: Array<{ sourceRow: number; cells: string; sorts: string[] }>) => {
            for (const entry of entries) insert.run(entry.sourceRow, entry.cells, ...entry.sorts)
          })
        }
        continue
      }
      rowsIn += 1
      if (row.length !== headers.length) throw new ViewPlanError(`第 ${rowsIn} 行字段数与表头不一致`)
      if (groups.length) {
        const groupMatches = groups.map((group, groupIndex) => group.combine === 'and'
          ? group.conditions.every((item, index) => matches(row, item, patterns[groupIndex]?.[index]))
          : group.conditions.some((item, index) => matches(row, item, patterns[groupIndex]?.[index])))
        if (!(plan.combine === 'and' ? groupMatches.every(Boolean) : groupMatches.some(Boolean))) continue
      }
      rowsOut += 1
      if (scratch) {
        const cells = JSON.stringify(row)
        pending.push({ sourceRow: rowsIn, cells, sorts: plan.sorts.map((item) => row[column(item.columnId)] ?? '') })
        pendingBytes += Buffer.byteLength(cells, 'utf8')
        if (pending.length >= 1000 || pendingBytes >= 2 * 1024 * 1024) { insertBatch!(pending); pending = []; pendingBytes = 0 }
      } else { await write(csvLine(row)); await writeLineage(rowsIn) }
    }
    if (!headers) throw new ViewPlanError('数据集缺少表头')
    if (rowsIn !== expectedRows) throw new ViewPlanError('筛选输入行数与资源记录不一致')
    if (scratch) {
      if (pending.length) { insertBatch!(pending); pending = [] }
      const order = plan.sorts.flatMap((item, index) => [
        `(s${index}='') ${item.empty === 'first' ? 'DESC' : 'ASC'}`,
        `s${index} COLLATE BINARY ${item.direction.toUpperCase()}`,
      ]).join(', ')
      rowsOut = 0
      for (const result of scratch.prepare(`SELECT cells, source_row FROM selected ORDER BY ${order}, source_row ASC`).iterate() as Iterable<{ cells: string; source_row: number }>) {
        if (signal?.aborted) throw new ViewPlanError('筛选或排序已取消')
        await write(csvLine(JSON.parse(result.cells) as string[]))
        rowsOut += 1
        await writeLineage(result.source_row)
      }
    }
    output.end()
    await finished(output)
    if (lineage) { lineage.end(); await finished(lineage) }
    return { rowsIn, rowsOut, headers }
  } catch (error) { output.destroy(); lineage?.destroy(); throw error }
  finally { source.destroy(); parser.destroy(); scratch?.close(); await rm(scratchPath, { force: true }) }
}
