import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'

function cell(value: string) {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** 对一个字段做 Unicode 标准化，逐条读取并保持其余字段原值。 */
export async function normalizeColumn(inputPath: string, outputPath: string, columnIndex: number,
  form: 'NFC' | 'NFKC', signal?: AbortSignal) {
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  let width = 0
  let records = 0
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      if (records === 0) width = row.length
      if (row.length !== width || columnIndex >= width) throw new Error('记录字段数不一致')
      if (records > 0) row[columnIndex] = row[columnIndex]!.normalize(form)
      records += 1
      callback(null, `${row.map(cell).join(',')}\n`)
    } catch (error) { callback(error as Error) }
  } })
  await pipeline(createReadStream(inputPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
  if (records === 0) throw new Error('数据集缺少字段')
  return { rows: records - 1 }
}

export type DateInputFormat = 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy'

export class DateValidationError extends Error {}

export function calendarDate(value: string, inputFormat: DateInputFormat, rowNumber: number) {
  if (value === '') return value
  const separator = inputFormat.includes('/') ? '/' : '-'
  const parts = value.split(separator)
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/u.test(part))) throw new DateValidationError(`第 ${rowNumber} 行日期不符合所选格式`)
  const yearIndex = inputFormat.startsWith('yyyy') ? 0 : 2
  const monthIndex = inputFormat.startsWith('MM') ? 0 : 1
  const dayIndex = inputFormat.startsWith('dd') ? 0 : inputFormat.startsWith('MM') ? 1 : 2
  const year = Number(parts[yearIndex])
  const month = Number(parts[monthIndex])
  const day = Number(parts[dayIndex])
  if (parts[yearIndex]?.length !== 4 || parts[monthIndex]?.length !== 2 || parts[dayIndex]?.length !== 2 ||
    year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new DateValidationError(`第 ${rowNumber} 行日期不符合所选格式`)
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new DateValidationError(`第 ${rowNumber} 行不是有效日历日期`)
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function validUtcOffset(value: string) {
  if (value === 'Z') return true
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(value)
  if (!match) return false
  const hours = Number(match[2]), minutes = Number(match[3])
  return hours <= 14 && minutes <= 59 && (hours < 14 || minutes === 0)
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()
const zoneOffsetCandidates = new Map<string, number[]>()

export function validIanaTimeZone(value: string) {
  if (typeof value !== 'string' || value.length > 64 ||
    !/^(?:UTC|[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+)$/u.test(value)) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); return true }
  catch { return false }
}

function zoneFormatter(zone: string) {
  let formatter = zoneFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    zoneFormatters.set(zone, formatter)
  }
  return formatter
}

function utcFields(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number) {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day ||
    date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new DateValidationError('日期时间无效')
  }
  return date.getTime()
}

