import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { once } from 'node:events'
import { Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'
import Database from 'better-sqlite3'
import { compileSafePattern } from './safe-pattern.ts'

export type QualityRule =
  | { kind: 'required'; columnId: string }
  | { kind: 'length'; columnId: string; min: number; max: number }
  | { kind: 'enum'; columnId: string; values: string[] }
  | { kind: 'type'; columnId: string; dataType: 'integer' | 'decimal' | 'date' }
  | { kind: 'range'; columnId: string; min: string; max: string }
  | { kind: 'date-order'; columnId: string; otherColumnId: string }
  | { kind: 'pattern'; columnId: string; pattern: string }
  | { kind: 'arithmetic'; columnId: string; leftColumnId: string; rightColumnId: string; tolerance: string }
  | { kind: 'reference'; columnId: string; referenceId: string; referenceColumnId: string }
  | { kind: 'unique'; columnIds: string[] }

export type QualityOutputMode = 'report' | 'valid' | 'invalid'
export type QualitySummary = { checkedRows: number; failedRows: number; violations: number; outputRows: number;
  ruleFailures: number[]; ruleSkipped: number[] }

function encode(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function line(cells: string[]) { return `${cells.map(encode).join(',')}\n` }
function sample(value: string) { return Array.from(value).slice(0, 256).join('') }
function decimal(value: string) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/u.exec(value)
  if (!match || match[2]!.length + (match[3]?.length ?? 0) > 38 || (match[3]?.length ?? 0) > 18) return null
  return { coefficient: BigInt(`${match[1] === '-' ? '-' : ''}${match[2]}${match[3] ?? ''}`), scale: match[3]?.length ?? 0 }
}
function compareDecimal(left: string, right: string) {
  const a = decimal(left)
  const b = decimal(right)
  if (!a || !b) return null
  const scale = Math.max(a.scale, b.scale)
  const delta = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale)
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}
export function validDecimalRange(min: string, max: string) {
  const order = compareDecimal(min, max)
  return order !== null && order <= 0
}
export function validTolerance(value: string) { const parsed = decimal(value); return parsed !== null && parsed.coefficient >= 0n }
function multiplicationWithin(amount: string, left: string, right: string, tolerance: string) {
  const amountValue = decimal(amount); const leftValue = decimal(left); const rightValue = decimal(right); const allowed = decimal(tolerance)
  if (!amountValue || !leftValue || !rightValue || !allowed) return null
  const product = leftValue.coefficient * rightValue.coefficient
  const productScale = leftValue.scale + rightValue.scale
  const scale = Math.max(amountValue.scale, productScale, allowed.scale)
  const difference = amountValue.coefficient * 10n ** BigInt(scale - amountValue.scale) - product * 10n ** BigInt(scale - productScale)
  const limit = allowed.coefficient * 10n ** BigInt(scale - allowed.scale)
  return (difference < 0n ? -difference : difference) <= limit
}
function isDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return false
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

export type ReferenceInput = { path: string; rowCount: number; columnCount: number }

