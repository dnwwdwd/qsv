import { createReadStream } from 'node:fs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'
import type { CleanPlan } from './clean-plan.ts'
import type { CellPatch } from './cell-edit.ts'

export type ColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date'
export class ColumnTypeError extends Error {}

export function columnTypes(value: unknown): Record<string, ColumnType> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ColumnTypeError('字段类型配置无效')
  const entries = Object.entries(value)
  if (entries.length > 4096 || entries.some(([id, type]) => !/^c_(0|[1-9]\d{0,3})$/u.test(id) || Number(id.slice(2)) >= 4096 ||
    !['string', 'integer', 'decimal', 'boolean', 'date'].includes(String(type)))) throw new ColumnTypeError('字段类型配置无效')
  return Object.fromEntries(entries) as Record<string, ColumnType>
}

/** 派生数据只继承未改动字段的已确认类型。文本变换和任意修正会撤销该字段的类型确认。 */
export function derivedColumnTypes(source: Record<string, ColumnType>, width: number, operation: string,
  options: { columnId?: string; mode?: string; plan?: CleanPlan; patches?: CellPatch[] } = {}) {
  let types: ColumnType[] = Array.from({ length: width }, (_, index) => source[`c_${index}`] ?? 'string')
  if (operation === 'clean.plan' && options.plan) {
    for (const step of options.plan.steps) {
      if (step.enabled === false) continue
      if (step.type === 'columns') {
        types = step.columnIds.map((id) => types[Number(id.slice(2))] ?? 'string')
      } else if (step.type === 'add') {
        types.push(step.mode === 'sequence' ? 'integer' : step.mode === 'arithmetic' ? 'decimal' : 'string')
      } else if (step.type === 'text' || step.type === 'fill') {
        types[Number(step.columnId.slice(2))] = 'string'
      } else if (step.type === 'number') {
        types[Number(step.columnId.slice(2))] = step.invalid === 'keep' ? 'string' : step.decimals === 0 ? 'integer' : 'decimal'
      } else if (step.type === 'date') {
        types[Number(step.columnId.slice(2))] = step.invalid === 'keep' || step.format === 'iso-time' || step.format === 'iso-local-time' ? 'string' : 'date'
      }
    }
  } else if (operation === 'cell.edit') {
    for (const patch of options.patches ?? []) {
      if (patch.newValue !== patch.expectedOldValue) types[Number(patch.columnId.slice(2))] = 'string'
    }
  } else if (operation === 'clean.column' && options.columnId) {
    types[Number(options.columnId.slice(2))] = options.mode === 'date-iso' ? 'date' : 'string'
  }
  return Object.fromEntries(types.flatMap((type, index) => type === 'string' ? [] : [[`c_${index}`, type]])) as Record<string, ColumnType>
}

function isCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
}

function matches(value: string, type: ColumnType) {
  if (value === '' || type === 'string') return true
  if (type === 'integer') return /^[+-]?\d+$/u.test(value)
  if (type === 'decimal') return /^[+-]?\d+(?:\.\d+)?$/u.test(value)
  if (type === 'boolean') return value === 'true' || value === 'false'
  return isCalendarDate(value)
}

/** 类型只作为已确认的字段元信息；原始文本保持不变。 */
export async function validateColumnTypes(path: string, width: number, selected: Record<string, ColumnType>, signal?: AbortSignal) {
  const configured = Object.entries(selected).filter(([, type]) => type !== 'string').map(([id, type]) => ({ index: Number(id.slice(2)), type }))
  if (configured.some(({ index }) => index >= width)) throw new ColumnTypeError('字段类型配置与解析后的字段数不一致')
  if (!configured.length) return
  let rowNumber = 0
  const sink = new Writable({ objectMode: true, write(row: string[], _encoding, callback) {
    rowNumber += 1
    if (rowNumber === 1) { callback(); return }
    for (const { index, type } of configured) {
      if (!matches(row[index] ?? '', type)) {
        callback(new ColumnTypeError(`第 ${rowNumber - 1} 条数据记录的第 ${index + 1} 列不符合已选的 ${type} 类型`))
        return
      }
    }
    callback()
  } })
  try {
    await pipeline(createReadStream(path), parse({ bom: true, relax_quotes: false, relax_column_count: false,
      max_record_size: 8 * 1024 * 1024 }), sink, { signal })
  } catch (error) {
    if (error instanceof ColumnTypeError) throw error
    throw new ColumnTypeError(signal?.aborted ? '字段类型检查已取消' : '字段类型检查时无法读取完整数据集')
  }
}
