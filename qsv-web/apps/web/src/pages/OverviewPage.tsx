import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, FileUp, RefreshCw } from 'lucide-react'
import { api, type Job, type Resource } from '@/api/client'
import { formatBytes, formatDateTime, formatNumber, KIND_LABEL } from '@/lib/format'
import { Button } from '@/ui/Button'
import { Metric, MetricStrip } from '@/ui/Data'
import { Banner, EmptyState, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { useLocale, useT } from '@/ui/locale'
import { localizedStage } from '@/lib/stage'

const jobState: Record<Job['state'], string> = {
  draft: '草稿', queued: '排队中', running: '运行中', cancel_requested: '正在取消',
  cancelled: '已取消', succeeded: '完成', failed: '失败', interrupted: '已中断',
}
const jobStateEn: Record<Job['state'], string> = {
  draft: 'Draft', queued: 'Queued', running: 'Running', cancel_requested: 'Cancelling',
  cancelled: 'Cancelled', succeeded: 'Completed', failed: 'Failed', interrupted: 'Interrupted',
}
const kindEn: Record<Resource['kind'], string> = { raw: 'Source file', dataset: 'Dataset', view: 'View', report: 'Report', export: 'Export' }

function RecentResource({ item }: { item: Resource }) {
  const locale = useLocale()
  const t = useT()
  const canOpen = item.kind === 'dataset' && item.status === 'ready'
  return <li className="flex min-w-0 items-center gap-3 border-b border-hairline-soft py-3 last:border-b-0">
    <span className="min-w-0 flex-1"><span className="block truncate text-cell font-medium text-ink" title={item.name}>{item.name}</span><span className="mt-0.5 block text-meta text-ink-3">{locale === 'en-US' ? kindEn[item.kind] : KIND_LABEL[item.kind] ?? item.kind} · {item.status === 'ready' ? t('可用', 'Available') : item.status === 'building' ? t('处理中', 'Processing') : item.status === 'failed' ? t('失败', 'Failed') : item.status} · {formatDateTime(item.updatedAt)}</span></span>
    {item.rowCount !== null ? <span className="figure hidden shrink-0 text-meta text-ink-3 sm:block">{t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</span> : null}
    {canOpen ? <Link to="/datasets/$resourceId" params={{ resourceId: item.id }} className="press shrink-0 text-meta text-accent-ink hover:underline">{t('浏览', 'Browse')}</Link> : <Link to="/resources/$resourceId" params={{ resourceId: item.id }} className="press shrink-0 text-meta text-accent-ink hover:underline">{t('查看', 'View')}</Link>}
  </li>
}

function RecentJob({ item }: { item: Job }) {
  const locale = useLocale()
  const t = useT()
  return <li className="flex min-w-0 items-center gap-3 border-b border-hairline-soft py-3 last:border-b-0">
    <span className="min-w-0 flex-1"><span className="block truncate text-cell font-medium text-ink" title={item.name}>{item.name}</span><span className="mt-0.5 block truncate text-meta text-ink-3">{item.progress.stage ? localizedStage(item.progress.stage) : (locale === 'en-US' ? jobStateEn[item.state] : jobState[item.state])} · {formatDateTime(item.updatedAt)}</span></span>
    <span className={`shrink-0 text-meta ${item.state === 'failed' || item.state === 'interrupted' ? 'text-danger-ink' : item.state === 'succeeded' ? 'text-ok-ink' : 'text-ink-2'}`}>{locale === 'en-US' ? jobStateEn[item.state] : jobState[item.state]}</span>
    <Link to="/jobs/$jobId" params={{ jobId: item.id }} className="press shrink-0 text-meta text-accent-ink hover:underline">{t('查看', 'View')}</Link>
  </li>
}

export function OverviewPage() {
  const locale = useLocale()
  const t = useT()
  const client = useQueryClient()
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 5000 })
  const resources = useQuery({ queryKey: ['resources', 'overview'], queryFn: () => api.resourcePage(0, 5), refetchInterval: 5000 })
  const jobs = useQuery({ queryKey: ['jobs', 'overview'], queryFn: () => api.jobPage(0, 5), refetchInterval: 5000 })
  const storage = useQuery({ queryKey: ['storage'], queryFn: api.storage, refetchInterval: 15000 })
  const error = overview.error ?? resources.error ?? jobs.error ?? storage.error
  const ready = Boolean(overview.data && resources.data && jobs.data)
  const hasActivity = (overview.data?.resources ?? 0) > 0 || (overview.data?.jobs ?? 0) > 0
  const attention = overview.data?.attentionJobs ?? []
  const refresh = () => { void Promise.all(['overview', 'resources', 'jobs', 'storage'].map((key) => client.invalidateQueries({ queryKey: [key] }))) }

  return <><PageTopBar title={t('概览', 'Overview')} hint={t('当前空间的资源、任务和需要处理的事项', 'Resources, tasks, and items needing attention in this workspace')} actions={<><Button size="sm" variant="quiet" leading={<RefreshCw className="size-4" />} onClick={refresh}>{t('刷新', 'Refresh')}</Button><Link to="/import" className="press inline-flex h-8.5 items-center gap-1.5 rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse shadow-rail hover:bg-accent-hover"><FileUp className="size-4" />{t('导入文件', 'Import file')}</Link></>} />
    <PageBody className="space-y-6">
      {error ? <Banner tone="danger" title={t('概览暂时无法完整读取', 'Could not load the full overview')}>{error instanceof Error ? error.message : t('请稍后刷新', 'Refresh later')}</Banner> : null}
      <MetricStrip columns={4}>
        <Metric label={t('资源', 'Resources')} value={overview.data ? formatNumber(overview.data.resources) : '—'} unit={t('项', 'items')} />
        <Metric label={t('运行 / 排队', 'Running / queued')} value={overview.data ? `${overview.data.running} / ${overview.data.queued}` : '—'} tone={overview.data?.running ? 'info' : 'neutral'} />
        <Metric label={t('需处理', 'Needs attention')} value={overview.data ? formatNumber(overview.data.needsAttention) : '—'} unit={t('项', 'items')} tone={overview.data?.needsAttention ? 'danger' : 'neutral'} />
        <Metric label={t('已登记空间', 'Stored files')} value={storage.data ? formatBytes(storage.data.usedBytes) : '—'} hint={storage.data ? t(`配额 ${formatBytes(storage.data.quotaBytes)}`, `Quota ${formatBytes(storage.data.quotaBytes)}`) : undefined} />
      </MetricStrip>

      {overview.isLoading || resources.isLoading || jobs.isLoading ? <Spinner label={t('正在读取概览', 'Loading overview')} /> : !ready ? null : !hasActivity ? <div className="rounded-panel bg-surface shadow-card"><EmptyState title={t('这个空间还没有文件或任务', 'No files or tasks in this workspace yet')} description={t('导入文件后，资源、任务和需要处理的事项会显示在这里。', 'Import a file to see resources, tasks, and items needing attention here.')} actions={<Link to="/import" className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse">{t('导入文件', 'Import file')}</Link>} /></div> : <>
        <section aria-labelledby="attention-heading" className="space-y-2.5"><SectionTitle title={<span id="attention-heading">{t('需要处理', 'Needs attention')}</span>} hint={t(`${formatNumber(overview.data?.needsAttention)} 项`, `${formatNumber(overview.data?.needsAttention)} items`)} actions={<Link to="/jobs" className="press inline-flex items-center gap-1 text-meta text-accent-ink hover:underline">{t('全部任务', 'All tasks')}<ArrowUpRight className="size-3.5" /></Link>} />
          {attention.length ? <div className="overflow-hidden rounded-panel bg-surface px-4 shadow-card"><ul>{attention.map((item) => <li key={item.id} className="border-b border-hairline-soft py-3 last:border-b-0"><div className="flex min-w-0 items-center gap-3"><span className="min-w-0 flex-1 truncate text-cell font-medium text-ink" title={item.name}>{item.name}</span><span className="shrink-0 text-meta text-danger-ink">{locale === 'en-US' ? jobStateEn[item.state] : jobState[item.state]}</span></div><div className="mt-1 flex min-w-0 items-center gap-3"><p className="min-w-0 flex-1 truncate text-meta text-ink-3" title={item.error?.message}>{item.error?.message ?? formatDateTime(item.updatedAt)}</p><span className="hidden shrink-0 text-meta text-ink-3 sm:inline">{formatDateTime(item.updatedAt)}</span><Link to="/jobs/$jobId" params={{ jobId: item.id }} className="press shrink-0 text-meta text-accent-ink hover:underline">{t('查看原因', 'View reason')}</Link></div></li>)}</ul>{(overview.data?.needsAttention ?? 0) > attention.length ? <Link to="/jobs" className="block border-t border-hairline-soft py-2.5 text-meta text-accent-ink hover:underline">{t(`还有 ${(overview.data?.needsAttention ?? 0) - attention.length} 项，查看全部`, `${(overview.data?.needsAttention ?? 0) - attention.length} more items. View all`)}</Link> : null}</div> : <p className="rounded-panel bg-surface px-4 py-3 text-cell text-ink-3 shadow-card">{t('没有失败或中断的任务。', 'No failed or interrupted tasks.')}</p>}
        </section>

        <section aria-labelledby="recent-heading" className="space-y-2.5"><SectionTitle title={<span id="recent-heading">{t('最近活动', 'Recent activity')}</span>} hint={t('当前空间', 'This workspace')} /><div className="grid grid-cols-1 gap-5 xl:grid-cols-2"><div className="min-w-0 overflow-hidden rounded-panel bg-surface px-4 shadow-card"><div className="flex items-center justify-between border-b border-hairline py-3"><h3 className="text-cell font-semibold text-ink">{t('最近资源', 'Recent resources')}</h3><Link to="/resources" className="press text-meta text-accent-ink hover:underline">{t('查看全部', 'View all')}</Link></div>{resources.data?.items.length ? <ul>{resources.data.items.map((item) => <RecentResource key={item.id} item={item} />)}</ul> : <p className="py-5 text-cell text-ink-3">{t('还没有资源。', 'No resources yet.')}</p>}</div><div className="min-w-0 overflow-hidden rounded-panel bg-surface px-4 shadow-card"><div className="flex items-center justify-between border-b border-hairline py-3"><h3 className="text-cell font-semibold text-ink">{t('最近任务', 'Recent tasks')}</h3><Link to="/jobs" className="press text-meta text-accent-ink hover:underline">{t('查看全部', 'View all')}</Link></div>{jobs.data?.items.length ? <ul>{jobs.data.items.map((item) => <RecentJob key={item.id} item={item} />)}</ul> : <p className="py-5 text-cell text-ink-3">{t('还没有任务。', 'No tasks yet.')}</p>}</div></div></section>
      </>}
    </PageBody></>
}
