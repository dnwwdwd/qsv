let displayTimezone = 'Asia/Taipei'
const dayFormatters = new Map<string, Intl.DateTimeFormat>()

export function getDisplayTimezone() { return displayTimezone }

export function setDisplayTimezone(value: string) { displayTimezone = value }

function localDay(timestamp: number, timezone: string): number {
  let formatter = dayFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormatters.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(new Date(timestamp))
  const part = (name: string) => Number(parts.find((item) => item.type === name)?.value ?? 0)
  return part('year') * 10000 + part('month') * 100 + part('day')
}

/** 取所选日历日在保存时区中的起点；跳过的本地日期得到下一日期的起点。 */
export function displayDayStart(date: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`)
  const target = Number(date.replaceAll('-', ''))
  if (!Number.isFinite(utc) || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('日期格式无效')
  const timezone = getDisplayTimezone()
  const step = 30 * 60 * 1000
  const lower = utc - 48 * 60 * 60 * 1000
  const upper = utc + 48 * 60 * 60 * 1000
  for (let probe = lower + step; probe <= upper; probe += step) {
    if (localDay(probe, timezone) < target) continue
    let left = probe - step, right = probe
    while (left + 1 < right) {
      const middle = Math.floor((left + right) / 2)
      if (localDay(middle, timezone) >= target) right = middle
      else left = middle
    }
    return right
  }
  throw new Error('无法确定所选日期在当前时区的起点')
}

export function displayDayEnd(date: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(utc)) throw new Error('日期格式无效')
  const nextDay = new Date(utc + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return displayDayStart(nextDay) - 1
}
