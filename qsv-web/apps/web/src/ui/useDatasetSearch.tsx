import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { formatNumber } from '@/lib/format'
import { Button } from './Button'
import { useT } from './locale'

/** Keep resource selection usable when the workspace has more resources than the first list page. */
export function useDatasetSearch(scope: string, kind: 'dataset' | 'raw' = 'dataset') {
  const t = useT()
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const name = search.trim()
  const results = useQuery({ queryKey: ['resource-search', scope, kind, name, offset],
    queryFn: () => api.findResources({ name, kind, status: 'ready' }, offset, 100), enabled: Boolean(name) })
  const controls = <div className="max-w-sm space-y-2"><label className="block space-y-1 text-meta text-ink-3">{kind === 'dataset' ? t('按名称查找数据集', 'Find dataset by name') : t('按名称查找原文件', 'Find original file by name')}
    <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setOffset(0) }}
      placeholder={t('可查找列表第一页以外的数据集', 'Search beyond the first resource page')}
      className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
    {name ? <div className="flex items-center gap-2"><Button size="sm" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 100))}>{t('上一段', 'Previous')}</Button>
      <span className="text-meta text-ink-3">{results.isLoading ? t('正在查找…', 'Searching…') : t(`${formatNumber(results.data?.total)} 项匹配`, `${formatNumber(results.data?.total)} matches`)}</span>
      <Button size="sm" disabled={offset + 100 >= (results.data?.total ?? 0)} onClick={() => setOffset((value) => value + 100)}>{t('下一段', 'Next')}</Button></div> : null}
    {results.error ? <p className="text-meta text-danger-ink">{results.error.message}</p> : null}</div>
  return { items: results.data?.items ?? [], controls }
}
