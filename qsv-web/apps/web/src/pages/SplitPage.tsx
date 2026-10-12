import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useDatasetSearch } from '@/ui/useDatasetSearch'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ReshapeConfig, type SplitConfig } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'

export function SplitPage() {
  const t = useT()
  const { resourceId, sourceId: requestedSourceId } = useSearch({ from: '/split' })
  const navigate = useNavigate()
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['split', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('split')
  const workbookSearch = useDatasetSearch('split-workbook', 'raw')
  const [resultOffset, setResultOffset] = useState(0)
  const resultPage = useQuery({ queryKey: ['split', 'results', resultOffset],
    queryFn: () => api.findResources({ kind: 'export', status: 'ready' }, resultOffset, 100), refetchInterval: 5000 })
  const [sourceId, setSourceId] = useSessionDraft('SplitPage.sourceId', '')
  const lookupId = requestedSourceId || sourceId
  const requestedResource = useQuery({ queryKey: ['resource', lookupId], queryFn: () => api.resource(lookupId), enabled: Boolean(lookupId) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), ...(requestedResource.data ? [requestedResource.data] : [])]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready').map((item) => [item.id, item] as const)).values()]
  const workbooks = [...new Map([...(resources.data?.items ?? []), ...workbookSearch.items]
    .filter((item) => item.kind === 'raw' && item.status === 'ready' && ['xlsx','xls','xlsm','xlsb','ods'].includes(item.format))
    .map((item) => [item.id, item] as const)).values()]
  const results = resultPage.data?.items.filter((item) => item.format === 'zip' && Boolean(item.metadata.split)) ?? []
  useEffect(() => { if (requestedSourceId) setSourceId(requestedSourceId) }, [requestedSourceId, setSourceId])
  const [mode, setMode] = useSessionDraft<'rows' | 'value'>('SplitPage.mode', 'rows')
  const [includeHeader, setIncludeHeader] = useSessionDraft('SplitPage.includeHeader', true)
  const [size, setSize] = useSessionDraft('SplitPage.size', 100000)
  const [columnId, setColumnId] = useSessionDraft('SplitPage.columnId', 'c_0')
  const [key, setKey] = useState(() => `split_${crypto.randomUUID()}`)
  const [reshapeKind, setReshapeKind] = useSessionDraft<ReshapeConfig['kind']>('SplitPage.reshapeKind', 'split-column')
  const [reshapeColumn, setReshapeColumn] = useSessionDraft('SplitPage.reshapeColumn', 'c_0')
  const [reshapeDelimiter, setReshapeDelimiter] = useSessionDraft('SplitPage.reshapeDelimiter', ',')
  const [reshapeDirection, setReshapeDirection] = useSessionDraft<'columns' | 'rows'>('SplitPage.reshapeDirection', 'columns')
  const [reshapeMaxParts, setReshapeMaxParts] = useSessionDraft('SplitPage.reshapeMaxParts', 4)
  const [reshapeKeepEmpty, setReshapeKeepEmpty] = useSessionDraft('SplitPage.reshapeKeepEmpty', true)
  const [reshapeOverflow, setReshapeOverflow] = useSessionDraft<'error' | 'join-last'>('SplitPage.reshapeOverflow', 'error')
  const [groupKeys, setGroupKeys] = useSessionDraft<string[]>('SplitPage.groupKeys', ['c_0'])
  const [groupValue, setGroupValue] = useSessionDraft('SplitPage.groupValue', 'c_0')
  const [groupSeparator, setGroupSeparator] = useSessionDraft('SplitPage.groupSeparator', '、')
  const [reshapeKey, setReshapeKey] = useState(() => `reshape_${crypto.randomUUID()}`)
  const selected = sourceId || resources.data?.items.find((item) => item.kind === 'dataset' && item.status === 'ready')?.id || datasets[0]?.id || ''
  const source = datasets.find((item) => item.id === selected)
  const schema = useQuery({ queryKey: ['schema', selected], queryFn: () => api.schema(selected), enabled: Boolean(selected) })
  const splitConfig: SplitConfig = mode === 'rows' ? { mode, size, includeHeader } : { mode, columnId, includeHeader }
  const preflightSignature = JSON.stringify({ selected, hash: source?.contentHash, mode, size, columnId })
  const valuePreflight = useMutation({ mutationFn: async () => ({ signature: preflightSignature,
    result: await api.splitPreflight(selected, splitConfig) }) })
  const valuePreflightReady = valuePreflight.data?.signature === preflightSignature &&
    valuePreflight.data.result.sourceHash === source?.contentHash
  const submit = useMutation({ mutationFn: () => {
    return api.split(selected, splitConfig, key)
  }, onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['resources'] })
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const reshape = useMutation({ mutationFn: () => {
    const config: ReshapeConfig = reshapeKind === 'transpose' ? { kind: 'transpose' }
      : reshapeKind === 'group-join' ? { kind: 'group-join', keyIds: groupKeys, valueId: groupValue, separator: groupSeparator }
        : { kind: 'split-column', columnId: reshapeColumn, delimiter: reshapeDelimiter,
          direction: reshapeDirection, maxParts: reshapeMaxParts, keepEmpty: reshapeKeepEmpty, overflow: reshapeOverflow }
    return api.reshape(selected, config, reshapeKey)
  }, onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['resources'] })
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const changed = () => setReshapeKey(`reshape_${crypto.randomUUID()}`)
  const control = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
  const manifest = useQuery({ queryKey: ['splitManifest', resourceId], queryFn: () => api.splitManifest(resourceId!), enabled: Boolean(resourceId) })
  const estimated = mode === 'rows' && source?.rowCount !== null && source?.rowCount !== undefined ? Math.max(1, Math.ceil(source.rowCount / Math.max(1, size))) : null
  return <><PageTopBar title={t('拆分与重组', 'Split and reshape')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    {workbookSearch.controls}
    <DraftInputWarning ids={[sourceId]} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || requestedResource.isLoading} />
    <Banner tone="info">{t('按完整记录拆分数据集，可选择每份 CSV 是否保留表头。完成后可逐份下载，也可一次下载 ZIP；源数据不会改动。最多生成 1000 份。', 'Split a dataset by complete records and choose whether each CSV includes a header. Download files individually or as one ZIP. Source data remains unchanged. Up to 1,000 files are allowed.')}</Banner>
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('创建拆分任务', 'Create split job')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length === 0 ? <p className="text-cell text-ink-3">{t('请先导入至少一个数据集。', 'Import at least one dataset first.')}</p> : null}
      <label className="block space-y-1 text-meta text-ink-3">{t('数据集', 'Dataset')}<select value={selected} onChange={(event) => { setSourceId(event.target.value); setColumnId('c_0'); setKey(`split_${crypto.randomUUID()}`) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label>
      <label className="block space-y-1 text-meta text-ink-3">{t('拆分方式', 'Split method')}<select value={mode} onChange={(event) => { setMode(event.target.value as 'rows' | 'value'); setKey(`split_${crypto.randomUUID()}`) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="rows">{t('按每份记录数', 'Rows per file')}</option><option value="value">{t('按字段值', 'Field value')}</option></select></label>
      {mode === 'rows' ? <label className="block space-y-1 text-meta text-ink-3">{t('每份最多多少条记录', 'Maximum records per file')}<input type="number" min="1" max="100000000" value={size} onChange={(event) => { setSize(Number(event.target.value)); setKey(`split_${crypto.randomUUID()}`) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label> : <><label className="block space-y-1 text-meta text-ink-3">{t('分组字段', 'Group field')}<select value={columnId} onChange={(event) => { setColumnId(event.target.value); setKey(`split_${crypto.randomUUID()}`) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><p className="text-meta text-ink-3">{t('文件名采用字段值的 SHA-256 摘要，避免空值、特殊字符和重名造成覆盖；清单保留原值到文件名的对应关系。字段值种类超过 1000 时任务会停止。', 'Filenames use SHA-256 digests of field values to avoid collisions from empty or special values. The manifest maps original values to filenames. The job stops if there are more than 1,000 distinct values.')}</p></>}
      <label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={includeHeader} onChange={(event) => { setIncludeHeader(event.target.checked); setKey(`split_${crypto.randomUUID()}`) }} />{t('每份文件包含字段名表头', 'Include a field-name header in each file')}</label>
      {estimated !== null ? <p className="text-cell text-ink-2">{t(`预计生成 ${formatNumber(estimated)} 份文件。`, `Expected to create ${formatNumber(estimated)} files.`)}</p> : null}
      {mode === 'value' ? <div className="space-y-2 rounded-control bg-surface-sunk p-3"><p className="text-meta text-ink-3">{t('按字段值拆分前扫描完整数据集，准确计算文件份数；数据集或字段变化后需重新检查。', 'Before splitting by value, scan the complete dataset to count files exactly. Recheck after changing the dataset or field.')}</p><Button size="sm" disabled={!selected || !schema.data || valuePreflight.isPending} onClick={() => valuePreflight.mutate()}>{valuePreflight.isPending ? t('正在扫描…', 'Scanning…') : t('检查文件份数', 'Check file count')}</Button>{valuePreflight.error ? <Banner tone="danger">{valuePreflight.error.message}</Banner> : null}{valuePreflightReady && valuePreflight.data ? <p className="text-cell text-ink-2">{t(`将生成 ${formatNumber(valuePreflight.data.result.fileCount)} 份文件，包含 ${formatNumber(valuePreflight.data.result.sourceRows)} 条记录。`, `Will create ${formatNumber(valuePreflight.data.result.fileCount)} files containing ${formatNumber(valuePreflight.data.result.sourceRows)} records.`)}</p> : null}</div> : null}
      {schema.error ? <Banner tone="danger" title={t('字段读取失败', 'Could not load fields')}>{schema.error.message}</Banner> : null}
      {submit.error ? <Banner tone="danger" title={t('拆分任务未提交', 'Split job was not submitted')}>{submit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || !schema.data || submit.isPending || (!includeHeader && source?.rowCount === 0) ||
        mode === 'value' && !valuePreflightReady ||
        mode === 'rows' && (!Number.isSafeInteger(size) || size < 1 || size > 100000000 || (estimated !== null && estimated > 1000))} onClick={() => submit.mutate()}>{t('拆分完整数据集', 'Split complete dataset')}</Button>
    </Panel>
    <SheetSplitPanel workbooks={workbooks} />
    <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('重组数据集', 'Reshape dataset')} /><p className="text-meta text-ink-3">{t('使用上方选中的数据集；每次处理会创建新数据集，原文件保持不变。', 'Use the dataset selected above. Each operation creates a new dataset and keeps the source file.')}</p>
      <label className="block space-y-1 text-meta text-ink-3">{t('重组方式', 'Reshape method')}<select value={reshapeKind} onChange={(event) => { setReshapeKind(event.target.value as ReshapeConfig['kind']); changed() }} className={control}><option value="split-column">{t('分隔一列', 'Split a column')}</option><option value="group-join">{t('按键组合多行值', 'Join row values by key')}</option><option value="transpose">{t('行列转置', 'Transpose rows and columns')}</option></select></label>
      {reshapeKind === 'split-column' ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('待分隔字段', 'Field to split')}<select value={reshapeColumn} onChange={(event) => { setReshapeColumn(event.target.value); changed() }} className={control}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('分隔符', 'Delimiter')}<input value={reshapeDelimiter} maxLength={16} onChange={(event) => { setReshapeDelimiter(event.target.value); changed() }} className={control} /></label><label className="space-y-1 text-meta text-ink-3">{t('输出形式', 'Output shape')}<select value={reshapeDirection} onChange={(event) => { setReshapeDirection(event.target.value as 'columns' | 'rows'); changed() }} className={control}><option value="columns">{t('分为多列', 'Into columns')}</option><option value="rows">{t('分为多行', 'Into rows')}</option></select></label><label className="space-y-1 text-meta text-ink-3">{t('最多片段数', 'Maximum parts')}<input type="number" min={2} max={32} value={reshapeMaxParts} onChange={(event) => { setReshapeMaxParts(Number(event.target.value)); changed() }} className={control} /></label><label className="space-y-1 text-meta text-ink-3">{t('超出片段数', 'Too many parts')}<select value={reshapeOverflow} onChange={(event) => { setReshapeOverflow(event.target.value as 'error' | 'join-last'); changed() }} className={control}><option value="error">{t('报错并停止', 'Fail and stop')}</option><option value="join-last">{t('将剩余片段合入最后一格', 'Join remaining parts into last cell')}</option></select></label><label className="flex items-center gap-2 text-cell text-ink-2"><input type="checkbox" checked={reshapeKeepEmpty} onChange={(event) => { setReshapeKeepEmpty(event.target.checked); changed() }} />{t('保留空片段', 'Keep empty parts')}</label></div> : null}
      {reshapeKind === 'group-join' ? <div className="space-y-3"><p className="text-meta text-ink-3">{t('按源记录顺序保留所有重复值；每组最多输出 32767 字节。多条记录合并后，结果无法逐格追溯原来的缺字段或显式 null 来源。', 'Keep all duplicate values in source record order, up to 32,767 bytes per group. Once rows are combined, missing-field and explicit-null origins cannot be traced per cell.')}</p><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('组合值字段', 'Value field to join')}<select value={groupValue} onChange={(event) => { setGroupValue(event.target.value); changed() }} className={control}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('值之间的分隔符', 'Separator between values')}<input value={groupSeparator} maxLength={16} onChange={(event) => { setGroupSeparator(event.target.value); changed() }} className={control} /></label></div><div className="space-y-1"><p className="text-meta text-ink-3">{t('分组键，可选 1 至 8 列', 'Group key: select 1 to 8 columns')}</p><div className="flex flex-wrap gap-2">{schema.data?.columns.map((column) => <label key={column.id} className="flex items-center gap-1 rounded-control bg-surface-sunk px-2 py-1 text-cell"><input type="checkbox" checked={groupKeys.includes(column.id)} onChange={(event) => { setGroupKeys((items) => event.target.checked ? [...items, column.id] : items.filter((id) => id !== column.id)); changed() }} />{column.name}</label>)}</div></div></div> : null}
      {reshapeKind === 'transpose' ? <p className="text-meta text-ink-3">{t('转置最多支持 4095 条数据记录及 100 万个单元格；超过上限会在提交前拒绝。', 'Transpose supports up to 4,095 data records and 1 million cells. Larger inputs are rejected before submission.')}</p> : null}
      {reshape.error ? <Banner tone="danger" title={t('重组任务未提交', 'Reshape job was not submitted')}>{reshape.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || !schema.data || reshape.isPending ||
        (reshapeKind === 'split-column' && (!reshapeDelimiter || !Number.isSafeInteger(reshapeMaxParts) || reshapeMaxParts < 2 || reshapeMaxParts > 32)) ||
        (reshapeKind === 'group-join' && (groupKeys.length < 1 || groupKeys.length > 8)) ||
        (reshapeKind === 'transpose' && ((source?.rowCount ?? 0) > 4095 || (source?.rowCount ?? 0) * (source?.columnCount ?? 0) > 1_000_000))}
        onClick={() => reshape.mutate()}>{t('重组完整数据集', 'Reshape complete dataset')}</Button>
    </Panel>
    <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('已完成的拆分', 'Completed splits')} />{resultPage.isLoading ? <Spinner /> : null}{resultPage.error ? <Banner tone="danger">{resultPage.error.message}</Banner> : null}{results.length === 0 && !resultPage.isLoading ? <p className="text-cell text-ink-3">{resultOffset || (resultPage.data?.total ?? 0) > 100 ? t('本段没有拆分结果，可继续翻页。', 'No split results in this segment. Continue to another page.') : t('还没有已完成的拆分任务。', 'No completed split jobs yet.')}</p> : results.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-3 text-cell"><Link to="/split" search={{ resourceId: item.id }} className="min-w-0 flex-1 text-accent-ink hover:underline">{item.name}</Link><span className="text-meta text-ink-3">{t(`${formatNumber((item.metadata.split as { fileCount?: number }).fileCount)} 份`, `${formatNumber((item.metadata.split as { fileCount?: number }).fileCount)} files`)}</span><a href={api.downloadUrl(item.id)} className="text-accent-ink hover:underline">{t('下载 ZIP', 'Download ZIP')}</a></div>)}<div className="flex items-center gap-2"><Button size="sm" disabled={resultOffset === 0} onClick={() => setResultOffset((value) => Math.max(0, value - 100))}>{t('上一段', 'Previous')}</Button><span className="text-meta text-ink-3">{t(`第 ${Math.floor(resultOffset / 100) + 1} 段`, `Segment ${Math.floor(resultOffset / 100) + 1}`)}</span><Button size="sm" disabled={resultOffset + 100 >= (resultPage.data?.total ?? 0)} onClick={() => setResultOffset((value) => value + 100)}>{t('下一段', 'Next')}</Button></div></Panel>
    {resourceId ? <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('文件清单', 'File manifest')} />
      {manifest.isLoading ? <Spinner /> : null}
      {manifest.error ? <Banner tone="danger" title={t('清单读取失败', 'Could not load manifest')}>{manifest.error.message}</Banner> : null}
      {manifest.data ? <><p className="text-meta text-ink-3">{t(`共 ${formatNumber(manifest.data.files.length)} 份；总计 ${formatNumber(manifest.data.sourceRows)} 行。每份文件可单独下载。`, `${formatNumber(manifest.data.files.length)} files and ${formatNumber(manifest.data.sourceRows)} total rows. Each file can be downloaded separately.`)}</p><div className="max-h-[32rem] overflow-auto">{manifest.data.files.map((file) => <div key={file.name} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft py-2 text-cell"><span className="min-w-0 flex-1 break-all text-ink-2">{file.value === null ? file.name : `${file.value === '' ? t('（空值）', '(empty)') : file.value} → ${file.name}`}</span><span className="figure text-meta text-ink-3">{t(`${formatNumber(file.rows)} 行`, `${formatNumber(file.rows)} rows`)}</span><a href={api.splitFileUrl(resourceId, file.name)} className="text-accent-ink hover:underline">{t('下载', 'Download')}</a></div>)}</div></> : null}
    </Panel> : null}
  </PageBody></>
}

function SheetSplitPanel({ workbooks }: { workbooks: { id: string; name: string; format: string }[] }) {
  const t = useT()
  const client = useQueryClient()
  const [workbookId, setWorkbookId] = useSessionDraft('SheetSplitPanel.workbookId', '')
  const savedWorkbook = useQuery({ queryKey: ['resource', workbookId], queryFn: () => api.resource(workbookId), enabled: Boolean(workbookId) })
  const availableWorkbooks = [...workbooks, ...(savedWorkbook.data && savedWorkbook.data.kind === 'raw' && savedWorkbook.data.status === 'ready' &&
    ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(savedWorkbook.data.format) && !workbooks.some((item) => item.id === savedWorkbook.data.id)
    ? [savedWorkbook.data] : [])]
  const [selected, setSelected] = useSessionDraft<string[]>('SheetSplitPanel.selected', [])
  const [results, setResults] = useState<{ name: string; jobId?: string; error?: string }[]>([])
  const [busy, setBusy] = useState(false)
  const id = workbookId || availableWorkbooks[0]?.id || ''
  const sheets = useQuery({ queryKey: ['workbook', id, 'sheets'], queryFn: () => api.workbookSheets(id), enabled: Boolean(id) })
  const submit = async () => {
    if (!id || !availableWorkbooks.some((item) => item.id === id) || !selected.length ||
      !selected.every((name) => sheets.data?.some((sheet) => sheet.name === name))) return
    setBusy(true); setResults([])
    const keyRoot = crypto.randomUUID()
    const submitted = await Promise.allSettled(selected.map((name, index) => api.import(id, `sheet_${keyRoot}_${index}`, undefined, name)))
    setResults(submitted.map((result, index) => result.status === 'fulfilled' ? { name: selected[index]!, jobId: result.value.job.id } :
      { name: selected[index]!, error: result.reason instanceof Error ? result.reason.message : t('提交失败', 'Submission failed') }))
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    setBusy(false)
  }
  return <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('工作簿按 Sheet 拆分', 'Split workbook by sheet')} /><p className="text-meta text-ink-3">{t('从已上传的工作簿选择一个或多个工作表。每张表独立导入并生成可浏览的数据集，保留原 Sheet 名作为来源信息。', 'Select one or more sheets from an uploaded workbook. Each sheet is imported separately as a browsable dataset, with its original sheet name retained as source information.')}</p>
    <DraftInputWarning ids={[workbookId]} availableIds={availableWorkbooks.map((item) => item.id)} loading={savedWorkbook.isLoading} />
    {availableWorkbooks.length ? <label className="block space-y-1 text-meta">{t('工作簿', 'Workbook')}<select value={id} onChange={(event) => { setWorkbookId(event.target.value); setSelected([]); setResults([]) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell">{availableWorkbooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <p className="text-cell text-ink-3">{t('还没有已上传的工作簿。可先到导入页上传。', 'No uploaded workbooks yet. Upload one on the import page first.')}</p>}
    {sheets.error ? <Banner tone="danger" title={t('工作表读取失败', 'Could not load sheets')}>{sheets.error.message}</Banner> : null}
    <div className="grid gap-2 sm:grid-cols-2">{sheets.data?.map((sheet) => <label key={sheet.name} className="flex items-center gap-2 rounded-control bg-surface-sunk px-3 py-2 text-cell"><input type="checkbox" checked={selected.includes(sheet.name)} onChange={() => setSelected((items) => items.includes(sheet.name) ? items.filter((name) => name !== sheet.name) : [...items, sheet.name])} /><span className="min-w-0 flex-1 truncate">{sheet.name}</span><span className="text-meta text-ink-3">{sheet.visible === 'Visible' ? t('可见', 'Visible') : t('隐藏', 'Hidden')}{t(` · ${formatNumber(sheet.rowCount)} 行`, ` · ${formatNumber(sheet.rowCount)} rows`)}</span></label>)}</div>
    <Button variant="primary" disabled={!selected.length || busy || !availableWorkbooks.some((item) => item.id === id) ||
      !selected.every((name) => sheets.data?.some((sheet) => sheet.name === name))} onClick={() => void submit()}>{t(`将选中的 ${selected.length} 张表生成独立数据集`, `Create separate datasets from ${selected.length} selected sheets`)}</Button>
    {results.length ? <div className="space-y-1">{results.map((item) => <p key={item.name} className="text-cell">{item.name}{t('：', ': ')}{item.jobId ? <Link to="/jobs/$jobId" params={{ jobId: item.jobId }} className="text-accent-ink hover:underline">{t('查看任务', 'View job')}</Link> : <span className="text-danger">{item.error}</span>}</p>)}</div> : null}
  </Panel>
}
