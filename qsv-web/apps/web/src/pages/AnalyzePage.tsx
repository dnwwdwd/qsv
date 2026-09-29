import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useDatasetSearch } from '@/ui/useDatasetSearch'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type AggregateConfig, type PivotConfig } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { getLocale, useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'

export function AnalyzePage() {
  const t = useT()
  const navigate = useNavigate()
  const { sourceId: requestedSourceId } = useSearch({ from: '/analyze' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['analyze', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('analyze')
  const [resultOffset, setResultOffset] = useState(0)
  const resultPage = useQuery({ queryKey: ['analyze', 'results', resultOffset],
    queryFn: () => api.findResources({ kind: 'dataset', status: 'ready' }, resultOffset, 100), refetchInterval: 5000 })
  const [sourceId, setSourceId] = useSessionDraft('AnalyzePage.sourceId', '')
  const lookupId = requestedSourceId || sourceId
  const requestedResource = useQuery({ queryKey: ['resource', lookupId], queryFn: () => api.resource(lookupId), enabled: Boolean(lookupId) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), ...(requestedResource.data ? [requestedResource.data] : [])]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready' && !item.metadata.analysis && !item.metadata.compareSummary).map((item) => [item.id, item] as const)).values()]
  useEffect(() => { if (requestedSourceId) setSourceId(requestedSourceId) }, [requestedSourceId, setSourceId])
  const [key, setKey] = useState(() => `analyze_${crypto.randomUUID()}`)
  const selected = sourceId || resources.data?.items.find((item) => item.kind === 'dataset' && item.status === 'ready' && !item.metadata.analysis && !item.metadata.compareSummary)?.id || datasets[0]?.id || ''
  const schema = useQuery({ queryKey: ['schema', selected], queryFn: () => api.schema(selected), enabled: Boolean(selected) })
  const [frequencyColumnId, setFrequencyColumnId] = useSessionDraft('AnalyzePage.frequencyColumnId', '')
  const [showFrequency, setShowFrequency] = useState(false)
  const [frequencyKey, setFrequencyKey] = useState(() => `frequency_${crypto.randomUUID()}`)
  const frequencyColumn = frequencyColumnId && schema.data?.columns.some((column) => column.id === frequencyColumnId)
    ? frequencyColumnId : schema.data?.columns[0]?.id ?? ''
  const frequencySample = useQuery({ queryKey: ['analyze', 'frequency-sample', selected], queryFn: async () => {
    const view = await api.createView(selected)
    return api.rows(view.id, 0, 200)
  }, enabled: showFrequency && Boolean(selected && frequencyColumn) })
  const frequencyValues = (() => {
    const columnIndex = Number(frequencyColumn.slice(2))
    const counts = new Map<string, number>()
    for (const row of frequencySample.data?.rows ?? []) {
      const value = String(row[columnIndex] ?? '')
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)
  })()
  const numericDistribution = (() => {
    const columnIndex = Number(frequencyColumn.slice(2))
    const values = (frequencySample.data?.rows ?? []).map((row) => String(row[columnIndex] ?? '').trim())
      .filter((value) => /^[+-]?\d+(?:\.\d+)?$/u.test(value)).map(Number).filter(Number.isFinite)
    if (!values.length) return null
    const low = Math.min(...values), high = Math.max(...values)
    const counts = Array.from({ length: low === high || !Number.isFinite(high - low) ? 1 : 5 }, () => 0)
    for (const value of values) {
      const index = counts.length === 1 ? 0 : Math.min(counts.length - 1, Math.floor((value - low) / (high - low) * counts.length))
      counts[index] = (counts[index] ?? 0) + 1
    }
    return { low, high, counts, total: values.length }
  })()
  const [groupColumnIds, setGroupColumnIds] = useSessionDraft<string[]>('AnalyzePage.groupColumnIds', [])
  const [measures, setMeasures] = useSessionDraft<AggregateConfig['measures']>('AnalyzePage.measures', [{ operation: 'count', name: getLocale() === 'en-US' ? 'Record count' : '记录数' }])
  const [groupKey, setGroupKey] = useState(() => `group_${crypto.randomUUID()}`)
  const [pivotRow, setPivotRow] = useSessionDraft('AnalyzePage.pivotRow', 'c_0')
  const [pivotColumn, setPivotColumn] = useSessionDraft('AnalyzePage.pivotColumn', 'c_1')
  const [pivotMeasure, setPivotMeasure] = useSessionDraft<AggregateConfig['measures'][number]>('AnalyzePage.pivotMeasure', { operation: 'count', name: getLocale() === 'en-US' ? 'Record count' : '记录数' })
  const [pivotKey, setPivotKey] = useState(() => `pivot_${crypto.randomUUID()}`)
  const [chartId, setChartId] = useSessionDraft('AnalyzePage.chartId', '')
  const [chartMetric, setChartMetric] = useSessionDraft('AnalyzePage.chartMetric', '')
  const [chartFilter, setChartFilter] = useSessionDraft('AnalyzePage.chartFilter', '')
  const chartResource = useQuery({ queryKey: ['resource', chartId], queryFn: () => api.resource(chartId), enabled: Boolean(chartId) })
  const results = [...new Map([...(resultPage.data?.items ?? []), chartResource.data].filter((item) => Boolean(item))
    .map((item) => [item!.id, item!] as const)).values()]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready' && Boolean(item.metadata.analysis))
  const chartResourceId = chartId || results.find((item) => (item.metadata.analysis as { kind?: string } | undefined)?.kind === 'group' ||
    (item.metadata.analysis as { kind?: string } | undefined)?.kind === 'pivot')?.id || ''
  const chartSchema = useQuery({ queryKey: ['schema', chartResourceId], queryFn: () => api.schema(chartResourceId), enabled: Boolean(chartResourceId) })
  const chartView = useQuery({ queryKey: ['chartView', chartResourceId], queryFn: () => api.createView(chartResourceId), enabled: Boolean(chartResourceId) })
  const chartBlock = useQuery({ queryKey: ['chartRows', chartView.data?.id], queryFn: () => api.rows(chartView.data!.id, 0, 100), enabled: Boolean(chartView.data) })
  const chartColumn = chartMetric || chartSchema.data?.columns[1]?.id || ''
  const chartIndex = Number(chartColumn.slice(2))
  const chartRows = (chartBlock.data?.rows ?? []).map((row) => ({ label: String(row[0] ?? ''), text: String(row[chartIndex] ?? '') }))
    .filter((entry) => entry.label.includes(chartFilter) && entry.text !== '' && Number.isFinite(Number(entry.text)))
  const chartMaximum = Math.max(1, ...chartRows.map((row) => Math.abs(Number(row.text))))
  const submit = useMutation({ mutationFn: () => api.analyze(selected, key), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const frequencySubmit = useMutation({ mutationFn: () => api.frequencyAnalyze(selected, frequencyColumn, frequencyKey),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['jobs'] })
      void client.invalidateQueries({ queryKey: ['resources'] })
      void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
    } })
  const groupSubmit = useMutation({ mutationFn: () => api.groupAnalyze(selected, { groupColumnIds, measures }, groupKey), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const pivotSubmit = useMutation({ mutationFn: () => {
    const pivot: PivotConfig = { rowColumnId: pivotRow, pivotColumnId: pivotColumn, measure: pivotMeasure }
    return api.pivotAnalyze(selected, pivot, pivotKey)
  }, onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
  const changeMeasure = (index: number, patch: Partial<AggregateConfig['measures'][number]>) => {
    setMeasures((items) => items.map((item, at) => at === index ? { ...item, ...patch } : item))
    setGroupKey(`group_${crypto.randomUUID()}`)
  }
  return <><PageTopBar title={t('统计与透视', 'Statistics and pivot tables')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    <DraftInputWarning ids={[sourceId]} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || requestedResource.isLoading} />
    <DraftInputWarning ids={[chartId]} availableIds={results.filter((item) => ['group', 'pivot'].includes((item.metadata.analysis as { kind?: string } | undefined)?.kind ?? '')).map((item) => item.id)} loading={resources.isLoading || chartResource.isLoading} />
    <Banner tone="info">{t('对完整数据集计算逐字段统计，并保存为可浏览、可下载的新资源。唯一值数量使用近似算法；原文件和数据集不会改动。', 'Calculate field statistics for the complete dataset and save a browsable, downloadable resource. Distinct counts are approximate; source files and datasets remain unchanged.')}</Banner>
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('字段统计', 'Field statistics')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length === 0 ? <p className="text-cell text-ink-3">{t('请先导入至少一个数据集。', 'Import at least one dataset first.')}</p> : null}
      <label className="block space-y-1 text-meta text-ink-3">{t('数据集', 'Dataset')}<select value={selected} onChange={(event) => { setSourceId(event.target.value); setKey(`analyze_${crypto.randomUUID()}`); setFrequencyKey(`frequency_${crypto.randomUUID()}`); setShowFrequency(false) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label>
      <p className="text-meta text-ink-3">{t('运行时会扫描全部记录。结果包含字段类型、空值、原缺字段数、原显式 null 数、最小值、最大值及近似唯一值数量。缺字段和显式 null 已转换为空文本，因此也包含在空值总数内；来源不可追溯时会明确标为“不可追溯”。近似唯一值只用于探索，不用于财务或唯一键判定。', 'The job scans all records. Results include field types, empty values, original missing fields, explicit nulls, minimum, maximum and approximate distinct counts. Missing fields and nulls converted to empty text are included in empty totals; untraceable origins are marked. Approximate distinct counts are for exploration, not financial or uniqueness decisions.')}</p>
      {submit.error ? <Banner tone="danger" title={t('统计未提交', 'Statistics job was not submitted')}>{submit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || submit.isPending} onClick={() => submit.mutate()}>{t('运行全表统计', 'Analyze complete dataset')}</Button>
      {selected ? <p className="text-meta text-ink-3">{t('统计中的可疑值只供核查；需要按业务规则判断时，可用', 'Suspicious values in statistics are for review. To apply business rules, use ')}<Link to="/quality" search={{ sourceId: selected }} className="text-accent-ink hover:underline">{t('数据质量检查', 'Data quality check')}</Link>{t('扫描完整数据集。', ' to scan the complete dataset.')}</p> : null}
    </Panel>
    <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('样本值频率', 'Sample value frequency')} /><p className="text-meta text-ink-3">{t('只读取所选数据集开头最多 200 行，显示其中最常见的 20 个值。比例仅代表这段样本，不能当作全表占比；完整记录可打开数据集筛选或导出。', 'Read up to the first 200 rows and show the 20 most common values. Percentages describe this sample only. Filter or export the dataset for complete records.')}</p><label className="block max-w-sm space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<select value={frequencyColumn} onChange={(event) => { setFrequencyColumnId(event.target.value); setFrequencyKey(`frequency_${crypto.randomUUID()}`); setShowFrequency(false) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><Button size="sm" disabled={!frequencyColumn} onClick={() => setShowFrequency(true)}>{t('读取开头样本', 'Read first sample')}</Button>{frequencySample.isLoading && showFrequency ? <Spinner /> : null}{frequencySample.error && showFrequency ? <Banner tone="danger">{frequencySample.error.message}</Banner> : null}{showFrequency && frequencySample.data ? <><p className="text-meta text-ink-3">{t(`样本 ${formatNumber(frequencySample.data.rows.length)} 行；若全表超过此数，后续记录未参与频率计算。`, `${formatNumber(frequencySample.data.rows.length)} sampled rows. Later records are excluded if the dataset has more rows.`)}</p><div className="max-h-64 overflow-auto"><table className="min-w-full text-left text-meta"><thead><tr><th>{t('值', 'Value')}</th><th>{t('样本次数', 'Sample count')}</th><th>{t('样本占比', 'Sample share')}</th></tr></thead><tbody>{frequencyValues.map(([value, amount]) => <tr key={value}><td className="max-w-64 truncate" title={value}>{value || t('（空文本）', '(empty text)')}</td><td>{amount}</td><td>{frequencySample.data.rows.length ? `${(amount / frequencySample.data.rows.length * 100).toFixed(1)}%` : '—'}</td></tr>)}</tbody></table></div></> : null}<div className="flex gap-3 text-cell">{selected ? <Link to="/datasets/$resourceId" params={{ resourceId: selected }} className="text-accent-ink hover:underline">{t('按完整数据集筛选', 'Filter complete dataset')}</Link> : null}{selected ? <Link to="/convert" search={{ sourceId: selected }} className="text-accent-ink hover:underline">{t('导出完整数据集', 'Export complete dataset')}</Link> : null}</div></Panel>
    {showFrequency && numericDistribution ? <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('样本数值分布', 'Sample numeric distribution')} /><p className="text-meta text-ink-3">{t(`从所选字段开头最多 200 行中识别 ${formatNumber(numericDistribution.total)} 个有限十进制数。区间仅用于探索，不能代替全表统计或金额精确计算。`, `Found ${formatNumber(numericDistribution.total)} finite decimal values in up to the first 200 rows. These ranges are exploratory and do not replace full statistics or exact financial calculations.`)}</p>
      {numericDistribution.counts.map((count, index) => {
        const lower = numericDistribution.low + (numericDistribution.high - numericDistribution.low) * index / numericDistribution.counts.length
        const upper = numericDistribution.low + (numericDistribution.high - numericDistribution.low) * (index + 1) / numericDistribution.counts.length
        return <div key={index} className="grid grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_3rem] items-center gap-2 text-meta"><span className="figure truncate" title={`${lower} — ${upper}`}>{numericDistribution.counts.length === 1 ? numericDistribution.low.toPrecision(5) : `${lower.toPrecision(5)} – ${upper.toPrecision(5)}`}</span><div className="h-4 rounded-xs bg-surface-sunk"><div className="h-full rounded-xs bg-accent" style={{ width: `${count / numericDistribution.total * 100}%` }} /></div><span className="figure text-right">{count}</span></div>
      })}</Panel> : null}
    <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('全表值频率', 'Full dataset value frequency')} /><p className="text-meta text-ink-3">{t('后台扫描所选字段的全部记录，计算精确次数和全表占比。结果只保留次数最高的 20 个值，同时记录不同值总数；可打开结果表或下载 CSV。其他值可在原数据集筛选。单个值上限 16 KiB，临时索引按输入大小限制在 64 MiB 至 1 GiB；超限时任务失败，不保存部分结果。', 'The job scans every record in the selected field for exact counts and whole-dataset shares. It saves the top 20 values and total distinct count; open or download the result. Filter the source for other values. Each value is limited to 16 KiB and the temporary index to 64 MiB–1 GiB based on input size. Exceeding a limit fails the job without a partial result.')}</p>
      {frequencySubmit.error ? <Banner tone="danger" title={t('频率任务未提交', 'Frequency job was not submitted')}>{frequencySubmit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || !frequencyColumn || frequencySubmit.isPending} onClick={() => frequencySubmit.mutate()}>{t('计算全表 Top 20', 'Calculate full dataset top 20')}</Button>
    </Panel>
    <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('全表分组汇总', 'Full dataset grouping')} /><p className="text-meta text-ink-3">{t('最多按 4 个字段分组、添加 8 项指标。结果最多 10 万组；金额求和与平均值按十进制文本精确计算并按所选位数四舍五入。空数值不参与 SUM/AVG；MIN/MAX 按原始文本比较。', 'Group by up to four fields and add up to eight measures. Results are limited to 100,000 groups. Sums and averages use exact decimal text and the selected rounding precision. Empty numeric values are excluded from SUM and AVG; MIN and MAX compare original text.')}</p>
      {schema.error ? <Banner tone="danger" title={t('字段读取失败', 'Could not load fields')}>{schema.error.message}</Banner> : null}
      <div className="space-y-2"><strong className="text-cell text-ink">{t('分组字段', 'Group fields')}</strong><div className="flex flex-wrap gap-3">{schema.data?.columns.map((column) => <label key={column.id} className="flex items-center gap-1 text-cell text-ink-2"><input type="checkbox" checked={groupColumnIds.includes(column.id)} disabled={!groupColumnIds.includes(column.id) && groupColumnIds.length >= 4} onChange={() => { setGroupColumnIds((items) => items.includes(column.id) ? items.filter((id) => id !== column.id) : [...items, column.id]); setGroupKey(`group_${crypto.randomUUID()}`) }} />{column.name}</label>)}</div></div>
      <div className="space-y-3"><strong className="text-cell text-ink">{t('汇总指标', 'Summary measures')}</strong>{measures.map((measure, index) => <div key={index} className="grid gap-3 rounded-control bg-surface-sunk p-3 sm:grid-cols-4"><label className="space-y-1 text-meta text-ink-3">{t('计算', 'Calculation')}<select value={measure.operation} onChange={(event) => changeMeasure(index, { operation: event.target.value as AggregateConfig['measures'][number]['operation'], columnId: event.target.value === 'count' ? undefined : measure.columnId ?? schema.data?.columns[0]?.id, precision: event.target.value === 'sum' || event.target.value === 'avg' ? measure.precision ?? 2 : undefined })} className={selectClass}><option value="count">{t('记录数 COUNT', 'Record count COUNT')}</option><option value="sum">{t('十进制求和 SUM', 'Decimal sum SUM')}</option><option value="avg">{t('十进制平均 AVG', 'Decimal average AVG')}</option><option value="min">{t('文本最小 MIN', 'Text minimum MIN')}</option><option value="max">{t('文本最大 MAX', 'Text maximum MAX')}</option></select></label>{measure.operation !== 'count' ? <label className="space-y-1 text-meta text-ink-3">{t('数值或文本字段', 'Numeric or text field')}<select value={measure.columnId ?? ''} onChange={(event) => changeMeasure(index, { columnId: event.target.value })} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label> : <div />}{measure.operation === 'sum' || measure.operation === 'avg' ? <label className="space-y-1 text-meta text-ink-3">{t('小数位', 'Decimal places')}<input type="number" min="0" max="18" value={measure.precision ?? 2} onChange={(event) => changeMeasure(index, { precision: Number(event.target.value) })} className={selectClass} /></label> : <div />}<label className="space-y-1 text-meta text-ink-3">{t('结果列名', 'Result column name')}<input value={measure.name} maxLength={120} onChange={(event) => changeMeasure(index, { name: event.target.value })} className={selectClass} /></label><Button size="sm" variant="quiet" disabled={measures.length === 1} onClick={() => { setMeasures((items) => items.filter((_, at) => at !== index)); setGroupKey(`group_${crypto.randomUUID()}`) }}>{t('移除指标', 'Remove measure')}</Button></div>)}<Button size="sm" disabled={measures.length >= 8} onClick={() => { setMeasures((items) => [...items, { operation: 'count', name: t(`记录数${items.length + 1}`, `Record count ${items.length + 1}`) }]); setGroupKey(`group_${crypto.randomUUID()}`) }}>{t('添加指标', 'Add measure')}</Button></div>
      {groupSubmit.error ? <Banner tone="danger" title={t('汇总未提交', 'Grouping job was not submitted')}>{groupSubmit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || !schema.data || !groupColumnIds.length || measures.some((item) => !item.name.trim()) || groupSubmit.isPending} onClick={() => groupSubmit.mutate()}>{t('运行全表分组汇总', 'Group complete dataset')}</Button>
    </Panel>
    <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('全表透视', 'Full dataset pivot')} /><p className="text-meta text-ink-3">{t('按行字段和列字段分组后展开聚合结果。列字段最多 100 个不同值、行字段最多 1000 组；超出上限不发布部分结果。', 'Group by a row and column field, then expand aggregated results. The column field allows up to 100 distinct values and the row field up to 1,000 groups; limits prevent partial results.')}</p>
      <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-meta text-ink-3">{t('透视行字段', 'Pivot row field')}<select value={pivotRow} onChange={(event) => { setPivotRow(event.target.value); setPivotKey(`pivot_${crypto.randomUUID()}`) }} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('透视列字段', 'Pivot column field')}<select value={pivotColumn} onChange={(event) => { setPivotColumn(event.target.value); setPivotKey(`pivot_${crypto.randomUUID()}`) }} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('聚合方式', 'Aggregation')}<select value={pivotMeasure.operation} onChange={(event) => { const operation = event.target.value as PivotConfig['measure']['operation']; setPivotMeasure((current) => ({ ...current, operation, columnId: operation === 'count' ? undefined : current.columnId ?? schema.data?.columns[0]?.id, precision: operation === 'sum' || operation === 'avg' ? current.precision ?? 2 : undefined })); setPivotKey(`pivot_${crypto.randomUUID()}`) }} className={selectClass}><option value="count">{t('记录数', 'Record count')}</option><option value="sum">{t('十进制求和', 'Decimal sum')}</option><option value="avg">{t('十进制平均', 'Decimal average')}</option><option value="min">{t('文本最小', 'Text minimum')}</option><option value="max">{t('文本最大', 'Text maximum')}</option></select></label></div>
      {pivotMeasure.operation !== 'count' ? <label className="block max-w-md space-y-1 text-meta text-ink-3">{t('聚合字段', 'Aggregate field')}<select value={pivotMeasure.columnId ?? ''} onChange={(event) => { setPivotMeasure((current) => ({ ...current, columnId: event.target.value })); setPivotKey(`pivot_${crypto.randomUUID()}`) }} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label> : null}
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('指标名称', 'Measure name')}<input value={pivotMeasure.name} maxLength={120} onChange={(event) => { setPivotMeasure((current) => ({ ...current, name: event.target.value })); setPivotKey(`pivot_${crypto.randomUUID()}`) }} className={selectClass} /></label>{pivotMeasure.operation === 'sum' || pivotMeasure.operation === 'avg' ? <label className="space-y-1 text-meta text-ink-3">{t('小数位', 'Decimal places')}<input type="number" min={0} max={18} value={pivotMeasure.precision ?? 2} onChange={(event) => { setPivotMeasure((current) => ({ ...current, precision: Number(event.target.value) })); setPivotKey(`pivot_${crypto.randomUUID()}`) }} className={selectClass} /></label> : null}</div>
      {pivotSubmit.error ? <Banner tone="danger" title={t('透视未提交', 'Pivot job was not submitted')}>{pivotSubmit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || !schema.data || schema.data.columns.length < 2 || pivotRow === pivotColumn || !pivotMeasure.name.trim() || pivotSubmit.isPending} onClick={() => pivotSubmit.mutate()}>{t('运行全表透视', 'Pivot complete dataset')}</Button>
    </Panel>
    <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('已完成的统计', 'Completed analyses')} />
      {resultPage.isLoading ? <Spinner /> : null}
      {resultPage.error ? <Banner tone="danger">{resultPage.error.message}</Banner> : null}
      {results.length === 0 && !resultPage.isLoading ? <p className="text-cell text-ink-3">{resultOffset || (resultPage.data?.total ?? 0) > 100 ? t('本段没有统计结果，可继续翻页。', 'No analysis results in this segment. Continue to another page.') : t('还没有已完成的统计。', 'No completed analyses yet.')}</p> : results.map((item) => {
        const analysis = item.metadata.analysis as { kind?: string; columnName?: string; distinctValues?: number; sourceRows?: number } | undefined
        return <div key={item.id} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-3 text-cell"><Link to="/datasets/$resourceId" params={{ resourceId: item.id }} className="min-w-0 flex-1 text-accent-ink hover:underline">{item.name}</Link><span className="figure text-meta text-ink-3">{analysis?.kind === 'frequency' ? t(`${analysis.columnName ?? '所选字段'} · 全表 ${formatNumber(analysis.sourceRows)} 行 · ${formatNumber(analysis.distinctValues)} 种值 · 前 ${item.rowCount ?? 0} 项`, `${analysis.columnName ?? 'Selected field'} · ${formatNumber(analysis.sourceRows)} total rows · ${formatNumber(analysis.distinctValues)} distinct values · top ${item.rowCount ?? 0}`) : t(`${formatNumber(item.rowCount)} ${analysis?.kind === 'group' ? '组' : '个字段'}`, `${formatNumber(item.rowCount)} ${analysis?.kind === 'group' ? 'groups' : 'fields'}`)}</span><a href={api.downloadUrl(item.id)} className="text-accent-ink hover:underline">{t('下载', 'Download')}</a></div>
      })}
      <div className="flex items-center gap-2"><Button size="sm" disabled={resultOffset === 0} onClick={() => setResultOffset((value) => Math.max(0, value - 100))}>{t('上一段', 'Previous')}</Button><span className="text-meta text-ink-3">{t(`第 ${Math.floor(resultOffset / 100) + 1} 段`, `Segment ${Math.floor(resultOffset / 100) + 1}`)}</span><Button size="sm" disabled={resultOffset + 100 >= (resultPage.data?.total ?? 0)} onClick={() => setResultOffset((value) => value + 100)}>{t('下一段', 'Next')}</Button></div>
    </Panel>
    <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('聚合结果图表', 'Aggregate result chart')} /><p className="text-meta text-ink-3">{t('图表取所选聚合结果表的前 100 行，显示的是已完成的全量聚合值。完整结果可打开数据集或下载 CSV。', 'The chart reads the first 100 rows of a completed aggregate result. Values come from the full aggregation. Open or download the result for all rows.')}</p>
      <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-meta text-ink-3">{t('聚合结果', 'Aggregate result')}<select value={chartResourceId} onChange={(event) => { setChartId(event.target.value); setChartMetric('') }} className={selectClass}>{results.filter((item) => ['group', 'pivot'].includes((item.metadata.analysis as { kind?: string } | undefined)?.kind ?? '')).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('指标', 'Measure')}<select value={chartColumn} onChange={(event) => setChartMetric(event.target.value)} className={selectClass}>{chartSchema.data?.columns.slice(1).map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('筛选当前图表标签', 'Filter chart labels')}<input value={chartFilter} onChange={(event) => setChartFilter(event.target.value)} className={selectClass} /></label></div>
      {chartSchema.error || chartView.error || chartBlock.error ? <Banner tone="danger">{(chartSchema.error ?? chartView.error ?? chartBlock.error)?.message}</Banner> : null}
      {chartView.isLoading || chartBlock.isLoading ? <Spinner /> : null}
      {!chartResourceId ? <p className="text-cell text-ink-3">{t('完成一份分组汇总或透视表后可查看图表。', 'Complete a grouping or pivot job to view a chart.')}</p> : null}
      <div className="max-h-96 space-y-2 overflow-auto">{chartRows.map((row, index) => <div key={`${row.label}-${index}`} className="grid grid-cols-[minmax(5rem,10rem)_minmax(0,1fr)_minmax(4rem,7rem)] items-center gap-2 text-meta"><span className="truncate text-ink-2" title={row.label}>{row.label || t('（空值）', '(empty)')}</span><div className="h-5 rounded-xs bg-surface-sunk"><div className={`h-full rounded-xs ${Number(row.text) < 0 ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${Math.max(1, Math.abs(Number(row.text)) / chartMaximum * 100)}%` }} /></div><span className="figure truncate text-right text-ink-2" title={row.text}>{row.text}</span></div>)}</div>
      {chartResourceId && chartRows.length === 0 && !chartBlock.isLoading ? <p className="text-cell text-ink-3">{t('当前指标或筛选没有可绘制的数值。', 'No numeric values can be plotted for this measure or filter.')}</p> : null}
      {chartResourceId ? <Link to="/datasets/$resourceId" params={{ resourceId: chartResourceId }} className="text-cell text-accent-ink hover:underline">{t('查看对应结果表', 'Open result table')}</Link> : null}
    </Panel>
  </PageBody></>
}
