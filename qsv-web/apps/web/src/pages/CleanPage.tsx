import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useDatasetSearch } from '@/ui/useDatasetSearch'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { CleanPlanBuilder } from './CleanPlanBuilder'
import { useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'

type CleanMode = 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'replace' | 'fill-empty' | 'nfc' | 'nfkc' | 'date-iso'

const labels: Record<CleanMode, string> = {
  trim: '去除首尾空白', squeeze: '压缩连续空白', squeeze0: '删除全部空白', lower: '转为小写', upper: '转为大写',
  replace: '替换指定文本', 'fill-empty': '填充空文本',
  nfc: 'Unicode NFC 标准化', nfkc: 'Unicode NFKC 兼容标准化',
  'date-iso': '日历日期转为 YYYY-MM-DD',
}
const labelsEn: Record<CleanMode, string> = {
  trim: 'Trim leading and trailing spaces', squeeze: 'Compress consecutive spaces', squeeze0: 'Remove all spaces',
  lower: 'Convert to lowercase', upper: 'Convert to uppercase', replace: 'Replace text', 'fill-empty': 'Fill empty text',
  nfc: 'Normalize Unicode NFC', nfkc: 'Normalize Unicode NFKC', 'date-iso': 'Convert calendar date to YYYY-MM-DD',
}

export function CleanPage() {
  const t = useT()
  const navigate = useNavigate()
  const { sourceId: requestedSourceId } = useSearch({ from: '/clean' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['clean', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('clean')
  const [sourceId, setSourceId] = useSessionDraft('CleanPage.sourceId', '')
  const lookupId = requestedSourceId || sourceId
  const requestedResource = useQuery({ queryKey: ['resource', lookupId], queryFn: () => api.resource(lookupId), enabled: Boolean(lookupId) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), ...(requestedResource.data ? [requestedResource.data] : [])]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready').map((item) => [item.id, item] as const)).values()]
  useEffect(() => { if (requestedSourceId) setSourceId(requestedSourceId) }, [requestedSourceId, setSourceId])
  const [columnId, setColumnId] = useSessionDraft('CleanPage.columnId', 'c_0')
  const [mode, setMode] = useSessionDraft<CleanMode>('CleanPage.mode', 'trim')
  const [find, setFind] = useSessionDraft('CleanPage.find', '')
  const [replacement, setReplacement] = useSessionDraft('CleanPage.replacement', '')
  const [dateFormat, setDateFormat] = useSessionDraft<'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy'>('CleanPage.dateFormat', 'yyyy-MM-dd')
  const [confirmed, setConfirmed] = useState(false)
  const [key, setKey] = useState(() => `clean_${crypto.randomUUID()}`)
  const [dedupeColumns, setDedupeColumns] = useSessionDraft<string[]>('CleanPage.dedupeColumns', [])
  const [dedupeKey, setDedupeKey] = useState(() => `dedup_${crypto.randomUUID()}`)
  const selectedSource = sourceId || resources.data?.items.find((item) => item.kind === 'dataset' && item.status === 'ready')?.id || datasets[0]?.id || ''
  const schema = useQuery({ queryKey: ['schema', selectedSource], queryFn: () => api.schema(selectedSource), enabled: Boolean(selectedSource) })
  const submit = useMutation({ mutationFn: () => api.clean(selectedSource, columnId, mode, key, find, replacement, dateFormat), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const dedupe = useMutation({ mutationFn: () => api.dedupe(selectedSource, dedupeColumns, dedupeKey), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const changeRule = () => setKey(`clean_${crypto.randomUUID()}`)
  return <><PageTopBar title={t('清洗与转换规则', 'Cleaning and transformation rules')} /><PageBody className="space-y-4">{datasetSearch.controls}<Banner tone="info">{t('当前可对单个字段执行文本清洗、固定文本替换或空文本填充，处理全部记录并保存为新数据集。原数据集和原文件保持不变。', 'Clean a single field, replace fixed text or fill empty text across every record and save a new dataset. The source dataset and file remain available.')}</Banner>
    <DraftInputWarning ids={[sourceId]} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || requestedResource.isLoading} />
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('文本清洗', 'Text cleaning')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length === 0 ? <p className="text-cell text-ink-3">{t('请先导入至少一个数据集。', 'Import at least one dataset first.')}</p> : null}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
        <label className="block space-y-1 text-meta text-ink-3">{t('数据集', 'Dataset')}<select aria-label={t('清洗数据集', 'Dataset to clean')} value={selectedSource} onChange={(event) => { setSourceId(event.target.value); setColumnId('c_0'); setDedupeColumns([]); setDedupeKey(`dedup_${crypto.randomUUID()}`); changeRule() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label>
        <label className="block space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<select aria-label={t('清洗字段', 'Field to clean')} value={columnId} onChange={(event) => { setColumnId(event.target.value); changeRule() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
        <label className="block space-y-1 text-meta text-ink-3">{t('操作', 'Operation')}<select aria-label={t('清洗操作', 'Cleaning operation')} value={mode} onChange={(event) => { setMode(event.target.value as CleanMode); setConfirmed(false); changeRule() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{(Object.keys(labels) as CleanMode[]).map((value) => <option key={value} value={value}>{t(labels[value], labelsEn[value])}</option>)}</select></label>
        {mode === 'replace' ? <label className="block space-y-1 text-meta text-ink-3">{t('查找文本', 'Find text')}<input value={find} maxLength={512} required onChange={(event) => { setFind(event.target.value); changeRule() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label> : null}
        {(mode === 'replace' || mode === 'fill-empty') ? <label className="block space-y-1 text-meta text-ink-3">{t('替换为', 'Replace with')}<input value={replacement} maxLength={512} onChange={(event) => { setReplacement(event.target.value); changeRule() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label> : null}
        {mode === 'date-iso' ? <><label className="block space-y-1 text-meta text-ink-3">{t('输入日期格式', 'Input date format')}<select value={dateFormat} onChange={(event) => { setDateFormat(event.target.value as typeof dateFormat); changeRule() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="yyyy-MM-dd">{t('年-月-日，例如 2026-09-26', 'Year-month-day, for example 2026-09-26')}</option><option value="yyyy/MM/dd">{t('年/月/日，例如 2026/09/26', 'Year/month/day, for example 2026/09/26')}</option><option value="dd/MM/yyyy">{t('日/月/年，例如 26/09/2026', 'Day/month/year, for example 26/09/2026')}</option><option value="MM/dd/yyyy">{t('月/日/年，例如 09/26/2026', 'Month/day/year, for example 09/26/2026')}</option></select></label><p className="text-meta text-ink-3">{t('仅处理日历日期，不解释时间或时区。空文本保留；非空且不符合格式的值会使任务失败并报告行号。', 'This handles calendar dates only, without interpreting time or time zones. Empty text remains; a nonempty value in the wrong format fails the job and reports its row.')}</p></> : null}
        {mode === 'squeeze0' ? <label className="flex gap-2 text-cell text-ink-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t('我已确认：删除全部空白可能改变姓名、公司名或地址等值。', 'I understand that removing all spaces may change names, company names or addresses.')}</span></label> : null}
        {mode === 'nfkc' ? <p className="text-meta text-ink-3">{t('NFKC 会合并某些视觉相近但原本不同的字符，例如全角字符；原始数据仍保留。', 'NFKC combines some characters that look similar but differ, such as full-width characters. The source data remains available.')}</p> : null}
        <p className="text-meta text-ink-3">{t('仅选定字段会改变；完成后会记录输入和规则，并生成新的可浏览、可下载版本。', 'Only the selected field changes. The input and rules are recorded, and a new browsable and downloadable version is created.')}</p>
        {schema.error ? <Banner tone="danger" title={t('字段读取失败', 'Could not load fields')}>{schema.error.message}</Banner> : null}
        {submit.error ? <Banner tone="danger" title={t('清洗未提交', 'Cleaning was not submitted')}>{submit.error.message}</Banner> : null}
        <Button type="submit" variant="primary" disabled={!selectedSource || !schema.data || submit.isPending || (mode === 'squeeze0' && !confirmed) || (mode === 'replace' && !find)}>{t('运行全表清洗', 'Clean complete dataset')}</Button>
      </form>
    </Panel>
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('按字段去重', 'Remove duplicates by fields')} /><p className="text-cell text-ink-2">{t('选择 1 至 16 个字段作为组合键。对于相同的组合键，保留原数据集中最先出现的记录，结果保存为新数据集。任务完成后可在输入、输出行数中查看移除数量。', 'Select 1 to 16 fields as a combined key. For each matching key, keep the first record in the source dataset and save a new dataset. The input and output row counts show how many records were removed.')}</p>
      <div className="grid gap-2 sm:grid-cols-2">{schema.data?.columns.map((column) => <label key={column.id} className="flex items-center gap-2 rounded-control bg-surface-sunk px-3 py-2 text-cell text-ink-2"><input type="checkbox" checked={dedupeColumns.includes(column.id)} disabled={!dedupeColumns.includes(column.id) && dedupeColumns.length >= 16} onChange={() => { setDedupeColumns((items) => items.includes(column.id) ? items.filter((id) => id !== column.id) : [...items, column.id]); setDedupeKey(`dedup_${crypto.randomUUID()}`) }} /><span>{column.name}</span></label>)}</div>
      {dedupe.error ? <Banner tone="danger" title={t('去重未提交', 'Deduplication was not submitted')}>{dedupe.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selectedSource || dedupeColumns.length === 0 || dedupe.isPending} onClick={() => dedupe.mutate()}>{t('运行全表去重', 'Remove duplicates from complete dataset')}</Button>
    </Panel>
    {schema.data ? <CleanPlanBuilder key={selectedSource} sourceId={selectedSource} schema={schema.data} /> : null}
  </PageBody></>
}
