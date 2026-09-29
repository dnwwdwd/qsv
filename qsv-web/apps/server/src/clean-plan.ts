import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import { parse } from 'csv-parse'
import Database from 'better-sqlite3'
import { compileSafePattern } from './safe-pattern.ts'
import { calendarDate, DateValidationError, ianaLocalTimestamp, validIanaTimeZone, validUtcOffset, zonedTimestamp, type DateInputFormat } from './transform.ts'

export class CleanPlanError extends Error {}
export type CleanStep =
  | { type: 'text'; columnId: string; mode: 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'nfc' | 'nfkc' | 'replace' | 'pattern'; find?: string; replacement?: string; enabled?: boolean }
  | { type: 'fill'; columnId: string; mode: 'fixed' | 'forward' | 'backward'; value?: string;
    scope?: 'all' | 'empty-text' | 'missing' | 'explicit-null'; enabled?: boolean }
  | { type: 'number'; columnId: string; decimals: number; rounding: 'half-up' | 'half-even' | 'truncate'; prefix?: string; suffix?: string; thousands?: boolean; invalid: 'keep' | 'isolate' | 'fail'; enabled?: boolean }
  | { type: 'date'; columnId: string; format: DateInputFormat | 'iso-time' | 'iso-local-time'; outputOffset?: string;
    inputZone?: string; outputZone?: string; invalid: 'keep' | 'isolate' | 'fail'; enabled?: boolean }
  | { type: 'rename'; columnId: string; name: string; enabled?: boolean }
  | { type: 'columns'; columnIds: string[]; enabled?: boolean }
  | { type: 'add'; name: string; mode: 'constant' | 'sequence' | 'concat' | 'arithmetic'; value?: string; columnIds?: string[]; separator?: string; operator?: 'add' | 'subtract' | 'multiply'; enabled?: boolean }
  | { type: 'empty-row'; mode: 'report' | 'remove'; whitespace: 'literal' | 'trim'; enabled?: boolean }
  | { type: 'filter'; columnId: string; operator: 'equals' | 'not-equals' | 'contains' | 'is-empty' | 'not-empty'; value?: string; action: 'keep' | 'exclude'; enabled?: boolean }
  | { type: 'dedupe'; columnIds: string[]; keep: 'first' | 'last' | 'priority'; priorityColumnId?: string;
    priorityOrder?: 'asc' | 'desc'; priorityType?: 'text' | 'decimal'; emptyPriority?: 'first' | 'last'; enabled?: boolean }
export interface CleanPlan { steps: CleanStep[] }
export interface CleanStepResult { step: number; type: CleanStep['type']; rowsIn: number; rowsOut: number; changed: number; errors: number; sampleErrors: { row: number; value: string; reason?: string }[];
  duplicateGroups?: number; duplicateMembers?: number; emptyRows?: number }
export interface CleanReport { step: number; kind: 'errors' | 'duplicates' | 'empty-rows'; file: string; rows: number }

