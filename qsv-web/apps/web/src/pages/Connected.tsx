import { useState } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw } from 'lucide-react'
import { api, type AppLimits, type CellPatch, type CleanupItem, type CursorPage, type Job, type JobFilters, type Resource, type ResourceDependencies, type ResourceFilters, type Schema, type UserSettings, type ViewPlan } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, EmptyState, Spinner } from '@/ui/Feedback'
import { Panel } from '@/ui/Panel'
import { Fact, PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { getLocale, useT } from '@/ui/locale'
import { formatBytes, formatDateTime, formatNumber, kindLabel } from '@/lib/format'
import { displayDayEnd, displayDayStart, getDisplayTimezone } from '@/ui/timezone'
import { localizedErrorMessage } from '@/lib/errors'
import { localizedStage } from '@/lib/stage'

const number = formatNumber
const bytes = formatBytes
const date = formatDateTime
const jobState: Record<Job['state'], string> = { draft: '草稿', queued: '排队中', running: '运行中', cancel_requested: '正在取消', cancelled: '已取消', succeeded: '完成', failed: '失败', interrupted: '已中断' }
const jobStateEn: Record<Job['state'], string> = { draft: 'Draft', queued: 'Queued', running: 'Running', cancel_requested: 'Cancelling', cancelled: 'Cancelled', succeeded: 'Completed', failed: 'Failed', interrupted: 'Interrupted' }
const jobStateLabel = (state: Job['state']) => getLocale() === 'en-US' ? jobStateEn[state] : jobState[state]
const engineReasonEn: Record<string, string> = {
  '未配置 QSV_BIN，数据处理能力不可用': 'QSV_BIN is not configured, so data processing is unavailable.',
  '未配置有效的 QSV_SHA256，无法验证固定二进制': 'A valid QSV_SHA256 is required to verify the fixed binary.',
  'qsv 二进制 SHA-256 与配置不一致': 'The qsv binary SHA-256 does not match the configured value.',
  'count 结果与固定样本不符': 'The count command did not match the fixed sample.',
  '索引行块或文本保真检查失败': 'The indexed row block or text preservation check failed.',
  'qsv 命令无法运行或输出无法解析': 'The qsv command could not run or its output could not be parsed.',
}
const engineReason = (reason: string) => {
  if (getLocale() !== 'en-US') return reason
  const version = /^要求 qsv ([\d.]+)，实际版本不匹配$/.exec(reason)
  if (version) return `qsv ${version[1]} is required; the installed version does not match.`
  const command = /^固定二进制缺少 (\S+) 命令$/.exec(reason)
  if (command) return `The fixed binary is missing the ${command[1]} command.`
  return engineReasonEn[reason] ?? 'Engine verification failed.'
}

function ErrorNotice({ error }: { error: unknown }) {
  const t = useT()
  if (!error) return null
  return <Banner tone="danger" title={t('请求未完成', 'Request not completed')}>{error instanceof Error ? error.message : t('请稍后重试', 'Please try again later')}</Banner>
}

function ResourceList({ items, selectedIds, onToggle, onTogglePage }: { items: Resource[]; selectedIds: Set<string>;
  onToggle: (item: Resource) => void; onTogglePage: (items: Resource[]) => void }) {
  const t = useT()
  if (items.length === 0) return <EmptyState title={t('还没有资源', 'No resources yet')} description={t('选择 CSV 文件并导入后，可在这里查看原文件和数据集。', 'Import a file to see original files and datasets here.')} />
  const eligible = items.filter((item) => item.kind !== 'view' && ['ready', 'failed'].includes(item.status))
  return <div className="overflow-x-auto rounded-panel bg-surface shadow-card">
    <table className="w-full min-w-[680px] text-left text-cell">
      <thead className="border-b border-hairline text-meta text-ink-3"><tr><th className="px-3 py-3"><input type="checkbox" aria-label={t('选择当前页可处理资源', 'Select eligible resources on this page')} disabled={!eligible.length} checked={eligible.length > 0 && eligible.every((item) => selectedIds.has(item.id))} onChange={() => onTogglePage(eligible)} /></th><th className="px-4 py-3">{t('名称', 'Name')}</th><th className="px-3 py-3">{t('类型', 'Type')}</th><th className="px-3 py-3">{t('状态', 'Status')}</th><th className="px-3 py-3 text-right">{t('行数', 'Rows')}</th><th className="px-3 py-3 text-right">{t('大小', 'Size')}</th><th className="px-3 py-3">{t('创建时间', 'Created')}</th><th className="px-4 py-3">{t('操作', 'Actions')}</th></tr></thead>
      <tbody className="divide-y divide-hairline-soft">{items.map((item) => <tr key={item.id} className="hover:bg-surface-hover">
        <td className="px-3 py-3"><input type="checkbox" aria-label={t(`选择 ${item.name}`, `Select ${item.name}`)} checked={selectedIds.has(item.id)} disabled={item.kind === 'view' || !['ready', 'failed'].includes(item.status)} onChange={() => onToggle(item)} /></td>
        <td className="max-w-64 truncate px-4 py-3 font-medium text-ink" title={item.name}><Link to="/resources/$resourceId" params={{ resourceId: item.id }} className="hover:text-accent-ink hover:underline">{item.name}</Link></td>
        <td className="px-3 py-3 text-ink-2">{kindLabel(item.kind)}</td>
        <td className="px-3 py-3 text-ink-2">{item.status === 'ready' ? t('可用', 'Ready') : item.status === 'building' ? t('处理中', 'Processing') : item.status === 'failed' ? t('失败', 'Failed') : item.status}</td>
        <td className="figure px-3 py-3 text-right text-ink-2">{number(item.rowCount)}</td>
        <td className="figure px-3 py-3 text-right text-ink-2">{bytes(item.byteSize)}</td>
        <td className="px-3 py-3 text-ink-3">{date(item.createdAt)}</td>
        <td className="px-4 py-3">{item.kind === 'dataset' && item.status === 'ready' && item.metadata.compareSummary ? <Link className="text-accent-ink hover:underline" to="/compare/result" search={{ resourceId: item.id }}>{t('查看核对', 'View comparison')}</Link> : item.kind === 'dataset' && item.status === 'ready' ? <Link className="text-accent-ink hover:underline" to="/datasets/$resourceId" params={{ resourceId: item.id }}>{t('浏览', 'Browse')}</Link> : (item.kind === 'raw' || item.kind === 'export') && item.status === 'ready' ? <a className="text-accent-ink hover:underline" href={api.downloadUrl(item.id)}>{t('下载', 'Download')}</a> : '—'}</td>
      </tr>)}</tbody>
    </table>
  </div>
}

function RestoreButton({ item }: { item: Resource }) {
  const t = useT()
  const client = useQueryClient()
  const mutation = useMutation({ mutationFn: () => api.restoreResource(item.id, item.updatedAt), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['trash'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void client.invalidateQueries({ queryKey: ['overview'] })
  } })
  return <><Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{t('恢复', 'Restore')}</Button>{mutation.error ? <span role="alert" className="text-meta text-danger-ink">{mutation.error.message}</span> : null}</>
}

function TrashPanel() {
  const t = useT()
  const [offset, setOffset] = useState(0)
  const query = useQuery({ queryKey: ['trash', offset], queryFn: () => api.trash(offset, 50) })
  return <Panel className="space-y-3"><SectionTitle title={t('回收站', 'Trash')} /><p className="text-meta text-ink-3">{t('资源默认保留 7 天；到期后后台自动清理。保留期间仍占用空间，恢复后可再次下载和处理。', 'Resources are kept for 7 days by default, then removed automatically. They still use storage while in trash and can be downloaded and processed again after restoration.')}</p>
    <ErrorNotice error={query.error} />{query.isLoading ? <Spinner /> : null}
    {query.data?.items.length === 0 ? <p className="text-cell text-ink-3">{t('回收站为空。', 'Trash is empty.')}</p> : null}
    {query.data?.items.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-3 text-cell"><div className="min-w-0 flex-1"><p className="break-all font-medium text-ink">{item.name}</p><p className="text-meta text-ink-3">{kindLabel(item.kind)} · {bytes(item.byteSize)} · {t('删除于 ', 'Removed ')}{item.deletedAt ? date(item.deletedAt) : t('未知时间', 'at an unknown time')}{item.deletedAt ? t(` · 预计 ${date(item.deletedAt + 7 * 24 * 60 * 60 * 1000)} 后清理`, ` · scheduled for deletion after ${date(item.deletedAt + 7 * 24 * 60 * 60 * 1000)}`) : ''}</p></div><RestoreButton item={item} /></div>)}
    <div className="flex items-center gap-2"><Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t('上一页', 'Previous')}</Button><span className="text-meta text-ink-3">{t(`共 ${number(query.data?.total)} 项`, `${number(query.data?.total)} total`)}</span><Button size="sm" disabled={offset + 50 >= (query.data?.total ?? 0)} onClick={() => setOffset(offset + 50)}>{t('下一页', 'Next')}</Button></div>
  </Panel>
}

function JobList({ items }: { items: Job[] }) {
  const t = useT()
  if (items.length === 0) return <EmptyState title={t('还没有任务', 'No jobs yet')} description={t('导入文件后，任务和执行结果会显示在这里。', 'Jobs and their results appear here after you import a file.')} />
  return <div className="space-y-2">{items.map((job) => <div key={job.id} className="flex flex-wrap items-center gap-3 rounded-panel bg-surface px-4 py-3 shadow-card">
    <div className="min-w-48 flex-1"><Link to="/jobs/$jobId" params={{ jobId: job.id }} className="truncate text-cell font-medium text-ink hover:text-accent-ink hover:underline">{job.name}</Link><p className="mt-1 text-meta text-ink-3">{date(job.createdAt)} · {job.progress.stage ? localizedStage(job.progress.stage) : jobStateLabel(job.state)}</p></div>
    <span className="text-cell text-ink-2">{jobStateLabel(job.state)}</span>
    {job.error ? <span className="max-w-72 text-meta text-danger-ink" title={job.error.code}>{localizedErrorMessage(job.error.code, job.error.message)}</span> : null}
    {job.state === 'succeeded' && job.summary.outputId ? <Link className="text-cell text-accent-ink hover:underline" to="/jobs/$jobId" params={{ jobId: job.id }}>{t('查看产物与下载状态', 'View output and download status')}</Link> : null}
    {(job.state === 'queued' || job.state === 'running') ? <CancelButton id={job.id} /> : null}
    {(job.state === 'failed' || job.state === 'interrupted' || job.state === 'cancelled') && job.error?.retryable !== false ? <RetryButton id={job.id} /> : null}
  </div>)}</div>
}

function CancelButton({ id }: { id: string }) {
  const t = useT()
  const client = useQueryClient()
  const mutation = useMutation({ mutationFn: () => api.cancel(id), onSuccess: () => void client.invalidateQueries({ queryKey: ['jobs'] }) })
  return <Button size="sm" variant="quiet" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{t('取消', 'Cancel')}</Button>
}

function RetryButton({ id }: { id: string }) {
  const t = useT()
  const client = useQueryClient()
  const navigate = useNavigate()
  const mutation = useMutation({ mutationFn: () => api.retry(id, `retry_${id}`), onSuccess: (result) => { void client.invalidateQueries({ queryKey: ['jobs'] }); void client.invalidateQueries({ queryKey: ['resources'] }); void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } }) } })
  return <><Button size="sm" variant="secondary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{t('重试或查看重试', 'Retry or view retry')}</Button>{mutation.error ? <span className="text-meta text-danger-ink">{mutation.error.message}</span> : null}</>
}

