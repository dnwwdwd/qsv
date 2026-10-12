import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import { api } from '@/api/client'
import { KIND_LABEL } from '@/lib/format'
import { useLocale, useT } from '@/ui/locale'
import { NAV_ITEMS, localizeNavItem } from './nav'

const resourceState: Record<string, string> = { staging: '接收中', building: '处理中', ready: '可用', failed: '失败', trashed: '已删除' }
const jobState: Record<string, string> = { draft: '草稿', queued: '排队中', running: '运行中', cancel_requested: '正在取消', cancelled: '已取消', succeeded: '完成', failed: '失败', interrupted: '已中断' }
const resourceStateEn: Record<string, string> = { staging: 'Receiving', building: 'Processing', ready: 'Available', failed: 'Failed', trashed: 'Deleted' }
const jobStateEn: Record<string, string> = { draft: 'Draft', queued: 'Queued', running: 'Running', cancel_requested: 'Cancelling', cancelled: 'Cancelled', succeeded: 'Completed', failed: 'Failed', interrupted: 'Interrupted' }
const kindEn: Record<string, string> = { raw: 'Source file', dataset: 'Dataset', view: 'View', report: 'Report', export: 'Export' }

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const locale = useLocale()
  const t = useT()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const normalized = query.trim()
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(normalized), 150)
    return () => window.clearTimeout(timer)
  }, [normalized])
  const search = useQuery({ queryKey: ['search', debouncedQuery], queryFn: () => api.search(debouncedQuery), enabled: open && debouncedQuery.length > 0 })
  const results = normalized === debouncedQuery ? search.data : undefined
  const entries = useMemo<{ id: string; title: string; detail: string; path: string; keywords?: string; scope?: string }[]>(() => [
    ...NAV_ITEMS.map((source) => localizeNavItem(source, locale)).map((item) => ({ id: item.id, title: item.label, detail: item.description, keywords: item.keyword, path: item.path,
      scope: [item.input && `${locale === 'en-US' ? 'Input' : '输入'}：${item.input}`, item.output && `${locale === 'en-US' ? 'Output' : '输出'}：${item.output}`, item.limit && `${locale === 'en-US' ? 'Limit' : '限制'}：${item.limit}`]
        .filter(Boolean).join(' · ') })),
    ...(results?.resources ?? []).map((item) => ({ id: item.id, title: item.name, detail: `${locale === 'en-US' ? kindEn[item.kind] ?? 'Resource' : KIND_LABEL[item.kind] ?? '资源'} · ${(locale === 'en-US' ? resourceStateEn : resourceState)[item.status] ?? item.status}`, path: `/resources/${item.id}` })),
    ...(results?.jobs ?? []).map((item) => ({ id: item.id, title: item.name, detail: `${locale === 'en-US' ? 'Task' : '任务'} · ${(locale === 'en-US' ? jobStateEn : jobState)[item.state] ?? item.state}`, path: `/jobs/${item.id}` })),
  ].filter((item) => `${item.title} ${item.detail} ${'keywords' in item ? item.keywords : ''} ${'scope' in item ? item.scope : ''}`
    .toLowerCase().includes(normalized.toLowerCase())).slice(0, 40), [normalized, results, locale])
  if (!open) return null
  return <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 pt-24"><button type="button" aria-label={t('关闭检索', 'Close search')} className="absolute inset-0" onClick={onClose} /><div role="dialog" aria-modal="true" aria-label={t('全局检索', 'Global search')} className="relative z-10 w-[640px] max-w-[92vw] overflow-hidden rounded-frame bg-surface shadow-pop"><div className="flex items-center gap-2 border-b border-hairline px-4 py-3"><Search className="size-4 text-ink-3" /><input autoFocus maxLength={100} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); if (event.key === 'Enter' && entries[0]) { onClose(); void navigate({ to: entries[0].path }) } }} aria-label={t('搜索工具、资源和任务', 'Search tools, resources, and tasks')} placeholder={t('搜索工具、资源和任务', 'Search tools, resources, and tasks')} className="w-full bg-transparent text-body text-ink outline-none" /></div><ul className="max-h-[420px] overflow-y-auto py-1.5">{entries.map((entry) => <li key={entry.id}><button type="button" onClick={() => { onClose(); void navigate({ to: entry.path }) }} className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-surface-hover"><span className="min-w-0 flex-1"><span className="block truncate text-cell text-ink">{entry.title}</span>{'scope' in entry && entry.scope ? <span className="mt-0.5 block text-meta text-ink-3">{entry.scope}</span> : null}</span><span className="max-w-48 shrink-0 truncate text-meta text-ink-3">{entry.detail}</span></button></li>)}{search.error && normalized ? <li role="alert" className="px-4 py-3 text-meta text-danger-ink">{t('搜索未完成：', 'Search failed: ')}{search.error.message}</li> : entries.length === 0 ? <li className="px-4 py-6 text-cell text-ink-3">{normalized && (search.isFetching || normalized !== debouncedQuery) ? t('正在搜索…', 'Searching…') : t('没有匹配项', 'No matches')}</li> : null}</ul></div></div>
}
