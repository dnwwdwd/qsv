export interface UserSettings {
  defaultEncoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
  timezone: string
  outputFormat: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'
  safeText: boolean
}

export const DEFAULT_SETTINGS: UserSettings = {
  defaultEncoding: 'utf-8', timezone: 'Asia/Taipei', outputFormat: 'csv', safeText: true,
}

export class SettingsError extends Error {}

export function validateUserSettings(raw: unknown): UserSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SettingsError('默认设置无效')
  const value = raw as Record<string, unknown>
  if (Object.keys(value).some((key) => !['defaultEncoding', 'timezone', 'outputFormat', 'safeText'].includes(key)) ||
    !['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(String(value.defaultEncoding)) ||
    !['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet'].includes(String(value.outputFormat)) ||
    typeof value.safeText !== 'boolean' || typeof value.timezone !== 'string' || value.timezone.length < 1 ||
    value.timezone.length > 64 || /[\x00-\x1f\x7f]/u.test(value.timezone)) throw new SettingsError('默认设置无效')
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }) }
  catch { throw new SettingsError('日期时区无效，请输入 IANA 时区名称') }
  return value as unknown as UserSettings
}