function index(id: string, width: number) {
  const match = typeof id === 'string' && /^c_(\d+)$/u.exec(id)
  const value = match ? Number(match[1]) : -1
  if (!Number.isSafeInteger(value) || value < 0 || value >= width) throw new CleanPlanError('步骤引用了不存在的字段')
  return value
}
function textValue(value: unknown, max = 512) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw new CleanPlanError('文本参数无效')
  return value
}
function uniqueName(name: string, headers: string[]) {
  textValue(name, 128)
  if (!name.trim() || headers.includes(name)) throw new CleanPlanError('新字段名为空或与现有字段重名')
}
export function validateCleanPlan(plan: CleanPlan, inputHeaders: string[]) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 24 || !Array.isArray(inputHeaders) || inputHeaders.length < 1) throw new CleanPlanError('清洗步骤数量或数据字段无效')
  let headers = [...inputHeaders]
  let active = 0
  for (const step of plan.steps) {
    if (!step || typeof step !== 'object' || step.enabled === false) continue
    active += 1
    if ('columnId' in step) index(step.columnId, headers.length)
    switch (step.type) {
      case 'text':
        if (!['trim','squeeze','squeeze0','lower','upper','nfc','nfkc','replace','pattern'].includes(step.mode)) throw new CleanPlanError('文本操作无效')
        if (step.mode === 'replace' || step.mode === 'pattern') {
          textValue(step.find)
          textValue(step.replacement ?? '')
          if (!step.find) throw new CleanPlanError('查找内容不能为空')
          if (step.mode === 'pattern') compileSafePattern(step.find)
        }
        break
      case 'fill':
        if (!['fixed','forward','backward'].includes(step.mode)) throw new CleanPlanError('填充操作无效')
        if (step.scope !== undefined && !['all', 'empty-text', 'missing', 'explicit-null'].includes(step.scope)) {
          throw new CleanPlanError('空值应用范围无效')
        }
        if (step.mode === 'fixed') textValue(step.value ?? '', 4096)
        break
      case 'number':
        if (!Number.isInteger(step.decimals) || step.decimals < 0 || step.decimals > 18 || !['half-up','half-even','truncate'].includes(step.rounding) || !['keep','isolate','fail'].includes(step.invalid)) throw new CleanPlanError('数值转换参数无效')
        textValue(step.prefix ?? '', 32); textValue(step.suffix ?? '', 32)
        break
      case 'date':
        if (!['yyyy-MM-dd','yyyy/MM/dd','dd/MM/yyyy','MM/dd/yyyy','iso-time','iso-local-time'].includes(step.format) ||
          !['keep','isolate','fail'].includes(step.invalid) ||
          (step.format === 'iso-time' && !validUtcOffset(step.outputOffset ?? '')) ||
          (step.format === 'iso-local-time' && (!validIanaTimeZone(step.inputZone ?? '') || !validIanaTimeZone(step.outputZone ?? '')))) {
          throw new CleanPlanError('日期格式、输入或输出时区、错误处理规则无效')
        }
        break
      case 'rename':
        uniqueName(step.name, headers.filter((_, i) => i !== index(step.columnId, headers.length)))
        headers[index(step.columnId, headers.length)] = step.name
        break
      case 'columns':
        if (!Array.isArray(step.columnIds) || step.columnIds.length < 1 || step.columnIds.length > headers.length || new Set(step.columnIds).size !== step.columnIds.length) throw new CleanPlanError('字段保留及顺序无效')
        headers = step.columnIds.map((id) => headers[index(id, headers.length)]!)
        break
      case 'add':
        uniqueName(step.name, headers)
        if (!['constant','sequence','concat','arithmetic'].includes(step.mode)) throw new CleanPlanError('新字段操作无效')
        if (step.mode === 'constant') textValue(step.value ?? '', 4096)
        if (step.mode === 'concat' || step.mode === 'arithmetic') {
          if (!Array.isArray(step.columnIds) || step.columnIds.length < 2 || step.columnIds.length > 8) throw new CleanPlanError('请选择 2 至 8 个字段')
          step.columnIds.forEach((id) => index(id, headers.length))
          if (step.mode === 'concat') textValue(step.separator ?? '', 32)
          else if (!['add','subtract','multiply'].includes(step.operator ?? '')) throw new CleanPlanError('计算操作无效')
        }
        headers.push(step.name)
        break
      case 'empty-row':
        if (!['report', 'remove'].includes(step.mode) || !['literal', 'trim'].includes(step.whitespace)) throw new CleanPlanError('空行检查规则无效')
        break
      case 'filter':
        if (!['equals','not-equals','contains','is-empty','not-empty'].includes(step.operator) || !['keep','exclude'].includes(step.action)) throw new CleanPlanError('行筛选操作无效')
        textValue(step.value ?? '')
        break
      case 'dedupe':
        if (!Array.isArray(step.columnIds) || step.columnIds.length > headers.length || new Set(step.columnIds).size !== step.columnIds.length || !['first','last','priority'].includes(step.keep)) throw new CleanPlanError('去重字段或保留策略无效')
        step.columnIds.forEach((id) => index(id, headers.length))
        if (step.keep === 'priority' && (!step.priorityColumnId || !['asc','desc'].includes(step.priorityOrder ?? '') ||
          !['text','decimal'].includes(step.priorityType ?? '') || !['first','last'].includes(step.emptyPriority ?? ''))) {
          throw new CleanPlanError('去重优先字段或排序规则无效')
        }
        if (step.keep === 'priority') index(step.priorityColumnId!, headers.length)
        break
      default: throw new CleanPlanError('不支持的清洗步骤')
    }
  }
  if (!active) throw new CleanPlanError('至少启用一个步骤')
  if (headers.length > 1024) throw new CleanPlanError('输出字段超过 1024 列')
  return headers
}
function csvLine(values: string[]) { return `${values.map((value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"','""')}"` : value).join(',')}\n` }
function decimal(value: string) {
  if (!/^-?(?:\d+)(?:\.\d+)?$/u.test(value)) throw new CleanPlanError('数值格式无效')
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  return { scaled: (negative ? -1n : 1n) * BigInt(`${whole}${fraction}`), scale: fraction.length }
}
function comparePriority(candidate: string, current: string, step: Extract<CleanStep, { type: 'dedupe' }>) {
  if (candidate === '' || current === '') {
    if (candidate === current) return 0
    return candidate === '' ? (step.emptyPriority === 'first' ? -1 : 1) : (step.emptyPriority === 'first' ? 1 : -1)
  }
  let comparison: number
  if (step.priorityType === 'decimal') {
    const left = decimal(candidate), right = decimal(current)
    const scale = Math.max(left.scale, right.scale)
    const a = left.scaled * 10n ** BigInt(scale - left.scale)
    const b = right.scaled * 10n ** BigInt(scale - right.scale)
    comparison = a < b ? -1 : a > b ? 1 : 0
  } else comparison = candidate < current ? -1 : candidate > current ? 1 : 0
  return step.priorityOrder === 'desc' ? -comparison : comparison
}
function formatScaled(scaled: bigint, scale: number) {
  const negative = scaled < 0n
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0')
  const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits
  return `${negative ? '-' : ''}${value}`
}
function rounded(value: string, decimals: number, mode: 'half-up' | 'half-even' | 'truncate') {
  const parsed = decimal(value)
  if (parsed.scale <= decimals) return formatScaled(parsed.scaled * 10n ** BigInt(decimals - parsed.scale), decimals)
  const divisor = 10n ** BigInt(parsed.scale - decimals)
  const abs = parsed.scaled < 0n ? -parsed.scaled : parsed.scaled
  let quotient = abs / divisor
  const remainder = abs % divisor
  if (mode === 'half-up' && remainder * 2n >= divisor || mode === 'half-even' && (remainder * 2n > divisor || remainder * 2n === divisor && quotient % 2n === 1n)) quotient += 1n
  return formatScaled(parsed.scaled < 0n ? -quotient : quotient, decimals)
}
function arithmetic(values: string[], operator: 'add' | 'subtract' | 'multiply') {
  const parsed = values.map(decimal)
  let current = parsed[0]!
  for (const value of parsed.slice(1)) {
    if (operator === 'multiply') current = { scaled: current.scaled * value.scaled, scale: current.scale + value.scale }
    else {
      const scale = Math.max(current.scale, value.scale)
      const left = current.scaled * 10n ** BigInt(scale - current.scale)
      const right = value.scaled * 10n ** BigInt(scale - value.scale)
      current = { scaled: operator === 'add' ? left + right : left - right, scale }
    }
    if (current.scale > 36 || current.scaled.toString().length > 100) throw new CleanPlanError('计算结果超过精度上限')
  }
  return formatScaled(current.scaled, current.scale)
}
async function rows(path: string, signal?: AbortSignal) {
  const source = createReadStream(path, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  return { source, parser }
}
async function cellStates(reportPath: string, databasePath: string, signal?: AbortSignal, maxOutputRow?: number) {
  const db = new Database(databasePath)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE states (output_row INTEGER NOT NULL, field TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(output_row,field)) WITHOUT ROWID')
  const insert = db.prepare('INSERT INTO states(output_row,field,state) VALUES (?,?,?)')
  const writeBatch = db.transaction((items: [number, string, string][]) => { for (const item of items) insert.run(...item) })
  const source = createReadStream(reportPath, { signal })
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  source.on('error', (error) => parser.destroy(error)); source.pipe(parser)
  let first = true
  let pending: [number, string, string][] = []
  try {
    for await (const row of parser as AsyncIterable<string[]>) {
      if (first) {
        first = false
        if (JSON.stringify(row) !== JSON.stringify(['源记录号', '输出行号', '字段', '转换说明'])) {
          throw new CleanPlanError('JSON 转换清单缺少输出行号，不能区分空值来源')
        }
        continue
      }
      const outputRow = Number(row[1])
      if (row.length !== 4 || !Number.isSafeInteger(outputRow) || outputRow < 1) throw new CleanPlanError('JSON 转换清单记录无效')
      if (maxOutputRow !== undefined && outputRow > maxOutputRow) break
      const state = row[3] === '显式 null 已转为空文本' ? 'explicit-null' :
        row[3] === '缺字段已补为空文本' ? 'missing' : null
      if (!state) continue
      pending.push([outputRow, row[2]!, state])
      if (pending.length >= 1000) { writeBatch(pending); pending = [] }
    }
    if (first) throw new CleanPlanError('JSON 转换清单为空')
    if (pending.length) writeBatch(pending)
    const lookup = db.prepare('SELECT state FROM states WHERE output_row=? AND field=?')
    return { db, get: (row: number, field: string) => (lookup.get(row, field) as { state: string } | undefined)?.state ?? null }
  } catch (error) { db.close(); await rm(databasePath, { force: true }); throw error }
  finally { source.destroy(); parser.destroy() }
}
async function runStep(input: string, outputPath: string, step: CleanStep, stepNumber: number, signal?: AbortSignal,
  reportPath?: string, mayFill?: (row: number) => boolean,
  onOutput?: (inputRow: number, outputRow: number) => void): Promise<CleanStepResult> {
  const { source, parser } = await rows(input, signal)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const write = async (value: string[]) => { if (!output.write(csvLine(value))) await once(output, 'drain') }
  let headers: string[] | null = null
  let inputWidth = 0
  let rowsIn = 0, rowsOut = 0, changed = 0, errors = 0, emptyRows = 0
  const sampleErrors: { row: number; value: string; reason?: string }[] = []
  let report: ReturnType<typeof createWriteStream> | null = null
  const writeEmptyRow = async (record: string[]) => {
    if (!reportPath) return
    if (!report) {
      report = createWriteStream(reportPath, { flags: 'wx', mode: 0o600 })
      if (!report.write(csvLine(['步骤', '输入行号', '处理', '输入记录 JSON']))) await once(report, 'drain')
    }
    if (!report.write(csvLine([String(stepNumber), String(rowsIn), step.type === 'empty-row' && step.mode === 'remove' ? '移除' : '保留', JSON.stringify(record)]))) await once(report, 'drain')
  }
  const writeError = async (value: string, record: string[], reason: string) => {
    if (!reportPath) return
    if (!report) {
      report = createWriteStream(reportPath, { flags: 'wx', mode: 0o600 })
      if (!report.write(csvLine(['步骤', '输入行号', '字段', '原值', '原因', '处理', '输入记录 JSON']))) await once(report, 'drain')
    }
    const handling = step.type === 'number' || step.type === 'date' ? step.invalid : 'keep'
    const line = csvLine([String(stepNumber), String(rowsIn), 'columnId' in step ? step.columnId : '', value, reason.slice(0, 160), handling, JSON.stringify(record)])
    if (!report.write(line)) await once(report, 'drain')
  }
  let previous = ''
  const pattern = step.type === 'text' && step.mode === 'pattern' ? compileSafePattern(step.find ?? '') : null
  try {
    for await (const original of parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CleanPlanError('清洗已取消')
      if (!headers) {
        headers = original
        inputWidth = headers.length
        validateCleanPlan({ steps: [step] }, headers)
        if (step.type === 'rename') headers = headers.map((value, i) => i === index(step.columnId, headers!.length) ? step.name : value)
        if (step.type === 'columns') headers = step.columnIds.map((id) => headers![index(id, headers!.length)]!)
        if (step.type === 'add') headers = [...headers, step.name]
        await write(headers)
        continue
      }
      rowsIn += 1
      if (original.length !== inputWidth) throw new CleanPlanError(`第 ${rowsIn} 行字段数与表头不一致`)
      const row = [...original]
      if (step.type === 'text') {
        const at = index(step.columnId, row.length), value = row[at]!
        row[at] = step.mode === 'trim' ? value.trim() : step.mode === 'squeeze' ? value.replace(/\s+/gu, ' ') : step.mode === 'squeeze0' ? value.replace(/\s+/gu, '') : step.mode === 'lower' ? value.toLowerCase() : step.mode === 'upper' ? value.toUpperCase() : step.mode === 'nfc' ? value.normalize('NFC') : step.mode === 'nfkc' ? value.normalize('NFKC') : step.mode === 'replace' ? value.replaceAll(step.find!, step.replacement ?? '') : pattern?.(value) ? step.replacement ?? '' : value
      } else if (step.type === 'fill') {
        const at = index(step.columnId, row.length)
        if (row[at] === '') {
          if (!mayFill || mayFill(rowsIn)) row[at] = step.mode === 'fixed' ? step.value ?? '' : previous
        } else previous = row[at]!
      } else if (step.type === 'number') {
        const at = index(step.columnId, row.length), originalValue = row[at]!
        if (originalValue !== '') {
          let value = originalValue.trim()
          if (step.prefix && value.startsWith(step.prefix)) value = value.slice(step.prefix.length)
          if (step.suffix && value.endsWith(step.suffix)) value = value.slice(0, -step.suffix.length)
          if (step.thousands) value = value.replaceAll(',', '')
          try { row[at] = rounded(value.trim(), step.decimals, step.rounding) }
          catch (error) {
            errors += 1
            const reason = error instanceof CleanPlanError ? error.message : '数值转换失败'
            if (sampleErrors.length < 10) sampleErrors.push({ row: rowsIn, value: originalValue.slice(0, 128), reason })
            await writeError(originalValue, original, reason)
            if (step.invalid === 'fail') throw new CleanPlanError(`第 ${rowsIn} 行数值无法解析：${originalValue.slice(0, 80)}`)
            if (step.invalid === 'isolate') { changed += 1; continue }
          }
        }
      } else if (step.type === 'date') {
        const at = index(step.columnId, row.length), originalValue = row[at]!
        if (originalValue !== '') {
          try { row[at] = step.format === 'iso-time' ? zonedTimestamp(originalValue, step.outputOffset!, rowsIn)
            : step.format === 'iso-local-time' ? ianaLocalTimestamp(originalValue, step.inputZone!, step.outputZone!, rowsIn)
              : calendarDate(originalValue, step.format, rowsIn) }
          catch (error) {
            errors += 1
            const reason = error instanceof DateValidationError ? error.message : '日期时间转换失败'
            if (sampleErrors.length < 10) sampleErrors.push({ row: rowsIn, value: originalValue.slice(0, 128), reason })
            await writeError(originalValue, original, reason)
            if (step.invalid === 'fail') throw new CleanPlanError(`第 ${rowsIn} 行日期无法解析：${originalValue.slice(0, 80)}`)
            if (step.invalid === 'isolate') { changed += 1; continue }
          }
        }
      } else if (step.type === 'columns') {
        const selected = step.columnIds.map((id) => row[index(id, row.length)]!)
        row.splice(0, row.length, ...selected)
      } else if (step.type === 'add') {
        if (step.mode === 'constant') row.push(step.value ?? '')
        else if (step.mode === 'sequence') row.push(String(rowsIn))
        else {
          const values = (step.columnIds ?? []).map((id) => row[index(id, row.length)]!)
          try { row.push(step.mode === 'concat' ? values.join(step.separator ?? '') : arithmetic(values, step.operator ?? 'add')) }
          catch (error) { throw new CleanPlanError(`第 ${rowsIn} 行计算失败：${error instanceof Error ? error.message : '无效数值'}`) }
        }
      } else if (step.type === 'empty-row') {
        if (row.every((cell) => step.whitespace === 'trim' ? cell.trim() === '' : cell === '')) {
          emptyRows += 1
          await writeEmptyRow(original)
          if (step.mode === 'remove') { changed += 1; continue }
        }
      } else if (step.type === 'filter') {
        const value = row[index(step.columnId, row.length)]!
        const match = step.operator === 'equals' ? value === (step.value ?? '') : step.operator === 'not-equals' ? value !== (step.value ?? '') : step.operator === 'contains' ? value.includes(step.value ?? '') : step.operator === 'is-empty' ? value === '' : value !== ''
        if (match !== (step.action === 'keep')) { changed += 1; continue }
      }
      if (JSON.stringify(row) !== JSON.stringify(original)) changed += 1
      rowsOut += 1
      await write(row)
      onOutput?.(rowsIn, rowsOut)
    }
    if (!headers) throw new CleanPlanError('数据集缺少表头')
    output.end(); await finished(output)
    if (report) { report.end(); await finished(report) }
    return { step: stepNumber, type: step.type, rowsIn, rowsOut, changed, errors, sampleErrors,
      ...(step.type === 'empty-row' ? { emptyRows } : {}) }
  } catch (error) { output.destroy(); report?.destroy(); throw error }
  finally { source.destroy(); parser.destroy() }
}
async function runDedupe(input: string, outputPath: string, step: Extract<CleanStep, { type: 'dedupe' }>,
  stepNumber: number, signal?: AbortSignal, reportPath?: string,
  onOutput?: (inputRow: number, outputRow: number) => void): Promise<CleanStepResult> {
  const sqlitePath = `${outputPath}.dedupe.sqlite`
  const db = new Database(sqlitePath)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE picked (key TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, priority TEXT NOT NULL, count INTEGER NOT NULL);')
  const insert = db.prepare("INSERT INTO picked(key, ordinal, priority, count) VALUES (?, ?, '', 1) ON CONFLICT(key) DO UPDATE SET ordinal=excluded.ordinal, count=picked.count+1")
  const insertFirst = db.prepare("INSERT INTO picked(key, ordinal, priority, count) VALUES (?, ?, '', 1) ON CONFLICT(key) DO UPDATE SET count=picked.count+1")
  const insertPriority = db.prepare('INSERT INTO picked(key, ordinal, priority, count) VALUES (?, ?, ?, 1)')
  const getPriority = db.prepare('SELECT priority FROM picked WHERE key = ?')
  const retainPriority = db.prepare('UPDATE picked SET count=count+1, ordinal=?, priority=? WHERE key=?')
  const countPriority = db.prepare('UPDATE picked SET count=count+1 WHERE key=?')
  let headers: string[] | null = null, rowsIn = 0, rowsOut = 0
  const first = await rows(input, signal)
  try {
    for await (const row of first.parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CleanPlanError('清洗已取消')
      if (!headers) { headers = row; validateCleanPlan({ steps: [step] }, headers); continue }
      rowsIn += 1
      if (row.length !== headers.length) throw new CleanPlanError(`第 ${rowsIn} 行字段数与表头不一致`)
      const key = JSON.stringify(step.columnIds.length ? step.columnIds.map((id) => row[index(id, row.length)]) : row)
      if (step.keep === 'first') insertFirst.run(key, rowsIn)
      else if (step.keep === 'last') insert.run(key, rowsIn)
      else {
        const priority = row[index(step.priorityColumnId!, row.length)]!
        if (priority.length > (step.priorityType === 'decimal' ? 128 : 4096)) throw new CleanPlanError(`第 ${rowsIn} 行去重优先值过长`)
        if (priority !== '' && step.priorityType === 'decimal') {
          try { if (decimal(priority).scale > 36) throw new CleanPlanError('小数位数超过 36') }
          catch { throw new CleanPlanError(`第 ${rowsIn} 行去重优先值不是有限精度小数`) }
        }
        const previous = getPriority.get(key) as { priority: string } | undefined
        if (!previous) insertPriority.run(key, rowsIn, priority)
        else if (comparePriority(priority, previous.priority, step) < 0) retainPriority.run(rowsIn, priority, key)
        else countPriority.run(key)
      }
    }
  } catch (error) { db.close(); await rm(sqlitePath, { force: true }); throw error }
  finally { first.source.destroy(); first.parser.destroy() }
  if (!headers) { db.close(); await rm(sqlitePath, { force: true }); throw new CleanPlanError('数据集缺少表头') }
  const duplicateCounts = db.prepare('SELECT COUNT(*) AS groups, COALESCE(SUM(count), 0) AS members FROM picked WHERE count > 1').get() as { groups: number; members: number }
  const chosen = db.prepare('SELECT ordinal, count FROM picked WHERE key = ?')
  const second = await rows(input, signal)
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const report = reportPath && duplicateCounts.groups ? createWriteStream(reportPath, { flags: 'wx', mode: 0o600 }) : null
  let ordinal = 0
  try {
    if (report && !report.write(csvLine(['步骤', '重复键 JSON', '组内成员数', '输入行号', '是否保留', '排序优先值', '输入记录 JSON']))) await once(report, 'drain')
    for await (const row of second.parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CleanPlanError('清洗已取消')
      if (ordinal === 0) { if (!output.write(csvLine(row))) await once(output, 'drain'); ordinal += 1; continue }
      const key = JSON.stringify(step.columnIds.length ? step.columnIds.map((id) => row[index(id, row.length)]) : row)
      const group = chosen.get(key) as { ordinal: number; count: number } | undefined
      if (!group) throw new CleanPlanError('去重结果与输入记录不一致')
      const kept = group.ordinal === ordinal
      if (kept) { if (!output.write(csvLine(row))) await once(output, 'drain'); rowsOut += 1; onOutput?.(ordinal, rowsOut) }
      if (report && group.count > 1) {
        const line = csvLine([String(stepNumber), key, String(group.count), String(ordinal), kept ? '是' : '否',
          step.keep === 'priority' ? row[index(step.priorityColumnId!, row.length)]! : '', JSON.stringify(row)])
        if (!report.write(line)) await once(report, 'drain')
      }
      ordinal += 1
    }
    output.end(); await finished(output)
    if (report) { report.end(); await finished(report) }
    return { step: stepNumber, type: 'dedupe', rowsIn, rowsOut, changed: rowsIn - rowsOut, errors: 0, sampleErrors: [],
      duplicateGroups: duplicateCounts.groups, duplicateMembers: duplicateCounts.members }
  } catch (error) { output.destroy(); report?.destroy(); throw error }
  finally { second.source.destroy(); second.parser.destroy(); db.close(); await rm(sqlitePath, { force: true }) }
}
async function runBackwardFill(input: string, outputPath: string, step: Extract<CleanStep, { type: 'fill' }>,
  stepNumber: number, signal?: AbortSignal, mayFill?: (row: number) => boolean): Promise<CleanStepResult> {
  const sqlitePath = `${outputPath}.backfill.sqlite`
  const db = new Database(sqlitePath)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE records (ordinal INTEGER PRIMARY KEY, cells TEXT NOT NULL, value TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO records(ordinal,cells,value) VALUES (?,?,?)')
  const inputRows = await rows(input, signal)
  let headers: string[] | null = null, rowsIn = 0, changed = 0
  try {
    for await (const row of inputRows.parser as AsyncIterable<string[]>) {
      if (signal?.aborted) throw new CleanPlanError('清洗已取消')
      if (!headers) { headers = row; validateCleanPlan({ steps: [step] }, headers); continue }
      rowsIn += 1
      if (row.length !== headers.length) throw new CleanPlanError(`第 ${rowsIn} 行字段数与表头不一致`)
      insert.run(rowsIn, JSON.stringify(row), row[index(step.columnId, row.length)]!)
    }
    if (!headers) throw new CleanPlanError('数据集缺少表头')
    const update = db.prepare('UPDATE records SET value = ? WHERE ordinal = ?')
    let next = ''
    for (const record of db.prepare('SELECT ordinal,value FROM records ORDER BY ordinal DESC').iterate() as Iterable<{ ordinal: number; value: string }>) {
      if (signal?.aborted) throw new CleanPlanError('清洗已取消')
      if (record.value === '' && next !== '' && (!mayFill || mayFill(record.ordinal))) { update.run(next, record.ordinal); changed += 1 }
      else if (record.value !== '') next = record.value
    }
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    try {
      output.write(csvLine(headers))
      const at = index(step.columnId, headers.length)
      for (const record of db.prepare('SELECT cells,value FROM records ORDER BY ordinal ASC').iterate() as Iterable<{ cells: string; value: string }>) {
        if (signal?.aborted) throw new CleanPlanError('清洗已取消')
        const row = JSON.parse(record.cells) as string[]
        row[at] = record.value
        if (!output.write(csvLine(row))) await once(output, 'drain')
      }
      output.end(); await finished(output)
    } catch (error) { output.destroy(); throw error }
    return { step: stepNumber, type: 'fill', rowsIn, rowsOut: rowsIn, changed, errors: 0, sampleErrors: [] }
  } finally { inputRows.source.destroy(); inputRows.parser.destroy(); db.close(); await rm(sqlitePath, { force: true }) }
}
/** 按用户顺序逐步执行。每一步完整写入私有临时文件，最终文件由调用方提交。 */
export async function writeCleanPlan(inputPath: string, outputPath: string, plan: CleanPlan, headers: string[],
  signal?: AbortSignal, reportDirectory?: string, cellStateReportPath?: string, maxOriginRow?: number,
  stateOutputPath?: string) {
  const outputHeaders = validateCleanPlan(plan, headers)
  const enabled = plan.steps.map((step, index) => ({ step, index })).filter(({ step }) => step.enabled !== false)
  const temporary: string[] = []
  const stateDbPath = `${outputPath}.cellstate.sqlite`
  const states = cellStateReportPath ? await cellStates(cellStateReportPath, stateDbPath, signal, maxOriginRow) : null
  const lastScoped = stateOutputPath && states ? enabled.length : enabled.reduce((last, { step }, at) => step.type === 'fill' && step.scope && step.scope !== 'all' ? at : last, -1)
  const lineagePath = `${outputPath}.lineage.sqlite`
  const lineage = states && lastScoped > 0 ? new Database(lineagePath) : null
  if (lineage) { lineage.pragma('journal_mode = DELETE'); lineage.exec('CREATE TABLE current (ordinal INTEGER PRIMARY KEY, original_row INTEGER NOT NULL)') }
  let mappedRows = false
  let lookupOriginal: Database.Statement | null = null
  let originalFields = [...headers]
  let current = inputPath
  const results: CleanStepResult[] = []
  const reports: CleanReport[] = []
  try {
    for (let i = 0; i < enabled.length; i += 1) {
      const { step, index: stepIndex } = enabled[i]!
      const target = i === enabled.length - 1 ? outputPath : `${outputPath}.step-${i}`
      if (target !== outputPath) temporary.push(target)
      const reportKind = step.type === 'dedupe' ? 'duplicates' : step.type === 'number' || step.type === 'date' ? 'errors' : step.type === 'empty-row' ? 'empty-rows' : null
      const reportFile = reportKind ? `clean-step-${stepIndex + 1}-${reportKind}.csv` : null
      const reportPath = reportDirectory && reportFile ? join(reportDirectory, reportFile) : undefined
      let mayFill: ((row: number) => boolean) | undefined
      if (step.type === 'fill' && step.scope && step.scope !== 'all') {
        const originalField = originalFields[index(step.columnId, originalFields.length)] ?? ''
        mayFill = (row) => {
          const originalRow = mappedRows ? (lookupOriginal!.get(row) as { original_row: number } | undefined)?.original_row : row
          if (!originalRow) throw new CleanPlanError('空值来源行号无法追溯')
          const state = states?.get(originalRow, originalField) ?? null
          return step.scope === 'empty-text' ? !state : state === step.scope
        }
      }
      const mayRemove = step.type === 'filter' || step.type === 'dedupe' || step.type === 'empty-row' && step.mode === 'remove' ||
        (step.type === 'number' || step.type === 'date') && step.invalid === 'isolate'
      let onOutput: ((inputRow: number, outputRow: number) => void) | undefined
      let flushLineage: (() => void) | undefined
      if (lineage && i < lastScoped && mayRemove) {
        lineage.exec('CREATE TABLE next (ordinal INTEGER PRIMARY KEY, original_row INTEGER NOT NULL)')
        const insert = lineage.prepare('INSERT INTO next(ordinal,original_row) VALUES (?,?)')
        const previous = mappedRows ? lineage.prepare('SELECT original_row FROM current WHERE ordinal=?') : null
        const batch = lineage.transaction((rows: [number, number][]) => { for (const row of rows) insert.run(...row) })
        let pending: [number, number][] = []
        flushLineage = () => { if (pending.length) { batch(pending); pending = [] } }
        onOutput = (inputRow, outputRow) => {
          const originalRow = previous ? (previous.get(inputRow) as { original_row: number } | undefined)?.original_row : inputRow
          if (!originalRow) throw new CleanPlanError('空值来源行号无法追溯')
          pending.push([outputRow, originalRow])
          if (pending.length >= 1000) flushLineage!()
        }
      }
      const result = step.type === 'dedupe' ? await runDedupe(current, target, step, stepIndex + 1, signal, reportPath, onOutput)
        : step.type === 'fill' && step.mode === 'backward' ? await runBackwardFill(current, target, step, stepIndex + 1, signal, mayFill)
          : await runStep(current, target, step, stepIndex + 1, signal, reportPath, mayFill, onOutput)
      results.push(result)
      if (onOutput) {
        flushLineage?.()
        if (result.rowsIn !== result.rowsOut) {
          lineage!.exec('DROP TABLE current; ALTER TABLE next RENAME TO current')
          mappedRows = true
          lookupOriginal = lineage!.prepare('SELECT original_row FROM current WHERE ordinal=?')
        } else lineage!.exec('DROP TABLE next')
      }
      if (step.type === 'columns') originalFields = step.columnIds.map((id) => originalFields[index(id, originalFields.length)] ?? '')
      if (step.type === 'add') originalFields.push('')
      const reportRows = reportKind === 'duplicates' ? result.duplicateMembers ?? 0 : reportKind === 'errors' ? result.errors : result.emptyRows ?? 0
      if (reportFile && reportKind && reportRows > 0) reports.push({ step: stepIndex + 1, kind: reportKind, file: reportFile, rows: reportRows })
      if (current !== inputPath) await rm(current, { force: true })
      current = target
    }
    let cellStateReport: { file: string; rows: number } | undefined
    if (states && stateOutputPath) {
      const finalRows = await rows(outputPath, signal)
      let stateFile: ReturnType<typeof createWriteStream> | null = null
      let outputRow = 0, stateRows = 0, first = true
      try {
        for await (const row of finalRows.parser as AsyncIterable<string[]>) {
          if (signal?.aborted) throw new CleanPlanError('清洗已取消')
          if (first) { first = false; continue }
          outputRow += 1
          const sourceRow = mappedRows ? (lookupOriginal!.get(outputRow) as { original_row: number } | undefined)?.original_row : outputRow
          if (!sourceRow) throw new CleanPlanError('结果空值来源行号无法追溯')
          for (let column = 0; column < row.length; column += 1) {
            if (row[column] !== '' || !originalFields[column]) continue
            const state = states.get(sourceRow, originalFields[column]!)
            if (state !== 'missing' && state !== 'explicit-null') continue
            if (!stateFile) {
              stateFile = createWriteStream(stateOutputPath, { flags: 'wx', mode: 0o600 })
              if (!stateFile.write(csvLine(['源记录号', '输出行号', '字段', '转换说明']))) await once(stateFile, 'drain')
            }
            const description = state === 'missing' ? '缺字段已补为空文本' : '显式 null 已转为空文本'
            if (!stateFile.write(csvLine([String(sourceRow), String(outputRow), outputHeaders[column]!, description]))) await once(stateFile, 'drain')
            stateRows += 1
          }
        }
        if (stateFile) { stateFile.end(); await finished(stateFile); cellStateReport = { file: 'cell-states.csv', rows: stateRows } }
      } catch (error) { stateFile?.destroy(); throw error }
      finally { finalRows.source.destroy(); finalRows.parser.destroy() }
    }
    return { headers: outputHeaders, rowsIn: results[0]!.rowsIn, rowsOut: results.at(-1)!.rowsOut, steps: results, reports, cellStateReport }
  } finally {
    states?.db.close()
    lineage?.close()
    if (states) await rm(stateDbPath, { force: true })
    if (lineage) await rm(lineagePath, { force: true })
    for (const path of temporary) await rm(path, { force: true })
  }
}
