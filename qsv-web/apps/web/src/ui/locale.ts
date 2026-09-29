import { useSyncExternalStore } from 'react'

export type Locale = 'zh-CN' | 'en-US'

const STORAGE_KEY = 'qsv-web:locale:v1'

function readLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-CN'
  try { return window.localStorage.getItem(STORAGE_KEY) === 'en-US' ? 'en-US' : 'zh-CN' }
  catch { return 'zh-CN' }
}

let selectedLocale: Locale = readLocale()
const listeners = new Set<() => void>()

if (typeof document !== 'undefined') document.documentElement.lang = selectedLocale

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function notify() { for (const listener of listeners) listener() }

export function getLocale() { return selectedLocale }

export function setLocale(locale: Locale) {
  if (selectedLocale === locale) return
  selectedLocale = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  try { window.localStorage.setItem(STORAGE_KEY, locale) } catch { /* 当前页面仍可切换语言。 */ }
  notify()
}

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return
  const next = readLocale()
  if (next !== selectedLocale) { selectedLocale = next; document.documentElement.lang = next; notify() }
})

export function useLocale(): Locale { return useSyncExternalStore(subscribe, getLocale, () => 'zh-CN') }

export function useT() {
  useLocale()
  return (zh: string, en: string) => getLocale() === 'en-US' ? en : zh
}
