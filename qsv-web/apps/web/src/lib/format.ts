import { getLocale } from '@/ui/locale'
import { getDisplayTimezone } from '@/ui/timezone'

const NUMBER_ZH = new Intl.NumberFormat('zh-CN')
const NUMBER_EN = new Intl.NumberFormat('en-US')
const DATE_TIME_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return getLocale() === 'en-US' ? 'Unknown' : '未知'
  return (getLocale() === 'en-US' ? NUMBER_EN : NUMBER_ZH).format(value)
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return getLocale() === 'en-US' ? 'Unknown' : '未知'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}

export function formatDateTime(value: number | null | undefined): string {
  if (!value) return '—'
  const timezone = getDisplayTimezone()
  let formatter = DATE_TIME_FORMATTERS.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    DATE_TIME_FORMATTERS.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(new Date(value))
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${timezone}`
}

export function formatDuration(ms: number | null | undefined): string {
  const en = getLocale() === 'en-US'
  if (ms === null || ms === undefined) return en ? 'Not finished' : '未完成'
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return en ? `${seconds.toFixed(1)} sec` : `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  if (minutes < 60) return en ? `${minutes} min ${rest} sec` : `${minutes} 分 ${rest} 秒`
  const hours = Math.floor(minutes / 60)
  return en ? `${hours} hr ${minutes % 60} min` : `${hours} 小时 ${minutes % 60} 分`
}

export function formatRelative(value: number | null | undefined): string {
  if (!value) return '—'
  const en = getLocale() === 'en-US'
  const diff = Date.now() - value
  if (diff < 0) {
    const ahead = Math.abs(diff)
    if (ahead < 3600_000) return en ? `in ${Math.max(1, Math.round(ahead / 60_000))} min` : `${Math.max(1, Math.round(ahead / 60_000))} 分钟后`
    return en ? `in ${Math.round(ahead / 3600_000)} hr` : `${Math.round(ahead / 3600_000)} 小时后`
  }
  if (diff < 60_000) return en ? 'Just now' : '刚刚'
  if (diff < 3600_000) return en ? `${Math.round(diff / 60_000)} min ago` : `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return en ? `${Math.round(diff / 3600_000)} hr ago` : `${Math.round(diff / 3600_000)} 小时前`
  return en ? `${Math.round(diff / 86_400_000)} days ago` : `${Math.round(diff / 86_400_000)} 天前`
}

export const KIND_LABEL: Record<string, string> = {
  raw: '原文件',
  dataset: '数据集',
  report: '报告',
  export: '导出文件',
  view: '视图',
}

const KIND_LABEL_EN: Record<string, string> = {
  raw: 'Original file',
  dataset: 'Dataset',
  report: 'Report',
  export: 'Exported file',
  view: 'View',
}

export function kindLabel(kind: string): string {
  return (getLocale() === 'en-US' ? KIND_LABEL_EN : KIND_LABEL)[kind] ?? kind
}

export const FORMAT_LABEL: Record<string, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  xlsx: 'XLSX',
  xls: 'XLS',
  xlsm: 'XLSM',
  ods: 'ODS',
  json: 'JSON',
  jsonl: 'JSONL',
  parquet: 'Parquet',
}