function zoneFields(instant: number, zone: string) {
  const fields = Object.fromEntries(zoneFormatter(zone).formatToParts(new Date(instant))
    .filter((part) => ['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type))
    .map((part) => [part.type, Number(part.value)])) as Record<string, number>
  if (Object.values(fields).some((value) => !Number.isSafeInteger(value)) || Object.keys(fields).length !== 6) {
    throw new DateValidationError('时区日期无法表示')
  }
  return { year: fields.year!, month: fields.month!, day: fields.day!, hour: fields.hour!,
    minute: fields.minute!, second: fields.second! }
}

function zoneOffsetMinutes(instant: number, zone: string) {
  const parts = zoneFields(instant, zone)
  if (parts.year < 1 || parts.year > 9999) throw new DateValidationError('时区日期超出可表示范围')
  const local = utcFields(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, new Date(instant).getUTCMilliseconds())
  const delta = local - instant
  if (delta % 60_000 !== 0) throw new DateValidationError('该历史时区偏移含秒，不能无损写为 ISO 时间点')
  return delta / 60_000
}

function offsetsNearLocalDate(wallTime: number, zone: string, date: string) {
  const key = `${zone}|${date}`
  const cached = zoneOffsetCandidates.get(key)
  if (cached) return cached
  const offsets = new Set<number>()
  for (let hours = -48; hours <= 48; hours += 6) offsets.add(zoneOffsetMinutes(wallTime + hours * 3_600_000, zone))
  const candidates = [...offsets]
  if (zoneOffsetCandidates.size >= 512) zoneOffsetCandidates.delete(zoneOffsetCandidates.keys().next().value!)
  zoneOffsetCandidates.set(key, candidates)
  return candidates
}

function offsetText(minutes: number) {
  if (minutes === 0) return 'Z'
  const absolute = Math.abs(minutes)
  const result = `${minutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
  if (!validUtcOffset(result)) throw new DateValidationError('输出时区偏移无法表示')
  return result
}

/** 将没有偏移的本地时间按显式 IANA 时区解释；不存在或重复的墙上时间必须由用户修正。 */
export function ianaLocalTimestamp(value: string, inputZone: string, outputZone: string, rowNumber: number) {
  if (value === '') return value
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value)
  if (!match) throw new DateValidationError(`第 ${rowNumber} 行须使用不含偏移的 ISO 日期时间`)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'))
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new DateValidationError(`第 ${rowNumber} 行日期时间无效`)
  }
  const wallTime = utcFields(year, month, day, hour, minute, second, millisecond)
  const candidates = offsetsNearLocalDate(wallTime, inputZone, `${match[1]}-${match[2]}-${match[3]}`)
    .map((offset) => wallTime - offset * 60_000)
    .filter((instant) => {
      const local = zoneFields(instant, inputZone)
      return local.year === year && local.month === month && local.day === day && local.hour === hour &&
        local.minute === minute && local.second === second
    })
  if (candidates.length !== 1) throw new DateValidationError(`第 ${rowNumber} 行本地时间不存在或有两个可能的时间点；请提供明确偏移`)
  const instant = candidates[0]!
  const target = zoneFields(instant, outputZone)
  if (target.year < 1 || target.year > 9999) throw new DateValidationError(`第 ${rowNumber} 行输出日期超出可表示范围`)
  return `${String(target.year).padStart(4, '0')}-${String(target.month).padStart(2, '0')}-${String(target.day).padStart(2, '0')}` +
    `T${String(target.hour).padStart(2, '0')}:${String(target.minute).padStart(2, '0')}:${String(target.second).padStart(2, '0')}` +
    `.${String(millisecond).padStart(3, '0')}${offsetText(zoneOffsetMinutes(instant, outputZone))}`
}

function offsetMinutes(value: string) {
  if (!validUtcOffset(value)) throw new DateValidationError('时区偏移格式无效')
  if (value === 'Z') return 0
  return (value[0] === '-' ? -1 : 1) * (Number(value.slice(1, 3)) * 60 + Number(value.slice(4, 6)))
}

/** 带明确偏移的时间点转换到指定固定偏移；不推断本地时区或夏令时。 */
export function zonedTimestamp(value: string, outputOffset: string, rowNumber: number) {
  if (value === '') return value
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value)
  if (!match) throw new DateValidationError(`第 ${rowNumber} 行时间点须包含日期、时间和明确时区偏移`)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'))
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new DateValidationError(`第 ${rowNumber} 行时间点无效`)
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, millisecond)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw new DateValidationError(`第 ${rowNumber} 行不是有效日历日期`)
  }
  const instant = date.getTime() - offsetMinutes(match[8]!) * 60_000
  const target = new Date(instant + offsetMinutes(outputOffset) * 60_000)
  if (target.getUTCFullYear() < 1 || target.getUTCFullYear() > 9999) throw new DateValidationError(`第 ${rowNumber} 行时间点超出可表示范围`)
  return `${String(target.getUTCFullYear()).padStart(4, '0')}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(target.getUTCDate()).padStart(2, '0')}` +
    `T${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}:${String(target.getUTCSeconds()).padStart(2, '0')}` +
    `.${String(target.getUTCMilliseconds()).padStart(3, '0')}${outputOffset}`
}

/** 仅处理日历日期，不把本地日期转换成时间点。非空无效值会阻止任务提交结果。 */
export async function normalizeDateColumn(inputPath: string, outputPath: string, columnIndex: number,
  inputFormat: DateInputFormat, signal?: AbortSignal) {
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  let width = 0
  let records = 0
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      if (records === 0) width = row.length
      if (row.length !== width || columnIndex >= width) throw new Error(`第 ${records} 行字段数不一致`)
      if (records > 0) row[columnIndex] = calendarDate(row[columnIndex]!, inputFormat, records)
      records += 1
      callback(null, `${row.map(cell).join(',')}\n`)
    } catch (error) { callback(error as Error) }
  } })
  await pipeline(createReadStream(inputPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
  if (records === 0) throw new Error('数据集缺少字段')
  return { rows: records - 1 }
}