export function ResourcesPage() {
  const t = useT()
  const client = useQueryClient()
  const [cursor, setCursor] = useState('')
  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  const [filterOffset, setFilterOffset] = useState(0)
  const [draft, setDraft] = useState({ name: '', format: '', kind: '', status: '', from: '', to: '' })
  const [applied, setApplied] = useState<ResourceFilters>({})
  const [showTrash, setShowTrash] = useState(false)
  const [selected, setSelected] = useState<Record<string, Resource>>({})
  const selectedItems = Object.values(selected)
  const selectedIds = new Set(Object.keys(selected))
  const selectionSignature = JSON.stringify(Object.keys(selected).sort())
  const toggleSelected = (item: Resource) => setSelected((current) => {
    if (current[item.id]) { const next = { ...current }; delete next[item.id]; return next }
    return Object.keys(current).length >= 100 ? current : { ...current, [item.id]: item }
  })
  const togglePage = (items: Resource[]) => setSelected((current) => {
    const next = { ...current }
    if (items.every((item) => Boolean(next[item.id]))) items.forEach((item) => { delete next[item.id] })
    else for (const item of items) if (Object.keys(next).length < 100) next[item.id] = item
    return next
  })
  const previewBulk = useMutation({ mutationFn: async () => ({ signature: selectionSignature,
    items: await Promise.all(selectedItems.map(async (item) => ({
      resource: await api.resource(item.id), dependencies: await api.resourceDependencies(item.id),
    }))) as { resource: Resource; dependencies: ResourceDependencies }[] }) })
  const bulkReady = previewBulk.data?.signature === selectionSignature &&
    previewBulk.data.items.every((entry) => ['ready', 'failed'].includes(entry.resource.status) && entry.dependencies.activeJobs.length === 0)
  const bulkTrash = useMutation({ mutationFn: async () => {
    const outcomes: { id: string; name: string; error?: string }[] = []
    for (const entry of previewBulk.data?.items ?? []) {
      try { await api.trashResource(entry.resource.id, entry.resource.updatedAt); outcomes.push({ id: entry.resource.id, name: entry.resource.name }) }
      catch (error) { outcomes.push({ id: entry.resource.id, name: entry.resource.name, error: error instanceof Error ? error.message : t('操作失败', 'Operation failed') }) }
    }
    return outcomes
  }, onSuccess: () => {
    setSelected({})
    void client.invalidateQueries({ queryKey: ['resources'] })
    void client.invalidateQueries({ queryKey: ['trash'] })
    void client.invalidateQueries({ queryKey: ['overview'] })
    void client.invalidateQueries({ queryKey: ['storage'] })
  } })
  const filtering = Object.values(applied).some((value) => value !== undefined && value !== '')
  const query = useQuery({ queryKey: ['resources', 'page', cursor, filterOffset, applied],
    queryFn: () => filtering ? api.findResources(applied, filterOffset, 50) : api.resourceCursorPage(cursor, 50), refetchInterval: 5000 })
  const nextCursor: string | null = query.data && 'nextCursor' in query.data ? (query.data as CursorPage<Resource>).nextCursor : null
  const update = (field: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  const apply = () => { setApplied({ name: draft.name.trim(), format: draft.format, kind: draft.kind, status: draft.status,
    from: draft.from ? displayDayStart(draft.from) : undefined,
    to: draft.to ? displayDayEnd(draft.to) : undefined }); setFilterOffset(0); setCursor(''); setPreviousCursors([]) }
  return <><PageTopBar title={t('文件与数据集', 'Files and datasets')} facts={<Fact label={t('资源总数', 'Total resources')}>{number(query.data?.total)}</Fact>} actions={<Link to="/import" className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse shadow-rail hover:bg-accent-hover">{t('导入文件', 'Import files')}</Link>} /><PageBody className="space-y-3">
    <Panel><form className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" onSubmit={(event) => { event.preventDefault(); apply() }}>
      <label className="space-y-1 text-meta text-ink-3">{t('名称', 'Name')}<input value={draft.name} maxLength={100} onChange={(event) => update('name', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <label className="space-y-1 text-meta text-ink-3">{t('格式', 'Format')}<input value={draft.format} maxLength={12} placeholder={t('csv、xlsx…', 'csv, xlsx…')} onChange={(event) => update('format', event.target.value.toLowerCase())} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <label className="space-y-1 text-meta text-ink-3">{t('类型', 'Type')}<select value={draft.kind} onChange={(event) => update('kind', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option><option value="raw">{t('原文件', 'Original file')}</option><option value="dataset">{t('数据集', 'Dataset')}</option><option value="report">{t('报告', 'Report')}</option><option value="export">{t('导出文件', 'Exported file')}</option></select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('状态', 'Status')}<select value={draft.status} onChange={(event) => update('status', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option><option value="ready">{t('可用', 'Ready')}</option><option value="building">{t('处理中', 'Processing')}</option><option value="failed">{t('失败', 'Failed')}</option><option value="staging">{t('接收中', 'Receiving')}</option></select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('开始日期', 'Start date')}<input type="date" value={draft.from} onChange={(event) => update('from', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <label className="space-y-1 text-meta text-ink-3">{t('结束日期', 'End date')}<input type="date" value={draft.to} onChange={(event) => update('to', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <p className="text-meta text-ink-3 sm:col-span-3 xl:col-span-6">{t('日期范围按已保存时区计算：', 'Date ranges use the saved timezone: ')}{getDisplayTimezone()}</p>
      <div className="flex gap-2 sm:col-span-3 xl:col-span-6"><Button type="submit" size="sm" variant="primary">{t('筛选完整资源列表', 'Search all resources')}</Button><Button size="sm" onClick={() => { setDraft({ name: '', format: '', kind: '', status: '', from: '', to: '' }); setApplied({}); setFilterOffset(0); setCursor(''); setPreviousCursors([]) }}>{t('清除条件', 'Clear filters')}</Button></div>
    </form></Panel>
    {selectedItems.length ? <Panel className="space-y-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-cell">{t(`已选 ${selectedItems.length} 项资源（最多 100 项）`, `${selectedItems.length} resources selected (up to 100)`)}</strong><Button size="sm" disabled={previewBulk.isPending} onClick={() => previewBulk.mutate()}>{t('查看批量删除影响', 'Review bulk removal')}</Button><Button size="sm" variant="quiet" onClick={() => setSelected({})}>{t('清除选择', 'Clear selection')}</Button></div>
      {previewBulk.error ? <Banner tone="danger">{previewBulk.error.message}</Banner> : null}
      {previewBulk.data?.signature === selectionSignature ? <div className="space-y-1 text-meta text-ink-2"><p>{t('将把以下资源移入可恢复的回收站。已有结果不会随来源一起删除；正在被任务使用的资源不能删除。', 'The following resources will move to recoverable trash. Existing results remain available. Resources used by active jobs cannot be removed.')}</p>{previewBulk.data.items.map((entry) => <p key={entry.resource.id}>{entry.resource.name} · {bytes(entry.resource.byteSize)} · {t(`引用结果最多显示 ${entry.dependencies.derivedResources.length} 项`, `Up to ${entry.dependencies.derivedResources.length} linked results`)}{entry.dependencies.activeJobs.length ? t(` · 正在使用的任务 ${entry.dependencies.activeJobs.length} 项`, ` · ${entry.dependencies.activeJobs.length} active jobs`) : ''}{!['ready', 'failed'].includes(entry.resource.status) ? t(' · 当前状态不能删除', ' · current status prevents removal') : ''}</p>)}<Button size="sm" variant="danger" disabled={!bulkReady || bulkTrash.isPending} onClick={() => bulkTrash.mutate()}>{t('确认将所选资源移入回收站', 'Move selected resources to trash')}</Button></div> : null}
      {bulkTrash.data ? <div className="text-meta text-ink-2">{bulkTrash.data.map((item) => <p key={item.id}>{item.name}{t('：', ': ')}{item.error ?? t('已移入回收站', 'Moved to trash')}</p>)}</div> : null}
    </Panel> : bulkTrash.data ? <Panel className="text-meta text-ink-2">{bulkTrash.data.map((item) => <p key={item.id}>{item.name}{t('：', ': ')}{item.error ?? t('已移入回收站', 'Moved to trash')}</p>)}</Panel> : null}
    <ErrorNotice error={query.error} />{query.isLoading ? <Spinner /> : <ResourceList items={query.data?.items ?? []} selectedIds={selectedIds} onToggle={toggleSelected} onTogglePage={togglePage} />}
    <div className="flex items-center gap-2"><Button size="sm" disabled={filtering ? filterOffset === 0 : previousCursors.length === 0} onClick={() => filtering ? setFilterOffset(Math.max(0, filterOffset - 50)) : (setCursor(previousCursors[previousCursors.length - 1]!), setPreviousCursors((items) => items.slice(0, -1)))}>{t('上一页', 'Previous')}</Button><span className="figure text-meta text-ink-3">{t(`第 ${filtering ? Math.floor(filterOffset / 50) + 1 : previousCursors.length + 1} 页 · 共 ${number(query.data?.total)} 项`, `Page ${filtering ? Math.floor(filterOffset / 50) + 1 : previousCursors.length + 1} · ${number(query.data?.total)} total`)}</span><Button size="sm" disabled={filtering ? filterOffset + 50 >= (query.data?.total ?? 0) : !nextCursor} onClick={() => filtering ? setFilterOffset(filterOffset + 50) : (setPreviousCursors((items) => [...items, cursor]), setCursor(nextCursor!))}>{t('下一页', 'Next')}</Button><Button size="sm" variant="quiet" onClick={() => setShowTrash(!showTrash)}>{showTrash ? t('收起回收站', 'Hide trash') : t('查看回收站', 'View trash')}</Button></div>{showTrash ? <TrashPanel /> : null}</PageBody></>
}

export { ImportPage } from './ImportPage'

export function DatasetPage() {
  const t = useT()
  const { resourceId } = useParams({ from: '/datasets/$resourceId' })
  const { row } = useSearch({ from: '/datasets/$resourceId' })
  const [offset, setOffset] = useState(Math.max(0, (row ?? 1) - 1))
  const [previousOffsets, setPreviousOffsets] = useState<number[]>([])
  const [jump, setJump] = useState(String(row ?? 1))
  const [limit] = useState(100)
  const [selectedCell, setSelectedCell] = useState<{ rowIndex: number; columnId: string } | null>(null)
  const [columnOrder, setColumnOrder] = useSessionDraft<string[]>(`DatasetPage.${resourceId}.columnOrder`, [])
  const [hiddenColumns, setHiddenColumns] = useSessionDraft<string[]>(`DatasetPage.${resourceId}.hiddenColumns`, [])
  const [columnSearch, setColumnSearch] = useState('')
  const [copyStart, setCopyStart] = useState('')
  const [copyEnd, setCopyEnd] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const [copying, setCopying] = useState(false)
  const [patches, setPatches] = useState<CellPatch[]>([])
  const [undoStack, setUndoStack] = useState<CellPatch[][]>([])
  const [redoStack, setRedoStack] = useState<CellPatch[][]>([])
  const [filterColumn, setFilterColumn] = useSessionDraft(`DatasetPage.${resourceId}.filterColumn`, 'c_0')
  const [filterMode, setFilterMode] = useSessionDraft<'equals' | 'contains'>(`DatasetPage.${resourceId}.filterMode`, 'equals')
  const [filterValue, setFilterValue] = useSessionDraft(`DatasetPage.${resourceId}.filterValue`, '')
  const [filterKey, setFilterKey] = useState(() => `filter_${crypto.randomUUID()}`)
  const navigate = useNavigate()
  const client = useQueryClient()
  const resource = useQuery({ queryKey: ['resource', resourceId], queryFn: () => api.resource(resourceId) })
  const schema = useQuery({ queryKey: ['schema', resourceId], queryFn: () => api.schema(resourceId) })
  const view = useQuery({ queryKey: ['view', resourceId], queryFn: () => api.createView(resourceId), staleTime: Infinity })
  const block = useQuery({ queryKey: ['rows', view.data?.id, offset, limit], queryFn: ({ signal }) => api.rows(view.data!.id, offset, limit, signal), enabled: Boolean(view.data) })
  const fullCell = useQuery({ queryKey: ['cell', view.data?.id, selectedCell?.rowIndex, selectedCell?.columnId], queryFn: ({ signal }) => api.cell(view.data!.id, selectedCell!.rowIndex, selectedCell!.columnId, signal), enabled: Boolean(view.data && selectedCell) })
  const versions = useQuery({ queryKey: ['resource', resourceId, 'versions'], queryFn: () => api.resourceVersions(resourceId), enabled: resource.data?.kind === 'dataset' })
  const edit = useMutation({ mutationFn: () => api.editCells(resourceId, resource.data!.contentHash!, patches,
    `edit_${crypto.randomUUID()}`), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const stagePatch = (patch: CellPatch) => {
    setUndoStack((items) => [...items.slice(-49), patches])
    setRedoStack([])
    setPatches((items) => [...items.filter((item) => item.rowId !== patch.rowId || item.columnId !== patch.columnId), patch])
  }
  const undo = () => { if (!undoStack.length) return; setRedoStack((items) => [...items, patches]); setPatches(undoStack.at(-1)!); setUndoStack((items) => items.slice(0, -1)) }
  const redo = () => { if (!redoStack.length) return; setUndoStack((items) => [...items, patches]); setPatches(redoStack.at(-1)!); setRedoStack((items) => items.slice(0, -1)) }
  const filter = useMutation({ mutationFn: () => api.filter(resourceId, filterColumn, filterMode, filterValue, filterKey), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const total = schema.data?.rowCount ?? 0
  const nextOffset = block.data?.nextOffset ?? offset + limit
  const visibleEnd = offset + (block.data?.rows.length ?? 0)
  const filterColumnMissing = Boolean(schema.data && !schema.data.columns.some((column) => column.id === filterColumn))
  const orderedColumns = (columnOrder.length ? [...columnOrder, ...(schema.data?.columns.map((column) => column.id).filter((id) => !columnOrder.includes(id)) ?? [])] : schema.data?.columns.map((column) => column.id) ?? [])
    .map((id) => schema.data?.columns.find((column) => column.id === id)).filter((column): column is Schema['columns'][number] => Boolean(column))
  const visibleColumns = orderedColumns.filter((column) => !hiddenColumns.includes(column.id))
  const moveColumn = (id: string, direction: -1 | 1) => {
    const current = orderedColumns.map((column) => column.id), at = current.indexOf(id), other = at + direction
    if (at < 0 || other < 0 || other >= current.length) return
    ;[current[at], current[other]] = [current[other]!, current[at]!]
    setColumnOrder(current)
  }
  const copyRange = async () => {
    if (!view.data || !visibleColumns.length || !total) return
    const viewId = view.data.id
    const start = copyStart ? Number(copyStart) : offset + 1
    const end = copyEnd ? Number(copyEnd) : visibleEnd
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > total || end < start) {
      setCopyMessage(t('请选择完整数据集内有效的起止行号', 'Select a valid start and end row in the complete dataset')); return
    }
    const cells = (end - start + 1) * visibleColumns.length
    if (cells > 10_000) { setCopyMessage(t('所选范围超过 10000 个单元格，请缩小范围或导出', 'The selected range exceeds 10,000 cells. Reduce it or export the data.')); return }
    setCopying(true)
    setCopyMessage(t('正在读取所选单元格的完整内容…', 'Reading complete selected cell values…'))
    try {
      const content = (async () => {
        const lines: string[] = []
        let size = 0
        let cursor = start - 1
        while (cursor < end) {
          const chunk = await api.rows(viewId, cursor, Math.min(100, end - cursor))
          if (!chunk.rows.length || chunk.offset !== cursor || chunk.rows.length > end - cursor) {
            throw new Error(t('所选行段读取不完整，请重新选择范围', 'The selected rows could not be read completely. Select the range again.'))
          }
          const truncated = new Set(chunk.truncatedCells.map((item) => `${item.rowId}:${item.columnId}`))
          for (let rowIndex = 0; rowIndex < chunk.rows.length; rowIndex += 1) {
            const row = chunk.rows[rowIndex]!
            const values: string[] = []
            for (const column of visibleColumns) {
              let value = row[Number(column.id.slice(2))] ?? ''
              if (truncated.has(`${chunk.rowIds[rowIndex]}:${column.id}`)) {
                value = (await api.cell(viewId, cursor + rowIndex, column.id)).value
              }
              values.push(/[\t\r\n"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value)
            }
            const line = values.join('\t')
            size += new TextEncoder().encode(line).byteLength + 1
            if (size > 2 * 1024 * 1024) throw new Error(t('所选内容超过 2 MiB，请缩小范围或导出完整数据', 'The selection exceeds 2 MiB. Reduce it or export the full data.'))
            lines.push(line)
          }
          cursor += chunk.rows.length
        }
        return lines.join('\n')
      })()
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content.then((value) => new Blob([value], { type: 'text/plain' })) })])
      } else {
        await navigator.clipboard.writeText(await content)
      }
      setCopyMessage(t(`已复制 ${cells} 个单元格的完整内容。`, `Copied complete contents of ${cells} cells.`))
    } catch (error) { setCopyMessage(error instanceof Error ? t(`复制失败：${error.message}`, `Copy failed: ${error.message}`) : t('复制失败，请检查浏览器剪贴板权限', 'Copy failed. Check browser clipboard permissions.')) }
    finally { setCopying(false) }
  }
  return <><PageTopBar title={resource.data?.name ?? t('数据集', 'Dataset')} facts={<><Fact label={t('全表行数', 'Total rows')}>{number(schema.data?.rowCount)}</Fact><Fact label={t('字段', 'Fields')}>{number(schema.data?.columns.length)}</Fact></>} actions={<><Link to="/convert" search={{ sourceId: resourceId }} className="press inline-flex h-8.5 items-center rounded-control bg-surface px-3 text-cell font-medium text-ink shadow-rail hover:bg-surface-hover">{t('配置导出', 'Configure export')}</Link><a href={api.downloadUrl(resourceId)} className="press inline-flex h-8.5 items-center gap-1.5 rounded-control bg-surface px-3 text-cell font-medium text-ink shadow-rail hover:bg-surface-hover"><Download className="size-4" />{t('下载完整 CSV', 'Download complete CSV')}</a></>} />
    <PageBody className="space-y-4"><ErrorNotice error={resource.error ?? schema.error ?? view.error ?? block.error} /><Banner tone="info">{t(`当前显示第 ${total === 0 ? 0 : offset + 1}—${Math.min(visibleEnd, total)} 行；行数来自完整文件。当前行段不代表全表筛选或排序结果。`, `Showing rows ${total === 0 ? 0 : offset + 1}–${Math.min(visibleEnd, total)} of the complete file. The current block is not a full-table filter or sort result.`)}</Banner>
      {filterColumnMissing ? <Banner tone="warn">{t('已保存的筛选字段不在当前数据集版本中。请重新选择字段。', 'The saved filter field is absent from this dataset version. Select a field again.')}</Banner> : null}
      <Panel className="space-y-3"><SectionTitle title={t('全表文本筛选', 'Full-table text filter')} />
        <p className="text-meta text-ink-3">{t('对完整数据集运行精确相等或包含筛选，结果保存为新数据集；不会只筛选当前显示的行段。', 'Apply equals or contains to the complete dataset and save the result as a new dataset. This does not filter just the visible block.')}</p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); filter.mutate() }}>
          <label className="space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<select aria-label={t('筛选字段', 'Filter field')} value={filterColumn} onChange={(event) => { setFilterColumn(event.target.value); setFilterKey(`filter_${crypto.randomUUID()}`) }} className="block h-9 min-w-32 rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{filterColumnMissing ? <option value={filterColumn}>{t(`原字段已失效：${filterColumn}`, `Previous field unavailable: ${filterColumn}`)}</option> : null}{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
          <label className="space-y-1 text-meta text-ink-3">{t('条件', 'Condition')}<select aria-label={t('筛选条件', 'Filter condition')} value={filterMode} onChange={(event) => { setFilterMode(event.target.value as 'equals' | 'contains'); setFilterKey(`filter_${crypto.randomUUID()}`) }} className="block h-9 rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="equals">{t('完全等于', 'Equals')}</option><option value="contains">{t('包含文本', 'Contains text')}</option></select></label>
          <label className="min-w-48 flex-1 space-y-1 text-meta text-ink-3">{t('文本', 'Text')}<input aria-label={t('筛选文本', 'Filter text')} value={filterValue} maxLength={512} onChange={(event) => { setFilterValue(event.target.value); setFilterKey(`filter_${crypto.randomUUID()}`) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <Button type="submit" size="sm" variant="primary" disabled={!schema.data || filterColumnMissing || filter.isPending}>{t('运行全表筛选', 'Run full-table filter')}</Button>
        </form>{filter.error ? <Banner tone="danger" title={t('筛选未提交', 'Filter not submitted')}>{filter.error.message}</Banner> : null}
      </Panel>
      <AdvancedViewPanel key={resourceId} resourceId={resourceId} columns={schema.data?.columns ?? []} />
      <Panel className="space-y-3"><SectionTitle title={t('字段与复制范围', 'Fields and copy range')} />
        <p className="text-meta text-ink-3">{t('字段的显示和顺序只影响本页；原文件及新任务的字段顺序保持不变。', 'Field visibility and order affect only this page. The original file and new jobs keep their own field order.')}</p>
        <input aria-label={t('查找字段', 'Find field')} value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} placeholder={t('查找字段名', 'Find field name')} className="h-9 w-full max-w-sm rounded-control bg-surface px-2 text-cell text-ink shadow-rail" />
        <div className="grid max-h-52 gap-2 overflow-auto sm:grid-cols-2 xl:grid-cols-3">{orderedColumns.filter((column) => column.name.toLowerCase().includes(columnSearch.toLowerCase())).map((column, index) => <div key={column.id} className="flex items-center gap-2 rounded-control bg-surface-sunk px-2 py-1 text-cell"><input type="checkbox" checked={!hiddenColumns.includes(column.id)} onChange={() => setHiddenColumns((items) => items.includes(column.id) ? items.filter((id) => id !== column.id) : [...items, column.id])} /><span className="min-w-0 flex-1 truncate" title={column.name}>{column.name} · {column.type}</span><Button size="sm" variant="quiet" disabled={index === 0} onClick={() => moveColumn(column.id, -1)}>↑</Button><Button size="sm" variant="quiet" disabled={index === orderedColumns.length - 1} onClick={() => moveColumn(column.id, 1)}>↓</Button></div>)}</div>
        <p className="text-meta text-ink-3">{t('可跨行段复制，最多 10000 个单元格且文本不超过 2 MiB；留空时使用当前显示行段。较大范围请使用导出。', 'Copy across row blocks, up to 10,000 cells and 2 MiB of text. Blank row inputs use the visible block. Use export for larger ranges.')}</p><div className="flex flex-wrap items-end gap-2"><label className="text-meta">{t('从第几行', 'From row')}<input type="number" min={1} max={total} value={copyStart} onChange={(event) => setCopyStart(event.target.value)} placeholder={String(offset + 1)} className="block h-9 w-28 rounded-control bg-surface px-2 text-cell" /></label><label className="text-meta">{t('到第几行', 'To row')}<input type="number" min={1} max={total} value={copyEnd} onChange={(event) => setCopyEnd(event.target.value)} placeholder={String(visibleEnd)} className="block h-9 w-28 rounded-control bg-surface px-2 text-cell" /></label><Button size="sm" disabled={!view.data || !total || !visibleColumns.length || copying} onClick={() => void copyRange()}>{t('复制选定行范围', 'Copy selected rows')}</Button><Link to="/analyze" search={{ sourceId: resourceId }} className="text-cell text-accent-ink hover:underline">{t('查看字段统计', 'View field statistics')}</Link></div>{copyMessage ? <p className="text-meta text-ink-2">{copyMessage}</p> : null}
      </Panel>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={previousOffsets.length === 0} onClick={() => { setSelectedCell(null); setOffset(previousOffsets[previousOffsets.length - 1]!); setPreviousOffsets((items) => items.slice(0, -1)) }}>{t('上一段', 'Previous block')}</Button><Button size="sm" disabled={!block.data?.hasMore} onClick={() => { setSelectedCell(null); setPreviousOffsets((items) => [...items, offset]); setOffset(nextOffset) }}>{t('下一段', 'Next block')}</Button><form className="ml-2 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); const row = Number(jump); if (Number.isSafeInteger(row) && row >= 1 && row <= total) { setSelectedCell(null); setPreviousOffsets([]); setOffset(row - 1) } }}><label htmlFor="jump-row" className="text-meta text-ink-3">{t('跳至行', 'Jump to row')}</label><input id="jump-row" type="number" min="1" max={total} value={jump} onChange={(event) => setJump(event.target.value)} className="h-8 w-28 rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /><Button size="sm" type="submit" disabled={total === 0}>{t('前往', 'Go')}</Button></form><span className="figure text-meta text-ink-3">{t(`每段最多 ${limit} 行`, `Up to ${limit} rows per block`)}</span>{block.isFetching ? <Spinner /> : null}</div>
      <div className="overflow-auto rounded-panel bg-surface shadow-card"><table className="min-w-full border-collapse text-cell"><thead className="sticky top-0 z-10 bg-surface"><tr><th className="sticky left-0 bg-surface px-3 py-2 text-right text-meta text-ink-3">{t('行号', 'Row')}</th>{visibleColumns.map((column) => <th key={column.id} className="min-w-36 border-l border-hairline-soft px-3 py-2 text-left text-meta font-medium text-ink-3">{column.name}</th>)}</tr></thead><tbody className="divide-y divide-hairline-soft">{block.data?.rows.map((row, index) => <tr key={block.data.rowIds[index]} className="hover:bg-surface-hover"><td className="figure sticky left-0 bg-surface px-3 py-2 text-right text-ink-3">{number(block.data.sourceRowNumbers[index])}</td>{visibleColumns.map((column) => { const columnId = column.id, cell = row[Number(columnId.slice(2))]; const truncated = block.data.truncatedCells.some((item) => item.rowId === block.data.rowIds[index] && item.columnId === columnId); return <td key={columnId} className="max-w-80 border-l border-hairline-soft px-3 py-2 text-ink-2"><button type="button" className="block max-w-80 truncate text-left hover:text-accent-ink hover:underline" title={t('查看完整内容', 'View complete value')} onClick={() => setSelectedCell({ rowIndex: offset + index, columnId })}>{cell ?? '∅'}{truncated ? <span className="ml-1 text-accent-ink">{t('查看完整内容', 'View complete value')}</span> : null}</button></td> })}</tr>)}</tbody></table>
        {!block.isLoading && block.data?.rows.length === 0 ? <p className="p-5 text-cell text-ink-3">{t('该行段没有记录。', 'This block has no records.')}</p> : null}</div>
      {selectedCell ? <Panel className="space-y-3"><div className="flex items-center justify-between gap-3"><SectionTitle title={t(`第 ${selectedCell.rowIndex + 1} 行 · ${schema.data?.columns.find((column) => column.id === selectedCell.columnId)?.name ?? selectedCell.columnId}`, `Row ${selectedCell.rowIndex + 1} · ${schema.data?.columns.find((column) => column.id === selectedCell.columnId)?.name ?? selectedCell.columnId}`)} /><Button size="sm" onClick={() => setSelectedCell(null)}>{t('关闭', 'Close')}</Button></div><ErrorNotice error={fullCell.error} />{fullCell.isLoading ? <Spinner /> : fullCell.data ? <CellValueEditor key={`${fullCell.data.rowId}:${fullCell.data.columnId}`} value={fullCell.data.value} onStage={(value) => stagePatch({ rowId: fullCell.data!.rowId, columnId: fullCell.data!.columnId, expectedOldValue: fullCell.data!.value, newValue: value })} /> : null}</Panel> : null}
      <Panel className="space-y-3"><SectionTitle title={t('修正草稿与版本', 'Correction draft and versions')} /><p className="text-meta text-ink-3">{t('最多修正 10000 个单元格。提交时核对源版本和每个单元格原值，生成新版本；原数据保留。撤销、重做只改变尚未提交的草稿。', 'You can correct up to 10,000 cells. Submission checks the source version and each original value, then creates a new version. The original data remains. Undo and redo affect only the unsubmitted draft.')}</p><p className="text-cell text-ink-2">{t(`草稿 ${patches.length} 处修正`, `${patches.length} corrections in draft`)}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={!undoStack.length} onClick={undo}>{t('撤销', 'Undo')}</Button><Button size="sm" disabled={!redoStack.length} onClick={redo}>{t('重做', 'Redo')}</Button><Button size="sm" disabled={!patches.length} onClick={() => { setUndoStack((items) => [...items.slice(-49), patches]); setRedoStack([]); setPatches([]) }}>{t('清空草稿', 'Clear draft')}</Button><Button size="sm" variant="primary" disabled={!patches.length || edit.isPending || !resource.data?.contentHash} onClick={() => edit.mutate()}>{t('保存为新版本', 'Save as new version')}</Button></div>{edit.error ? <Banner tone="danger" title={t('修正未提交', 'Corrections not submitted')}>{edit.error.message}</Banner> : null}{patches.length ? <div className="max-h-40 space-y-1 overflow-auto">{patches.map((patch) => <p key={`${patch.rowId}:${patch.columnId}`} className="text-meta">{patch.rowId} · {patch.columnId}: {patch.expectedOldValue.slice(0, 60)} → {patch.newValue.slice(0, 60)}</p>)}</div> : null}<div className="border-t border-hairline-soft pt-3"><strong className="text-cell">{t('版本记录', 'Version history')}</strong><div className="mt-2 flex flex-wrap gap-2">{versions.data?.map((item) => <div key={item.id} className="flex items-center gap-2 rounded-control bg-surface-sunk px-2 py-1 text-cell"><Link to="/datasets/$resourceId" params={{ resourceId: item.id }} className="text-accent-ink hover:underline">{t(`版本 ${item.version} · ${item.status === 'ready' ? '可用' : item.status}`, `Version ${item.version} · ${item.status === 'ready' ? 'Ready' : item.status}`)}</Link>{item.id !== resourceId && item.status === 'ready' ? <Link to="/compare" search={{ leftId: item.id, rightId: resourceId }} className="text-accent-ink hover:underline">{t('与当前版本核对', 'Compare with current version')}</Link> : null}</div>)}</div></div></Panel>
    </PageBody></>
}

function CellValueEditor({ value, onStage }: { value: string; onStage: (value: string) => void }) {
  const t = useT()
  const [draft, setDraft] = useState(value)
  return <><p className="text-meta text-ink-3">{t('完整内容', 'Complete value')} · {bytes(new TextEncoder().encode(value).byteLength)}</p><textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={8} className="w-full resize-y rounded-control bg-surface px-3 py-2 text-cell text-ink shadow-rail" /><div className="flex gap-2"><Button size="sm" disabled={draft === value} onClick={() => onStage(draft)}>{t('加入修正草稿', 'Add to correction draft')}</Button><Button size="sm" disabled={draft === ''} onClick={() => { setDraft(''); onStage('') }}>{t('清空此格', 'Clear cell')}</Button></div></>
}

function AdvancedViewPanel({ resourceId, columns }: { resourceId: string; columns: Schema['columns'] }) {
  const t = useT()
  type DraftCondition = { columnId: string; operator: ViewPlan['conditions'][number]['operator']; value: string; other: string; group: number }
  type DraftSort = ViewPlan['sorts'][number]
  const client = useQueryClient()
  const [combine, setCombine] = useSessionDraft<'and' | 'or'>(`AdvancedViewPanel.${resourceId}.combine`, 'and')
  const [conditions, setConditions] = useSessionDraft<DraftCondition[]>(`AdvancedViewPanel.${resourceId}.conditions`, [])
  const [groupModes, setGroupModes] = useSessionDraft<('and' | 'or')[]>(`AdvancedViewPanel.${resourceId}.groupModes`, ['and'])
  const [sorts, setSorts] = useSessionDraft<DraftSort[]>(`AdvancedViewPanel.${resourceId}.sorts`, [])
  const [key, setKey] = useState(() => `view_${crypto.randomUUID()}`)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const relatedJobs = useQuery({ queryKey: ['view-plan-jobs', resourceId], queryFn: () => api.findJobs({ inputId: resourceId }, 0, 20),
    refetchInterval: (query) => query.state.data?.items.some((item) => item.kind === 'filter' &&
      ['queued', 'running', 'cancel_requested'].includes(item.state)) ? 2000 : false })
  const visibleJobId = activeJobId ?? relatedJobs.data?.items.find((item) => item.kind === 'filter')?.id ?? null
  const changed = () => setKey(`view_${crypto.randomUUID()}`)
  const toCondition = (item: DraftCondition): ViewPlan['conditions'][number] => item.operator === 'in'
    ? { columnId: item.columnId, operator: item.operator, values: item.value.split('\n').filter((value) => value.length > 0) }
    : item.operator === 'between' ? { columnId: item.columnId, operator: item.operator, value: item.value, other: item.other }
    : item.operator === 'is-empty' || item.operator === 'not-empty' ? { columnId: item.columnId, operator: item.operator }
    : { columnId: item.columnId, operator: item.operator, value: item.value }
  const plan: ViewPlan = { combine, conditions: [], sorts,
    groups: conditions.length ? groupModes.map((mode, group) => ({ combine: mode,
      conditions: conditions.filter((item) => item.group === group).map(toCondition) })) : undefined }
  const submit = useMutation({ mutationFn: () => api.filterPlan(resourceId, plan, key), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    setActiveJobId(result.job.id)
  } })
  const activeJob = useQuery({ queryKey: ['job', visibleJobId], queryFn: () => api.job(visibleJobId!), enabled: Boolean(visibleJobId),
    refetchInterval: (query) => ['queued', 'running', 'cancel_requested'].includes(query.state.data?.state ?? '') ? 1500 : false })
  const cancelActive = useMutation({ mutationFn: () => api.cancel(visibleJobId!), onSuccess: () => void activeJob.refetch() })
  const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
  const updateCondition = (index: number, patch: Partial<DraftCondition>) => {
    const before = conditions[index]
    if (!before) return
    const next = conditions.map((item, at) => at === index ? { ...item, ...patch } : item)
    if (patch.group !== undefined && patch.group !== before.group && groupModes.length > 1 &&
      !next.some((item) => item.group === before.group)) {
      setGroupModes((modes) => modes.filter((_, at) => at !== before.group))
      setConditions(next.map((item) => ({ ...item, group: item.group > before.group ? item.group - 1 : item.group })))
    } else setConditions(next)
    changed()
  }
  const removeCondition = (index: number) => {
    const removed = conditions[index]
    if (!removed) return
    const remaining = conditions.filter((_, at) => at !== index)
    if (groupModes.length > 1 && !remaining.some((item) => item.group === removed.group)) {
      setGroupModes((modes) => modes.filter((_, at) => at !== removed.group))
      setConditions(remaining.map((item) => ({ ...item, group: item.group > removed.group ? item.group - 1 : item.group })))
    } else setConditions(remaining)
    changed()
  }
  const updateSort = (index: number, patch: Partial<DraftSort>) => {
    setSorts((items) => items.map((item, at) => at === index ? { ...item, ...patch } : item)); changed()
  }
  const groupsValid = !conditions.length || groupModes.every((_, index) => conditions.some((item) => item.group === index))
  const availableColumns = new Set(columns.map((column) => column.id))
  const needsRebind = columns.length > 0 && [...conditions, ...sorts].some((item) => !availableColumns.has(item.columnId))
  return <Panel className="space-y-4"><SectionTitle title={t('组合筛选与全表排序', 'Combined filters and full-table sort')} /><p className="text-meta text-ink-3">{t('所有条件作用于完整数据集；排序按列依次比较，值相同按原始行顺序保持稳定。文本范围和排序按原始文本比较，空值位置单独指定。结果保存为固定的新数据集。', 'All conditions apply to the complete dataset. Sorts compare columns in order and preserve original row order for ties. Text ranges and sorts use original text; empty value placement is explicit. The result is saved as a new fixed dataset.')}</p>
    {needsRebind ? <Banner tone="warn">{t('已保存条件中的字段不在当前数据集版本中。请逐项重新选择字段后再运行。', 'Some saved fields are absent from this dataset version. Reselect them before running.')}</Banner> : null}
    {conditions.length ? <label className="block max-w-56 space-y-1 text-meta text-ink-3">{t('条件组之间', 'Between groups')}<select value={combine} onChange={(event) => { setCombine(event.target.value as 'and' | 'or'); changed() }} className={selectClass}><option value="and">{t('全部满足（AND）', 'All (AND)')}</option><option value="or">{t('满足任一（OR）', 'Any (OR)')}</option></select></label> : null}
    {conditions.length ? <div className="flex flex-wrap gap-3">{groupModes.map((mode, index) => <label key={index} className="text-meta text-ink-3">{t(`第 ${index + 1} 组内`, `Within group ${index + 1}`)}<select value={mode} onChange={(event) => { setGroupModes((modes) => modes.map((value, at) => at === index ? event.target.value as 'and' | 'or' : value)); changed() }} className={selectClass}><option value="and">{t('全部满足（AND）', 'All (AND)')}</option><option value="or">{t('满足任一（OR）', 'Any (OR)')}</option></select></label>)}</div> : null}
    {conditions.map((item, index) => <div key={index} className="grid gap-2 rounded-control bg-surface-sunk p-3 sm:grid-cols-4">
      <label className="space-y-1 text-meta text-ink-3">{t('条件组', 'Condition group')}<select value={item.group} onChange={(event) => updateCondition(index, { group: Number(event.target.value) })} className={selectClass}>{groupModes.map((_, group) => <option key={group} value={group}>{t(`第 ${group + 1} 组`, `Group ${group + 1}`)}</option>)}</select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<select value={item.columnId} onChange={(event) => updateCondition(index, { columnId: event.target.value })} className={selectClass}>{!availableColumns.has(item.columnId) ? <option value={item.columnId}>{t(`原字段已失效：${item.columnId}`, `Previous field unavailable: ${item.columnId}`)}</option> : null}{columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('条件', 'Condition')}<select value={item.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as DraftCondition['operator'] })} className={selectClass}><option value="equals">{t('等于', 'Equals')}</option><option value="not-equals">{t('不等于', 'Does not equal')}</option><option value="contains">{t('包含', 'Contains')}</option><option value="starts">{t('开头为', 'Starts with')}</option><option value="ends">{t('结尾为', 'Ends with')}</option><option value="is-empty">{t('为空', 'Is empty')}</option><option value="not-empty">{t('非空', 'Is not empty')}</option><option value="between">{t('文本范围', 'Text range')}</option><option value="in">{t('集合（每行一个值）', 'Set (one value per line)')}</option><option value="pattern">{t('受限表达式（完整匹配）', 'Limited pattern (full match)')}</option></select></label>
      {!['is-empty', 'not-empty'].includes(item.operator) ? <label className="space-y-1 text-meta text-ink-3">{item.operator === 'between' ? t('起始值', 'Start value') : t('值', 'Value')}{item.operator === 'in' ? <textarea value={item.value} maxLength={8192} rows={3} onChange={(event) => updateCondition(index, { value: event.target.value })} className="block w-full rounded-control bg-surface px-2 py-1 text-cell text-ink shadow-rail" /> : <input value={item.value} maxLength={512} onChange={(event) => updateCondition(index, { value: event.target.value })} className={selectClass} />}</label> : <div />}
      {item.operator === 'between' ? <label className="space-y-1 text-meta text-ink-3">{t('结束值', 'End value')}<input value={item.other} maxLength={512} onChange={(event) => updateCondition(index, { other: event.target.value })} className={selectClass} /></label> : null}
      <Button size="sm" variant="quiet" onClick={() => removeCondition(index)}>{t('移除条件', 'Remove condition')}</Button>
    </div>)}
    <Button size="sm" disabled={!columns.length || conditions.length >= 16} onClick={() => { setConditions((items) => [...items, { columnId: columns[0]!.id, operator: 'equals', value: '', other: '', group: groupModes.length - 1 }]); changed() }}>{t('在最后一组添加条件', 'Add condition to last group')}</Button><Button size="sm" disabled={!columns.length || conditions.length >= 16 || groupModes.length >= 4} onClick={() => { setGroupModes((modes) => [...modes, 'and']); setConditions((items) => [...items, { columnId: columns[0]!.id, operator: 'equals', value: '', other: '', group: groupModes.length }]); changed() }}>{t('添加条件组', 'Add condition group')}</Button>
    <div className="space-y-2 border-t border-hairline-soft pt-4"><strong className="text-cell text-ink">{t('排序字段', 'Sort fields')}</strong>{sorts.map((item, index) => <div key={index} className="grid gap-2 rounded-control bg-surface-sunk p-3 sm:grid-cols-4">
      <label className="space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<select value={item.columnId} onChange={(event) => updateSort(index, { columnId: event.target.value })} className={selectClass}>{!availableColumns.has(item.columnId) ? <option value={item.columnId}>{t(`原字段已失效：${item.columnId}`, `Previous field unavailable: ${item.columnId}`)}</option> : null}{columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('方向', 'Direction')}<select value={item.direction} onChange={(event) => updateSort(index, { direction: event.target.value as DraftSort['direction'] })} className={selectClass}><option value="asc">{t('升序', 'Ascending')}</option><option value="desc">{t('降序', 'Descending')}</option></select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('空值', 'Empty values')}<select value={item.empty} onChange={(event) => updateSort(index, { empty: event.target.value as DraftSort['empty'] })} className={selectClass}><option value="last">{t('最后', 'Last')}</option><option value="first">{t('最前', 'First')}</option></select></label>
      <Button size="sm" variant="quiet" onClick={() => { setSorts((items) => items.filter((_, at) => at !== index)); changed() }}>{t('移除排序', 'Remove sort')}</Button>
    </div>)}<Button size="sm" disabled={!columns.length || sorts.length >= 4 || sorts.length >= columns.length} onClick={() => { const next = columns.find((column) => !sorts.some((item) => item.columnId === column.id)); if (next) setSorts((items) => [...items, { columnId: next.id, direction: 'asc', empty: 'last' }]); changed() }}>{t('添加排序字段', 'Add sort field')}</Button></div>
    {activeJob.error ? <Banner tone="danger" title={t('计算状态读取失败', 'Could not load calculation status')}>{activeJob.error.message}</Banner> : null}
    {activeJob.data ? <Banner tone={activeJob.data.state === 'failed' || activeJob.data.state === 'interrupted' ? 'danger' : 'info'} title={t(`本次全表计算：${jobState[activeJob.data.state]}`, `Full-table calculation: ${jobStateLabel(activeJob.data.state)}`)}><div className="space-y-2"><p>{t('下方仍显示原数据集。计算结果完成前不会替换当前数据。', 'The original dataset remains visible below. It will not be replaced before the calculation finishes.')}</p>{activeJob.data.error ? <p>{localizedErrorMessage(activeJob.data.error.code, activeJob.data.error.message)}</p> : null}<div className="flex flex-wrap gap-3"><Link to="/jobs/$jobId" params={{ jobId: activeJob.data.id }} className="text-accent-ink hover:underline">{t('查看任务详情', 'View job details')}</Link>{activeJob.data.state === 'succeeded' && activeJob.data.summary.outputId ? <Link to="/datasets/$resourceId" params={{ resourceId: activeJob.data.summary.outputId }} className="text-accent-ink hover:underline">{t('打开固定结果', 'Open fixed result')}</Link> : null}{['queued', 'running'].includes(activeJob.data.state) ? <Button size="sm" disabled={cancelActive.isPending} onClick={() => cancelActive.mutate()}>{t('取消本次计算', 'Cancel this calculation')}</Button> : null}</div></div></Banner> : null}
    {submit.error ? <Banner tone="danger" title={t('任务未提交', 'Job not submitted')}>{submit.error.message}</Banner> : null}<Button variant="primary" disabled={!columns.length || conditions.length + sorts.length === 0 || !groupsValid || needsRebind || submit.isPending || ['queued', 'running', 'cancel_requested'].includes(activeJob.data?.state ?? '')} onClick={() => submit.mutate()}>{t('运行全表条件并保存结果', 'Run full-table conditions and save result')}</Button>
  </Panel>
}

export function JobsPage() {
  const t = useT()
  const [cursor, setCursor] = useState('')
  const [previousCursors, setPreviousCursors] = useState<string[]>([])
  const [filterOffset, setFilterOffset] = useState(0)
  const [draft, setDraft] = useState({ name: '', kind: '', state: '', inputId: '', from: '', to: '' })
  const [applied, setApplied] = useState<JobFilters>({})
  const filtering = Object.values(applied).some((value) => value !== undefined && value !== '')
  const query = useQuery({ queryKey: ['jobs', 'page', cursor, filterOffset, applied],
    queryFn: () => filtering ? api.findJobs(applied, filterOffset, 50) : api.jobCursorPage(cursor, 50), refetchInterval: 2000 })
  const nextCursor: string | null = query.data && 'nextCursor' in query.data ? (query.data as CursorPage<Job>).nextCursor : null
  const update = (field: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [field]: value }))
  const apply = () => { setApplied({ name: draft.name.trim(), kind: draft.kind, state: draft.state, inputId: draft.inputId.trim(),
    from: draft.from ? displayDayStart(draft.from) : undefined,
    to: draft.to ? displayDayEnd(draft.to) : undefined }); setFilterOffset(0); setCursor(''); setPreviousCursors([]) }
  return <><PageTopBar title={t('任务与结果', 'Jobs and results')} facts={<Fact label={t('任务总数', 'Total jobs')}>{number(query.data?.total)}</Fact>} actions={<Button leading={<RefreshCw className="size-4" />} onClick={() => void query.refetch()}>{t('刷新', 'Refresh')}</Button>} /><PageBody className="space-y-3">
    <Panel><form className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" onSubmit={(event) => { event.preventDefault(); apply() }}>
      <label className="space-y-1 text-meta text-ink-3">{t('名称', 'Name')}<input value={draft.name} maxLength={100} onChange={(event) => update('name', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <label className="space-y-1 text-meta text-ink-3">{t('类型', 'Type')}<select value={draft.kind} onChange={(event) => update('kind', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option>{['import', 'filter', 'clean', 'dedup', 'export', 'combine', 'compare', 'sql', 'analyze', 'quality', 'split', 'batch'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('状态', 'Status')}<select value={draft.state} onChange={(event) => update('state', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option>{Object.keys(jobState).map((value) => <option key={value} value={value}>{jobStateLabel(value as Job['state'])}</option>)}</select></label>
      <label className="space-y-1 text-meta text-ink-3">{t('输入资源 ID', 'Input resource ID')}<input value={draft.inputId} maxLength={80} onChange={(event) => update('inputId', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <label className="space-y-1 text-meta text-ink-3">{t('开始日期', 'Start date')}<input type="date" value={draft.from} onChange={(event) => update('from', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <label className="space-y-1 text-meta text-ink-3">{t('结束日期', 'End date')}<input type="date" value={draft.to} onChange={(event) => update('to', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
      <p className="text-meta text-ink-3 sm:col-span-3 xl:col-span-6">{t('日期范围按已保存时区计算：', 'Date ranges use the saved timezone: ')}{getDisplayTimezone()}</p>
      <div className="flex gap-2 sm:col-span-3 xl:col-span-6"><Button type="submit" size="sm" variant="primary">{t('筛选完整任务列表', 'Search all jobs')}</Button><Button size="sm" onClick={() => { setDraft({ name: '', kind: '', state: '', inputId: '', from: '', to: '' }); setApplied({}); setFilterOffset(0); setCursor(''); setPreviousCursors([]) }}>{t('清除条件', 'Clear filters')}</Button></div>
    </form></Panel>
    <ErrorNotice error={query.error} />{query.isLoading ? <Spinner /> : <JobList items={query.data?.items ?? []} />}
    <div className="flex items-center gap-2"><Button size="sm" disabled={filtering ? filterOffset === 0 : previousCursors.length === 0} onClick={() => filtering ? setFilterOffset(Math.max(0, filterOffset - 50)) : (setCursor(previousCursors[previousCursors.length - 1]!), setPreviousCursors((items) => items.slice(0, -1)))}>{t('上一页', 'Previous')}</Button><span className="figure text-meta text-ink-3">{t(`第 ${filtering ? Math.floor(filterOffset / 50) + 1 : previousCursors.length + 1} 页 · 共 ${number(query.data?.total)} 项`, `Page ${filtering ? Math.floor(filterOffset / 50) + 1 : previousCursors.length + 1} · ${number(query.data?.total)} total`)}</span><Button size="sm" disabled={filtering ? filterOffset + 50 >= (query.data?.total ?? 0) : !nextCursor} onClick={() => filtering ? setFilterOffset(filterOffset + 50) : (setPreviousCursors((items) => [...items, cursor]), setCursor(nextCursor!))}>{t('下一页', 'Next')}</Button></div>
  </PageBody></>
}

export function SettingsPage() {
  const t = useT()
  const client = useQueryClient()
  const session = useQuery({ queryKey: ['session'], queryFn: api.session })
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities })
  const storage = useQuery({ queryKey: ['storage', 'details'], queryFn: api.storageDetails })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const cleanup = useQuery({ queryKey: ['storage', 'cleanup'], queryFn: api.cleanupPreview })
  const appLimits = useQuery({ queryKey: ['appLimits'], queryFn: api.appLimits })
  const [draft, setDraft] = useState<UserSettings | null>(null)
  const [limitsDraft, setLimitsDraft] = useState<AppLimits | null>(null)
  const [purgeCandidate, setPurgeCandidate] = useState<CleanupItem | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const current = draft ?? settings.data?.settings
  const save = useMutation({ mutationFn: () => api.saveSettings(current!, settings.data?.updatedAt ?? null), onSuccess: (result) => {
    client.setQueryData(['settings'], result); setDraft(null)
  } })
  const saveLimits = useMutation({ mutationFn: () => api.saveAppLimits(limitsDraft!, appLimits.data?.updatedAt ?? null), onSuccess: (result) => {
    client.setQueryData(['appLimits'], result); setLimitsDraft(null)
    void client.invalidateQueries({ queryKey: ['storage', 'details'] })
  } })
  const clear = useMutation({ mutationFn: api.clearPreviewCache, onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['storage', 'details'] })
  } })
  const purge = useMutation({ mutationFn: (item: CleanupItem) => api.purgeTrashedResource(item.id, item.updatedAt), onSuccess: () => {
    setPurgeCandidate(null); setAcknowledged(false)
    void client.invalidateQueries({ queryKey: ['storage'] })
    void client.invalidateQueries({ queryKey: ['trash'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
  } })
  const logout = useMutation({ mutationFn: api.logout, onSuccess: () => { window.location.assign('/auth/signed-out') } })
  const patch = (update: Partial<UserSettings>) => setDraft({ ...(current ?? { defaultEncoding: 'utf-8', timezone: 'Asia/Taipei', outputFormat: 'csv', safeText: true }), ...update })
  const effectiveLimits = limitsDraft ?? appLimits.data?.limits
  const patchLimit = (key: keyof AppLimits, value: number) => setLimitsDraft((current) => ({ ...(current ?? appLimits.data!.limits), [key]: value }))
  const limitFields: { key: keyof AppLimits; label: string; labelEn: string; unit: 'MiB' | '项' | '分钟' }[] = [
    { key: 'fileBytes', label: '普通单文件上限', labelEn: 'Single file limit', unit: 'MiB' }, { key: 'workbookBytes', label: '工作簿上限', labelEn: 'Workbook limit', unit: 'MiB' },
    { key: 'ownerQuotaBytes', label: '每用户空间上限', labelEn: 'Per-user storage limit', unit: 'MiB' }, { key: 'globalQuotaBytes', label: '全局空间上限', labelEn: 'Global storage limit', unit: 'MiB' },
    { key: 'minFreeBytes', label: '磁盘保留空间', labelEn: 'Reserved disk space', unit: 'MiB' }, { key: 'maxActiveOwnerJobs', label: '每用户待处理任务', labelEn: 'Pending jobs per user', unit: '项' },
    { key: 'maxActiveGlobalJobs', label: '全局待处理任务', labelEn: 'Global pending jobs', unit: '项' }, { key: 'maxOwnerUploads', label: '每用户未完成上传', labelEn: 'Unfinished uploads per user', unit: '项' },
    { key: 'maxGlobalUploads', label: '全局未完成上传', labelEn: 'Global unfinished uploads', unit: '项' }, { key: 'maxOwnerResources', label: '每用户资源数', labelEn: 'Resources per user', unit: '项' },
    { key: 'maxGlobalResources', label: '全局资源数', labelEn: 'Global resources', unit: '项' }, { key: 'taskTimeoutMinutes', label: '任务最长时间', labelEn: 'Maximum job duration', unit: '分钟' },
  ]
  return <><PageTopBar title={t('设置、空间与关于', 'Settings, storage and about')} /><PageBody className="space-y-5">
    <ErrorNotice error={session.error ?? capabilities.error ?? storage.error ?? settings.error ?? cleanup.error} />
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('当前空间', 'Current workspace')} /><p className="text-cell text-ink-2">{t('用户：', 'User: ')}{session.data?.user.name ?? t('读取中', 'Loading')}</p><p className="figure text-cell text-ink-2">{t('空间标识：', 'Workspace ID: ')}{session.data?.user.workspaceId ?? t('读取中', 'Loading')}</p><p className="text-cell text-ink-2">{t('身份来源：', 'Identity source: ')}{session.data?.source === 'lazycat' ? t('懒猫 OIDC', 'Lazycat OIDC') : t('本机开发模式', 'Local development mode')}{t('；权限：', '; role: ')}{session.data?.user.role === 'admin' ? t('管理员', 'Administrator') : t('普通用户', 'Standard user')}</p><p className="text-cell text-ink-2">{t('已登记文件：', 'Registered files: ')}{storage.data ? bytes(storage.data.usedBytes) : t('读取中', 'Loading')} / {storage.data ? bytes(storage.data.quotaBytes) : t('读取中', 'Loading')}</p>
      {session.data?.source === 'lazycat' ? <div><Button size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}>{t('退出当前应用会话', 'Sign out of this app session')}</Button>{logout.error ? <p className="mt-2 text-meta text-danger">{logout.error.message}</p> : null}</div> : null}
      <p className="text-meta text-ink-3">{t('资源仅在当前用户空间内列出。此应用默认不上传遥测或业务数据；文件保存在本机或懒猫应用数据目录。升级和重启后已提交的资源保留；永久删除的文件不能从应用恢复。', 'Resources are listed only in the current user workspace. The app does not upload telemetry or business data by default. Files stay in local or Lazycat app storage. Submitted resources remain after restart and upgrade; permanently deleted files cannot be recovered from the app.')}</p></Panel>
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('默认处理规则', 'Default processing rules')} /><p className="text-meta text-ink-3">{t('新任务可覆盖这些默认值；已完成任务仍使用提交时保存的规则。', 'New jobs may override these defaults. Completed jobs continue to use the rules saved at submission.')}</p>
      {current ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('默认文本编码', 'Default text encoding')}<select value={current.defaultEncoding} onChange={(event) => patch({ defaultEncoding: event.target.value as UserSettings['defaultEncoding'] })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030</option></select></label>
        <label className="space-y-1 text-meta text-ink-3">{t('日期默认时区', 'Default date timezone')}<input value={current.timezone} maxLength={64} onChange={(event) => patch({ timezone: event.target.value })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /><span>{t('使用 IANA 名称，例如 Asia/Taipei。页面时间按此时区显示；带时区时间点核对仍按输入偏移转换为 UTC。', 'Use an IANA name such as Asia/Taipei. Page timestamps use this zone; comparison instants still use their explicit input offsets and UTC.')}</span></label>
        <label className="space-y-1 text-meta text-ink-3">{t('默认输出格式', 'Default output format')}<select value={current.outputFormat} onChange={(event) => patch({ outputFormat: event.target.value as UserSettings['outputFormat'] })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet'].map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label>
        <label className="flex items-center gap-2 text-cell text-ink-2"><input type="checkbox" checked={current.safeText} onChange={(event) => patch({ safeText: event.target.checked })} />{t('CSV/TSV 导出默认启用电子表格安全文本', 'Use spreadsheet-safe text by default for CSV/TSV exports')}</label></div> : <Spinner />}
      <div className="flex gap-2"><Button variant="primary" disabled={!draft || save.isPending} onClick={() => save.mutate()}>{t('保存默认设置', 'Save defaults')}</Button><Button disabled={!draft} onClick={() => setDraft(null)}>{t('撤销本次修改', 'Discard changes')}</Button></div>
      {save.error ? <Banner tone="danger" title={t('设置未保存', 'Settings not saved')}>{save.error.message}</Banner> : null}</Panel>
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('空间占用与保护上限', 'Storage use and limits')} /><p className="text-meta text-ink-3">{t('已登记占用包含回收站，上传和任务临时文件另列；预览缓存只在内存中。', 'Registered usage includes trash. Uploads and temporary job files are shown separately. Preview cache is kept only in memory.')}</p>
      <div className="grid gap-2 sm:grid-cols-2">{storage.data?.categories.map((item) => <p key={`${item.kind}-${item.status}`} className="rounded-control bg-surface-sunk px-3 py-2 text-cell text-ink-2">{kindLabel(item.kind)} · {item.status === 'trashed' ? t('回收站', 'Trash') : t('可用', 'Ready')}{t('：', ': ')}{t(`${item.count} 项，${bytes(item.bytes)}`, `${item.count} items, ${bytes(item.bytes)}`)}</p>)}</div>
      {storage.data ? <><p className="text-cell text-ink-2">{t(`未完成上传目录：${bytes(storage.data.uploads.bytes)}`, `Unfinished uploads: ${bytes(storage.data.uploads.bytes)}`)}{storage.data.uploads.complete ? '' : t('（目录过大，统计未完成）', ' (directory too large; count incomplete)')}{t(`；任务临时目录：${bytes(storage.data.temporaryJobs.bytes)}；内存预览缓存：${bytes(storage.data.previewCacheBytes)}`, `; temporary job files: ${bytes(storage.data.temporaryJobs.bytes)}; memory preview cache: ${bytes(storage.data.previewCacheBytes)}`)}</p>
        <p className="text-meta text-ink-3">{t(`单文件上限 ${bytes(storage.data.limits.fileBytes)}，工作簿 ${bytes(storage.data.limits.workbookBytes)}；每用户同时待处理任务上限 ${storage.data.limits.maxActiveOwnerJobs}；任务最长 ${storage.data.limits.taskTimeoutMinutes} 分钟。`, `Single file limit: ${bytes(storage.data.limits.fileBytes)}; workbook limit: ${bytes(storage.data.limits.workbookBytes)}; pending jobs per user: ${storage.data.limits.maxActiveOwnerJobs}; maximum job duration: ${storage.data.limits.taskTimeoutMinutes} minutes.`)}</p></> : <Spinner />}
      <Button size="sm" disabled={clear.isPending || !storage.data?.previewCacheBytes} onClick={() => clear.mutate()}>{t('清除本人内存预览缓存', 'Clear my memory preview cache')}</Button>
      {clear.data ? <p className="text-meta text-ink-3">{t(`已释放 ${bytes(clear.data.freedBytes)} 缓存；删除原文件 0 项。`, `Freed ${bytes(clear.data.freedBytes)} of cache; no original files were deleted.`)}</p> : null}
      {clear.error ? <Banner tone="danger" title={t('缓存清理失败', 'Could not clear cache')}>{clear.error.message}</Banner> : null}</Panel>
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('管理员保护上限', 'Administrator limits')} /><p className="text-meta text-ink-3">{t('管理员可把上限调低至本版本支持的安全范围内；调整后新上传与新任务立即采用生效值。已有资源不会被自动删除。', 'Administrators may lower limits within this version’s supported range. New uploads and jobs use the updated values immediately. Existing resources are not removed automatically.')}</p>{appLimits.error ? <Banner tone="danger">{appLimits.error.message}</Banner> : null}{effectiveLimits ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{limitFields.map((field) => <label key={field.key} className="text-meta text-ink-2">{t(field.label, field.labelEn)} ({field.unit === 'MiB' ? 'MiB' : field.unit === '项' ? t('项', 'items') : t('分钟', 'minutes')})<input type="number" min={1} step={1} value={field.unit === 'MiB' ? Math.round(effectiveLimits[field.key] / 1048576) : effectiveLimits[field.key]} disabled={!appLimits.data?.canEdit} onChange={(event) => patchLimit(field.key, Number(event.target.value) * (field.unit === 'MiB' ? 1048576 : 1))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label>)}</div> : <Spinner />}{appLimits.data?.canEdit ? <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={!limitsDraft || saveLimits.isPending} onClick={() => saveLimits.mutate()}>{t('保存保护上限', 'Save limits')}</Button><Button disabled={!limitsDraft} onClick={() => setLimitsDraft(null)}>{t('撤销修改', 'Discard changes')}</Button></div> : <p className="text-meta text-ink-3">{t('当前身份只能查看生效值。', 'Your current role can only view active limits.')}</p>}{saveLimits.error ? <Banner tone="danger">{saveLimits.error.message}</Banner> : null}</Panel>
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('回收站清理预览', 'Trash cleanup preview')} /><p className="text-meta text-ink-3">{t(cleanup.data?.note ?? '正在读取可清理资源。', cleanup.data ? 'Permanently removed files cannot be recovered. Derived results remain, but their source files may no longer open.' : 'Loading removable resources. ')}{t('本页最多显示前 100 项；完整回收站仍可在资源页查看。', 'This page shows up to 100 items; view the full trash on the resources page.')}</p>
      {cleanup.data?.items.length ? <div className="max-h-80 space-y-2 overflow-auto">{cleanup.data.items.map((item) => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-surface-sunk px-3 py-2 text-cell"><span className="min-w-0 flex-1 truncate" title={item.name}>{item.name} · {t(`预计 ${bytes(item.estimatedBytes)} · 关联结果 ${item.dependentResources} 项`, `Estimated ${bytes(item.estimatedBytes)} · ${item.dependentResources} linked results`)}</span><Button size="sm" disabled={!item.canPurge} onClick={() => { setPurgeCandidate(item); setAcknowledged(false) }}>{t('查看影响', 'Review impact')}</Button></div>)}</div> : <p className="text-cell text-ink-3">{t('回收站暂无可预览的资源。', 'No resources are available to preview in trash.')}</p>}
      {purgeCandidate ? <div className="space-y-2 rounded-control border border-hairline p-3 text-cell"><strong>{purgeCandidate.name}</strong><p>{t(`预计释放 ${bytes(purgeCandidate.estimatedBytes)}。关联的 ${purgeCandidate.dependentResources} 项结果仍保留，但可能无法再打开此来源文件。此操作不能撤销。`, `Estimated release: ${bytes(purgeCandidate.estimatedBytes)}. The ${purgeCandidate.dependentResources} linked results remain, but this source file may no longer be available. This cannot be undone.`)}</p><label className="flex items-center gap-2"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />{t('我已核对资源名称和影响', 'I have checked the resource name and impact')}</label><div className="flex gap-2"><Button size="sm" variant="danger" disabled={!acknowledged || purge.isPending} onClick={() => purge.mutate(purgeCandidate)}>{t('永久清理所选资源', 'Permanently remove resource')}</Button><Button size="sm" onClick={() => setPurgeCandidate(null)}>{t('取消', 'Cancel')}</Button></div></div> : null}
      {purge.data ? <p className="text-cell text-ink-2">{t(`实际释放 ${bytes(purge.data.freedBytes)}`, `Freed ${bytes(purge.data.freedBytes)}`)}{purge.data.pendingFileCleanup ? t('；文件目录待下次启动继续清理', '; file cleanup will resume at next startup') : ''}{t('。', '.')}</p> : null}
      {purge.error ? <Banner tone="danger" title={t('清理未完成', 'Cleanup not completed')}>{purge.error.message}</Banner> : null}</Panel>
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('应用与引擎', 'App and engine')} /><p className="text-cell text-ink-2">{t('工作台版本：', 'Workbench version: ')}{capabilities.data?.app.version ?? t('读取中', 'Loading')}{t('；许可证：', '; license: ')}{capabilities.data?.app.license ?? t('读取中', 'Loading')}{t('；当前入口：', '; access mode: ')}{capabilities.data?.app.mode === 'local' ? t('本机浏览器', 'Local browser') : t('平台会话', 'Platform session')}</p><p className="text-cell text-ink-2">{t('qsv 引擎：', 'qsv engine: ')}{capabilities.data?.engine.verified ? t('已验证', 'Verified') : t('不可用', 'Unavailable')}{t('；版本：', '; version: ')}{capabilities.data?.engine.version ?? t('未知', 'Unknown')}</p><p className="figure break-all text-meta text-ink-3">{t('平台：', 'Platform: ')}{capabilities.data?.engine.platform ?? t('未知', 'Unknown')}{t('；引擎 SHA-256：', '; engine SHA-256: ')}{capabilities.data?.engine.sha256 ?? t('未知', 'Unknown')}</p>{capabilities.data?.engine.reason ? <p className="text-meta text-danger-ink">{engineReason(capabilities.data.engine.reason)}</p> : null}<p className="text-meta text-ink-3">{t('可导入：', 'Import formats: ')}{capabilities.data?.app.importFormats.join(', ') ?? t('读取中', 'Loading')}{t('。可导出：', '. Export formats: ')}{capabilities.data?.app.exportFormats.join(', ') ?? t('读取中', 'Loading')}{t('。', '.')}</p><p className="text-meta text-ink-3">{t('默认不上传遥测或业务数据。本机数据保存在工作台数据目录；重启与升级保留已提交资源，永久删除的文件无法从应用恢复。备份与恢复需在服务停止时按仓库说明执行；卸载前请先备份需要保留的数据。', 'Telemetry and business data are not uploaded by default. Local data stays in the workbench data directory. Submitted resources remain after restart and upgrade; permanently deleted files cannot be restored by the app. Back up and restore only while the service is stopped, following the repository instructions. Back up data you need before uninstalling.')}</p></Panel>
  </PageBody></>
}