async function qualityIndex(inputPath: string, databasePath: string, rules: QualityRule[],
  references: Record<string, ReferenceInput>, signal?: AbortSignal) {
  const db = new Database(databasePath)
  db.pragma('journal_mode = DELETE')
  db.exec('CREATE TABLE keys (rule_index INTEGER NOT NULL, key TEXT NOT NULL, occurrences INTEGER NOT NULL, PRIMARY KEY(rule_index,key)) WITHOUT ROWID; CREATE TABLE reference_values (rule_index INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(rule_index,value)) WITHOUT ROWID')
  const insert = db.prepare('INSERT INTO keys(rule_index,key,occurrences) VALUES (?,?,1) ON CONFLICT(rule_index,key) DO UPDATE SET occurrences=occurrences+1')
  const batchInsert = db.transaction((entries: Array<[number, string]>) => { for (const [index, key] of entries) insert.run(index, key) })
  try {
    if (rules.some((rule) => rule.kind === 'unique')) {
      const source = createReadStream(inputPath, { signal })
      const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
      source.on('error', (error) => parser.destroy(error))
      source.pipe(parser)
      let width = -1
      const batch: Array<[number, string]> = []
      try {
        for await (const row of parser as AsyncIterable<string[]>) {
          if (width < 0) { width = row.length; continue }
          if (row.length !== width) throw new Error('唯一性检查输入字段数不一致')
          for (let index = 0; index < rules.length; index += 1) {
            const rule = rules[index]!
            if (rule.kind !== 'unique') continue
            const values = rule.columnIds.map((id) => row[Number(id.slice(2))] ?? '')
            if (values.some((value) => value === '')) continue
            const key = JSON.stringify(values)
            if (Buffer.byteLength(key, 'utf8') > 8192) throw new Error('唯一键内容超过 8 KiB，上限内无法完整核对')
            batch.push([index, key])
          }
          if (batch.length >= 1000) batchInsert(batch.splice(0))
        }
        if (batch.length) batchInsert(batch)
      } finally { source.destroy(); parser.destroy() }
    }
    const insertReference = db.prepare('INSERT OR IGNORE INTO reference_values(rule_index,value) VALUES (?,?)')
    const batchReference = db.transaction((entries: Array<[number, string]>) => { for (const [index, value] of entries) insertReference.run(index, value) })
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index]!
      if (rule.kind !== 'reference') continue
      const reference = references[rule.referenceId]
      if (!reference) throw new Error('固定参考数据不可用')
      const source = createReadStream(reference.path, { signal })
      const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
      source.on('error', (error) => parser.destroy(error))
      source.pipe(parser)
      const column = Number(rule.referenceColumnId.slice(2))
      let rows = 0
      let headers: string[] | null = null
      let pending: Array<[number, string]> = []
      try {
        for await (const row of parser as AsyncIterable<string[]>) {
          if (!headers) { headers = row; if (row.length !== reference.columnCount) throw new Error('参考数据字段数已改变'); continue }
          rows += 1
          if (row.length !== headers.length) throw new Error(`参考数据第 ${rows} 行字段数不一致`)
          const value = row[column] ?? ''
          if (Buffer.byteLength(value) > 8192) throw new Error('参考值超过 8 KiB')
          if (value !== '') pending.push([index, value])
          if (pending.length >= 1000) { batchReference(pending); pending = [] }
        }
        if (!headers || rows !== reference.rowCount) throw new Error('参考数据记录数已改变')
        if (pending.length) batchReference(pending)
      } finally { source.destroy(); parser.destroy() }
    }
    return db
  } catch (error) { db.close(); await rm(databasePath, { force: true }); throw error }
}

/** 单次全表扫描，逐项记录违反的规则。报告值只展示有限预览，源行仍可回到固定输入资源读取。 */
export async function writeQualityReport(inputPath: string, outputPath: string, rules: QualityRule[], signal?: AbortSignal,
  references: Record<string, ReferenceInput> = {}, outputMode: QualityOutputMode = 'report', rowMapPath?: string) {
  const databasePath = `${outputPath}.keys.sqlite`
  const keyDb = rules.some((rule) => rule.kind === 'unique' || rule.kind === 'reference')
    ? await qualityIndex(inputPath, databasePath, rules, references, signal) : null
  const lookup = keyDb?.prepare('SELECT occurrences FROM keys WHERE rule_index=? AND key=?')
  const lookupReference = keyDb?.prepare('SELECT 1 FROM reference_values WHERE rule_index=? AND value=?')
  const patterns = rules.map((rule) => rule.kind === 'pattern' ? compileSafePattern(rule.pattern) : null)
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  const summary: QualitySummary = { checkedRows: 0, failedRows: 0, violations: 0, outputRows: 0,
    ruleFailures: rules.map(() => 0), ruleSkipped: rules.map(() => 0) }
  let width = 0
  let first = true
  const rowMap = rowMapPath && outputMode !== 'report' ? createWriteStream(rowMapPath, { flags: 'wx', mode: 0o600 }) : null
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      if (first) {
        first = false
        width = row.length
        callback(null, outputMode === 'report' ? line(['sourceRow', 'columnId', 'ruleIndex', 'ruleKind', 'message', 'valuePreview', 'duplicateGroupId']) : line(row))
        return
      }
      if (row.length !== width) throw new Error(`第 ${summary.checkedRows + 1} 行字段数不一致`)
      summary.checkedRows += 1
      let failed = false
      const details: string[] = []
      for (let i = 0; i < rules.length; i += 1) {
        const rule = rules[i]!
        const value = rule.kind === 'unique' ? JSON.stringify(rule.columnIds.map((id) => row[Number(id.slice(2))] ?? ''))
          : row[Number(rule.columnId.slice(2))] ?? ''
        let message = ''
        if ((rule.kind === 'type' || rule.kind === 'range' || rule.kind === 'pattern' || rule.kind === 'reference') && value === '' ||
          rule.kind === 'arithmetic' && (value === '' || row[Number(rule.leftColumnId.slice(2))] === '' || row[Number(rule.rightColumnId.slice(2))] === '') ||
          rule.kind === 'date-order' && (value === '' || row[Number(rule.otherColumnId.slice(2))] === '')) {
          summary.ruleSkipped[i] = (summary.ruleSkipped[i] ?? 0) + 1
          continue
        }
        if (rule.kind === 'required' && value === '') message = '必填字段为空'
        if (rule.kind === 'length' && (Array.from(value).length < rule.min || Array.from(value).length > rule.max)) {
          message = `文本长度不在 ${rule.min}—${rule.max} 之间`
        }
        if (rule.kind === 'enum' && !rule.values.includes(value)) message = '值不在允许列表中'
        if (rule.kind === 'type' && (rule.dataType === 'integer' ? !/^[+-]?\d+$/u.test(value) :
          rule.dataType === 'decimal' ? !decimal(value) : !isDate(value))) message = `值不符合 ${rule.dataType} 类型`
        if (rule.kind === 'range') {
          const lower = compareDecimal(value, rule.min)
          const upper = compareDecimal(value, rule.max)
          if (lower === null || upper === null || lower < 0 || upper > 0) message = `数值不在 ${rule.min}—${rule.max} 之间或无法解析`
        }
        if (rule.kind === 'date-order') {
          const other = row[Number(rule.otherColumnId.slice(2))] ?? ''
          if (!isDate(value) || !isDate(other) || value > other) message = '开始日期晚于结束日期或日期无效'
        }
        if (rule.kind === 'pattern' && !patterns[i]!(value)) message = '文本不符合指定表达式'
        if (rule.kind === 'arithmetic') {
          const okay = multiplicationWithin(value, row[Number(rule.leftColumnId.slice(2))] ?? '',
            row[Number(rule.rightColumnId.slice(2))] ?? '', rule.tolerance)
          if (okay === null) message = '参与计算的值无法按十进制数解析'
          else if (!okay) message = `金额不等于数量乘单价，允许差额 ${rule.tolerance}`
        }
        if (rule.kind === 'reference' && !lookupReference?.get(i, value)) message = '值不在固定参考数据中'
        if (rule.kind === 'unique') {
          const values = rule.columnIds.map((id) => row[Number(id.slice(2))] ?? '')
          if (values.some((item) => item === '')) message = '唯一键包含空值'
          else {
            const found = lookup?.get(i, JSON.stringify(values)) as { occurrences: number } | undefined
            if (found && found.occurrences > 1) message = `重复键，共 ${found.occurrences} 条成员`
          }
        }
        if (message) {
          failed = true
          summary.violations += 1
          summary.ruleFailures[i] = (summary.ruleFailures[i] ?? 0) + 1
          if (summary.violations > 5_000_000) throw new Error('异常记录超过 500 万条上限')
          details.push(line([String(summary.checkedRows), rule.kind === 'unique' ? rule.columnIds.join('+') : rule.columnId,
            String(i + 1), rule.kind, message, sample(value),
            outputMode === 'report' && rule.kind === 'unique' && message.startsWith('重复键')
              ? createHash('sha256').update(value).digest('hex') : '']))
        }
      }
      if (failed) summary.failedRows += 1
      const output = outputMode === 'report' ? details.join('') :
        outputMode === 'valid' && !failed || outputMode === 'invalid' && failed ? line(row) : ''
      summary.outputRows += outputMode === 'report' ? details.length : output ? 1 : 0
      if (output && rowMap) {
        if (!rowMap.write(line([String(summary.outputRows), String(summary.checkedRows)]))) {
          void once(rowMap, 'drain').then(() => callback(null, output), (error: unknown) => callback(error as Error))
          return
        }
      }
      callback(null, output)
    } catch (error) { callback(error as Error) }
  } })
  rowMap?.on('error', (error) => encoder.destroy(error))
  try {
    await pipeline(createReadStream(inputPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
    if (first) throw new Error('数据集缺少表头')
    if (rowMap) { rowMap.end(); await finished(rowMap) }
    return summary
  } catch (error) { rowMap?.destroy(); throw error }
  finally { keyDb?.close(); if (keyDb) await rm(databasePath, { force: true }) }
}
