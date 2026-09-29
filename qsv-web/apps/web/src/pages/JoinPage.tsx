import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type RelationConfig, type SetConfig } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { getLocale, useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'
import { useDatasetSearch } from '@/ui/useDatasetSearch'

export function JoinPage() {
  const t = useT()
  const navigate = useNavigate()
  const { sourceId: requestedSourceId } = useSearch({ from: '/join' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['join', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('join')
  const [sourceIds, setSourceIds] = useSessionDraft<string[]>('JoinPage.sourceIds', [])
  const lookupIds = [...new Set([requestedSourceId, ...sourceIds].filter((id): id is string => Boolean(id)))].slice(0, 21)
  const lookedUp = useQueries({ queries: lookupIds.map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), ...lookedUp.flatMap((item) => item.data ? [item.data] : [])]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready').map((item) => [item.id, item] as const)).values()]
  const defaultDatasetIds = resources.data?.items.filter((item) => item.kind === 'dataset' && item.status === 'ready').slice(0, 2).map((item) => item.id) ?? []
  useEffect(() => { if (requestedSourceId) setSourceIds([requestedSourceId]) }, [requestedSourceId, setSourceIds])
  const selectedSchemas = useQueries({ queries: sourceIds.map((id) => ({ queryKey: ['schema', id], queryFn: () => api.schema(id) })) })
  const structures = selectedSchemas.map((item) => item.data?.columns ?? [])
  const fieldNames = [...new Set(structures.flatMap((columns) => columns.map((column) => column.name)))]
  const fieldConflicts = fieldNames.filter((name) => new Set(structures.flatMap((columns) => columns.filter((column) => column.name === name)
    .map((column) => column.type))).size > 1)
  const unionMissingCells = sourceIds.reduce((sum, id, index) => sum + (datasets.find((item) => item.id === id)?.rowCount ?? 0) *
    fieldNames.filter((name) => !structures[index]?.some((column) => column.name === name)).length, 0)
  const longestInput = Math.max(0, ...sourceIds.map((id) => datasets.find((item) => item.id === id)?.rowCount ?? 0))
  const horizontalPadCells = sourceIds.reduce((sum, id, index) => sum +
    (longestInput - (datasets.find((item) => item.id === id)?.rowCount ?? 0)) * (structures[index]?.length ?? 0), 0)
  const [mode, setMode] = useSessionDraft<'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error'>('JoinPage.mode', 'strict')
  const [key, setKey] = useState(() => `combine_${crypto.randomUUID()}`)
  const submit = useMutation({ mutationFn: () => api.combine(sourceIds, mode, key), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const toggle = (id: string) => { setSourceIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]); setKey(`combine_${crypto.randomUUID()}`) }
  return <><PageTopBar title={t('合并、关联与集合', 'Combine, join and set operations')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    <DraftInputWarning ids={sourceIds} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || lookedUp.some((item) => item.isLoading)} />
    <Banner tone="info">{t('纵向合并按选择顺序追加记录；横向拼接按原始行位置并列字段。两种方式都会生成新数据集，原文件不改动。', 'Vertical combination appends records in selection order; horizontal combination places fields side by side by original row position. Both create a new dataset and leave source files unchanged.')}</Banner>
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('纵向合并或横向拼接', 'Combine vertically or horizontally')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length < 2 ? <p className="text-cell text-ink-3">{t('至少需要两个可用数据集。', 'At least two available datasets are required.')}</p> : null}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit.mutate() }}>
        <div className="space-y-2"><p className="text-meta text-ink-3">{t('选择 2 至 20 个数据集，选择顺序即输出记录顺序', 'Select 2 to 20 datasets; selection order determines output row order')}</p><div className="max-h-72 space-y-1 overflow-y-auto rounded-control border border-hairline p-2">{datasets.map((item) => <label key={item.id} className="flex items-center gap-2 rounded-control px-2 py-1 text-cell text-ink-2 hover:bg-surface-hover"><input type="checkbox" checked={sourceIds.includes(item.id)} disabled={!sourceIds.includes(item.id) && sourceIds.length >= 20} onChange={() => toggle(item.id)} /><span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span><span className="figure text-meta">{t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</span>{sourceIds.includes(item.id) ? <span className="figure text-meta text-accent-ink">{sourceIds.indexOf(item.id) + 1}</span> : null}</label>)}</div></div>
        <label className="block space-y-1 text-meta text-ink-3">{t('处理方式', 'Method')}<select value={mode} onChange={(event) => { setMode(event.target.value as typeof mode); setKey(`combine_${crypto.randomUUID()}`) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="strict">{t('纵向：严格同结构', 'Vertical: identical structure')}</option><option value="union">{t('纵向：字段并集，缺列补空', 'Vertical: union of fields; fill missing columns')}</option><option value="intersection">{t('纵向：只保留共同字段', 'Vertical: shared fields only')}</option><option value="horizontal-error">{t('横向：行数必须相同', 'Horizontal: equal row counts required')}</option><option value="horizontal-pad">{t('横向：短表尾部补空', 'Horizontal: pad shorter datasets')}</option></select></label>
        {mode !== 'strict' ? <p className="text-meta text-ink-3">{t('每份输入的字段名需要非空且不重复。纵向并集以首次出现的顺序排列；交集按第一份输入的字段顺序排列。横向拼接按每份数据的原始行顺序，重名字段自动加数字后缀。', 'Field names in each input must be nonempty and unique. Vertical union follows first occurrence; intersection follows the first input. Horizontal combination follows original row order and adds numeric suffixes to duplicate field names.')}</p> : null}
        {mode === 'union' && !selectedSchemas.some((item) => item.isLoading || item.error) ? <p className="text-meta text-ink-3">{t(`并集会为缺少的列补空，并保存“缺字段”来源。预计 ${formatNumber(unionMissingCells)} 处；上限 1000 万处，超出时需先筛选输入或改用共同字段。`, `Union fills missing columns with empty text and records missing-field origins. Expected: ${formatNumber(unionMissingCells)} cells. The limit is 10 million; filter inputs or use common fields if exceeded.`)}</p> : null}
        {mode === 'horizontal-pad' && !selectedSchemas.some((item) => item.isLoading || item.error) ? <p className="text-meta text-ink-3">{t(`短表尾部会补空，并把补出的单元格记为“缺字段”。预计 ${formatNumber(horizontalPadCells)} 处；上限 1000 万处。`, `Shorter datasets are padded with empty cells marked as missing fields. Expected: ${formatNumber(horizontalPadCells)} cells; limit: 10 million.`)}</p> : null}
        <p className="text-cell text-ink-2">{t(`已选 ${sourceIds.length} 份；预计 ${formatNumber(mode.startsWith('horizontal') ? Math.max(0, ...datasets.filter((item) => sourceIds.includes(item.id)).map((item) => item.rowCount ?? 0)) : datasets.filter((item) => sourceIds.includes(item.id)).reduce((sum, item) => sum + (item.rowCount ?? 0), 0))} 行。`, `${sourceIds.length} selected; estimated ${formatNumber(mode.startsWith('horizontal') ? Math.max(0, ...datasets.filter((item) => sourceIds.includes(item.id)).map((item) => item.rowCount ?? 0)) : datasets.filter((item) => sourceIds.includes(item.id)).reduce((sum, item) => sum + (item.rowCount ?? 0), 0))} rows.`)}</p>
        {sourceIds.length >= 2 && !mode.startsWith('horizontal') ? <div className="space-y-2 rounded-control bg-surface-sunk p-3 text-meta text-ink-2"><strong className="text-cell">{t('字段结构预览', 'Field structure preview')}</strong>{selectedSchemas.some((item) => item.isLoading) ? <p>{t('正在读取所选数据集的字段…', 'Loading fields from selected datasets…')}</p> : selectedSchemas.some((item) => item.error) ? <p>{t('字段读取失败，请重新选择输入。', 'Could not load fields. Reselect the inputs.')}</p> : <>{sourceIds.map((id, index) => {
          const missing = fieldNames.filter((name) => !structures[index]!.some((column) => column.name === name))
          return <p key={id}>{datasets.find((item) => item.id === id)?.name}{t('：', ': ')}{missing.length ? t(`缺少 ${missing.length} 个并集字段（${missing.slice(0, 12).join('、')}${missing.length > 12 ? '等' : ''}）`, `Missing ${missing.length} union fields (${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', etc.' : ''})`) : t('包含全部并集字段', 'Contains all union fields')}</p>
        })}<p>{t(`共同字段 ${fieldNames.filter((name) => structures.every((columns) => columns.some((column) => column.name === name))).length} 个；类型冲突 ${fieldConflicts.length ? fieldConflicts.join('、') : '无'}。`, `${fieldNames.filter((name) => structures.every((columns) => columns.some((column) => column.name === name))).length} shared fields; type conflicts: ${fieldConflicts.length ? fieldConflicts.join(', ') : 'none'}.`)}</p><p>{t('当前导入的数据集字段以文本保存；类型冲突只按已登记的字段类型提示。', 'Imported dataset fields are stored as text. Type conflicts reflect only the registered field types.')}</p></>}</div> : null}
        {submit.error ? <Banner tone="danger" title={t('合并未提交', 'Combination was not submitted')}>{submit.error.message}</Banner> : null}
        <Button type="submit" variant="primary" disabled={sourceIds.length < 2 || mode === 'union' && unionMissingCells > 10_000_000 || mode === 'horizontal-pad' && horizontalPadCells > 10_000_000 || submit.isPending}>{mode.startsWith('horizontal') ? t('横向拼接全部记录', 'Combine all rows horizontally') : t('纵向合并全部记录', 'Combine all rows vertically')}</Button>
      </form>
    </Panel>
    <RelationPanel datasets={datasets} defaultDatasetIds={defaultDatasetIds} loading={resources.isLoading || lookedUp.some((item) => item.isLoading)} requestedSourceId={requestedSourceId} />
    <SetPanel datasets={datasets} defaultDatasetIds={defaultDatasetIds} loading={resources.isLoading || lookedUp.some((item) => item.isLoading)} requestedSourceId={requestedSourceId} />
  </PageBody></>
}

function SetPanel({ datasets: listedDatasets, defaultDatasetIds, loading, requestedSourceId }: { datasets: { id: string; name: string; rowCount: number | null }[];
  defaultDatasetIds: string[];
  loading: boolean; requestedSourceId?: string }) {
  const t = useT()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [leftId, setLeftId] = useSessionDraft('SetPanel.leftId', '')
  useEffect(() => { if (requestedSourceId) setLeftId(requestedSourceId) }, [requestedSourceId, setLeftId])
  const [rightId, setRightId] = useSessionDraft('SetPanel.rightId', '')
  const lookedUp = useQueries({ queries: [...new Set([leftId, rightId].filter(Boolean))].map((id) => ({
    queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const datasets = [...new Map([...listedDatasets, ...lookedUp.flatMap((item) => item.data?.kind === 'dataset' && item.data.status === 'ready'
    ? [item.data] : [])].map((item) => [item.id, item] as const)).values()]
  const [leftKeyId, setLeftKeyId] = useSessionDraft('SetPanel.leftKeyId', 'c_0')
  const [rightKeyId, setRightKeyId] = useSessionDraft('SetPanel.rightKeyId', 'c_0')
  const [kind, setKind] = useSessionDraft<SetConfig['kind']>('SetPanel.kind', 'intersection')
  const [key, setKey] = useState(() => `set_${crypto.randomUUID()}`)
  const left = leftId || defaultDatasetIds[0] || datasets[0]?.id || ''
  const right = rightId || defaultDatasetIds.find((id) => id !== left) || datasets.find((item) => item.id !== left)?.id || ''
  const leftSchema = useQuery({ queryKey: ['schema', left], queryFn: () => api.schema(left), enabled: Boolean(left) })
  const rightSchema = useQuery({ queryKey: ['schema', right], queryFn: () => api.schema(right), enabled: Boolean(right) })
  const config: SetConfig = { kind, leftKeyIds: [leftKeyId], rightKeyIds: [rightKeyId] }
  const submit = useMutation({ mutationFn: () => api.combine([left, right], 'set', key, undefined, config), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const changed = () => setKey(`set_${crypto.randomUUID()}`)
  const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
  const identicalHeaders = JSON.stringify(leftSchema.data?.columns.map((column) => column.name)) ===
    JSON.stringify(rightSchema.data?.columns.map((column) => column.name))
  return <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('两份数据的集合运算', 'Set operations on two datasets')} />
    <DraftInputWarning ids={[leftId, rightId]} availableIds={datasets.map((item) => item.id)} loading={loading || lookedUp.some((item) => item.isLoading)} />
    <p className="text-meta text-ink-3">{t('按选定字段比较完整文本。每个键最多保留对应数据集的首条记录，空值也作为一个键。去重并集要求两侧字段名和顺序完全相同。', 'Compare complete text in the selected fields. Each key keeps at most the first row from its dataset; empty text is also a key. Deduplicated union requires identical field names and order on both sides.')}</p>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('左侧数据集', 'Left dataset')}<select value={left} onChange={(event) => { setLeftId(event.target.value); setLeftKeyId('c_0'); changed() }} className={selectClass}>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('右侧数据集', 'Right dataset')}<select value={right} onChange={(event) => { setRightId(event.target.value); setRightKeyId('c_0'); changed() }} className={selectClass}>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    {leftSchema.error || rightSchema.error ? <Banner tone="danger">{(leftSchema.error ?? rightSchema.error)?.message}</Banner> : null}
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('左侧比较字段', 'Left comparison field')}<select value={leftKeyId} onChange={(event) => { setLeftKeyId(event.target.value); changed() }} className={selectClass}>{leftSchema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('右侧比较字段', 'Right comparison field')}<select value={rightKeyId} onChange={(event) => { setRightKeyId(event.target.value); changed() }} className={selectClass}>{rightSchema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label></div>
    <label className="block space-y-1 text-meta text-ink-3">{t('运算方式', 'Operation')}<select value={kind} onChange={(event) => { setKind(event.target.value as SetConfig['kind']); changed() }} className={selectClass}><option value="intersection">{t('交集：左侧中也出现在右侧的键', 'Intersection: left keys also on the right')}</option><option value="left-difference">{t('左差集：只在左侧的键', 'Left difference: left-only keys')}</option><option value="right-difference">{t('右差集：只在右侧的键', 'Right difference: right-only keys')}</option><option value="union">{t('去重并集：先左侧，再补右侧独有键', 'Deduplicated union: left first, then unique right keys')}</option></select></label>
    {submit.error ? <Banner tone="danger" title={t('集合运算未提交', 'Set operation was not submitted')}>{submit.error.message}</Banner> : null}
    <Button variant="primary" disabled={!left || !right || left === right || !leftSchema.data || !rightSchema.data || (kind === 'union' && !identicalHeaders) || submit.isPending} onClick={() => submit.mutate()}>{t('处理全部记录', 'Process all records')}</Button>
  </Panel>
}

function RelationPanel({ datasets: listedDatasets, defaultDatasetIds, loading, requestedSourceId }: { datasets: { id: string; name: string; rowCount: number | null }[];
  defaultDatasetIds: string[];
  loading: boolean; requestedSourceId?: string }) {
  const t = useT()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [leftId, setLeftId] = useSessionDraft('RelationPanel.leftId', '')
  useEffect(() => { if (requestedSourceId) setLeftId(requestedSourceId) }, [requestedSourceId, setLeftId])
  const [rightId, setRightId] = useSessionDraft('RelationPanel.rightId', '')
  const lookedUp = useQueries({ queries: [...new Set([leftId, rightId].filter(Boolean))].map((id) => ({
    queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const datasets = [...new Map([...listedDatasets, ...lookedUp.flatMap((item) => item.data?.kind === 'dataset' && item.data.status === 'ready'
    ? [item.data] : [])].map((item) => [item.id, item] as const)).values()]
  const [pairs, setPairs] = useSessionDraft('RelationPanel.pairs', [{ left: 'c_0', right: 'c_0' }])
  const [kind, setKind] = useSessionDraft<RelationConfig['kind']>('RelationPanel.kind', 'inner')
  const [cardinality, setCardinality] = useSessionDraft<RelationConfig['cardinality']>('RelationPanel.cardinality', 'one-to-one')
  const [keyType, setKeyType] = useSessionDraft<NonNullable<RelationConfig['keyType']>>('RelationPanel.keyType', 'text')
  const [matchEmptyKeys, setMatchEmptyKeys] = useSessionDraft('RelationPanel.matchEmptyKeys', false)
  const [trimKeys, setTrimKeys] = useSessionDraft('RelationPanel.trimKeys', false)
  const [ignoreCase, setIgnoreCase] = useSessionDraft('RelationPanel.ignoreCase', false)
  const [unicodeNormalization, setUnicodeNormalization] = useSessionDraft<NonNullable<RelationConfig['unicodeNormalization']>>('RelationPanel.unicodeNormalization', 'none')
  const [outputColumns, setOutputColumns] = useSessionDraft<{ side: 'left' | 'right'; id: string }[] | null>('RelationPanel.outputColumns', null)
  const [leftSuffix, setLeftSuffix] = useSessionDraft('RelationPanel.leftSuffix', getLocale() === 'en-US' ? '_left' : '_左')
  const [rightSuffix, setRightSuffix] = useSessionDraft('RelationPanel.rightSuffix', getLocale() === 'en-US' ? '_right' : '_右')
  const [includeSourceRows, setIncludeSourceRows] = useSessionDraft('RelationPanel.includeSourceRows', true)
  const [key, setKey] = useState(() => `relation_${crypto.randomUUID()}`)
  const [checkedKey, setCheckedKey] = useState('')
  const left = leftId || defaultDatasetIds[0] || datasets[0]?.id || ''
  const right = rightId || defaultDatasetIds.find((id) => id !== left) || datasets.find((item) => item.id !== left)?.id || ''
  const leftSchema = useQuery({ queryKey: ['schema', left], queryFn: () => api.schema(left), enabled: Boolean(left) })
  const rightSchema = useQuery({ queryKey: ['schema', right], queryFn: () => api.schema(right), enabled: Boolean(right) })
  const availableColumns = [
    ...(leftSchema.data?.columns.map((column) => ({ side: 'left' as const, id: column.id, name: column.name })) ?? []),
    ...(rightSchema.data?.columns.map((column) => ({ side: 'right' as const, id: column.id, name: column.name })) ?? []),
  ]
  const output = (outputColumns ?? availableColumns.map(({ side, id }) => ({ side, id }))).filter((entry) =>
    (kind !== 'left-semi' && kind !== 'left-anti' || entry.side === 'left') &&
    availableColumns.some((column) => column.side === entry.side && column.id === entry.id))
  const config: RelationConfig = { kind, cardinality, leftKeyIds: pairs.map((pair) => pair.left), rightKeyIds: pairs.map((pair) => pair.right),
    keyType, matchEmptyKeys, trimKeys, ignoreCase: keyType === 'text' && ignoreCase, unicodeNormalization: keyType === 'text' ? unicodeNormalization : 'none',
    output: { columns: output, leftSuffix, rightSuffix, includeSourceRows } }
  const preflight = useMutation({ mutationFn: (request: { ids: string[]; config: RelationConfig; key: string }) => api.relationPreflight(request.ids, request.config),
    onSuccess: (_result, request) => setCheckedKey(request.key) })
  const submit = useMutation({ mutationFn: () => api.combine([left, right], 'relation', key, config), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
  const changed = () => setKey(`relation_${crypto.randomUUID()}`)
  const updatePair = (index: number, field: 'left' | 'right', value: string) => {
    setPairs((items) => items.map((item, at) => at === index ? { ...item, [field]: value } : item)); changed()
  }
  return <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('按匹配键关联两份数据', 'Join two datasets by key')} /><p className="text-meta text-ink-3">{t('匹配键默认按文本比较，也可选择十进制数值口径；无法解析的非空数字键会使预检失败。默认不匹配空键。运行前会检查全部键的基数并估算输出行数；只有明确选中多对多时才允许重复键展开。', 'Keys compare as text by default or as decimal values. An unparseable nonempty decimal key fails preflight. Empty keys do not match by default. Preflight checks all key counts and estimates output rows. Duplicate expansion requires an explicit many-to-many selection.')}</p>
    <DraftInputWarning ids={[leftId, rightId]} availableIds={datasets.map((item) => item.id)} loading={loading || lookedUp.some((item) => item.isLoading)} />
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('左侧数据集', 'Left dataset')}<select value={left} onChange={(event) => { setLeftId(event.target.value); setPairs([{ left: 'c_0', right: 'c_0' }]); setOutputColumns(null); changed() }} className={selectClass}>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('右侧数据集', 'Right dataset')}<select value={right} onChange={(event) => { setRightId(event.target.value); setPairs([{ left: 'c_0', right: 'c_0' }]); setOutputColumns(null); changed() }} className={selectClass}>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
    {leftSchema.error || rightSchema.error ? <Banner tone="danger">{(leftSchema.error ?? rightSchema.error)?.message}</Banner> : null}
    <div className="space-y-2"><strong className="text-cell text-ink">{t('匹配键', 'Matching keys')}</strong>{pairs.map((pair, index) => <div key={index} className="flex flex-wrap items-end gap-2"><label className="min-w-40 flex-1 space-y-1 text-meta text-ink-3">{t('左侧字段', 'Left field')}<select value={pair.left} onChange={(event) => updatePair(index, 'left', event.target.value)} className={selectClass}>{leftSchema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="min-w-40 flex-1 space-y-1 text-meta text-ink-3">{t('右侧字段', 'Right field')}<select value={pair.right} onChange={(event) => updatePair(index, 'right', event.target.value)} className={selectClass}>{rightSchema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><Button size="sm" variant="quiet" disabled={pairs.length === 1} onClick={() => { setPairs((items) => items.filter((_, at) => at !== index)); changed() }}>{t('移除', 'Remove')}</Button></div>)}<Button size="sm" disabled={pairs.length >= 4} onClick={() => { const nextLeft = leftSchema.data?.columns.find((column) => !pairs.some((pair) => pair.left === column.id)); const nextRight = rightSchema.data?.columns.find((column) => !pairs.some((pair) => pair.right === column.id)); if (nextLeft && nextRight) setPairs((items) => [...items, { left: nextLeft.id, right: nextRight.id }]); changed() }}>{t('添加匹配字段', 'Add matching field')}</Button></div>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('保留记录', 'Rows to retain')}<select value={kind} onChange={(event) => { setKind(event.target.value as RelationConfig['kind']); changed() }} className={selectClass}><option value="inner">{t('内关联：仅保留两侧匹配记录', 'Inner join: matching rows only')}</option><option value="left">{t('左关联：保留所有左侧记录', 'Left join: all left rows')}</option><option value="right">{t('右关联：保留所有右侧记录', 'Right join: all right rows')}</option><option value="full">{t('全关联：保留两侧所有记录', 'Full join: all rows from both sides')}</option><option value="left-semi">{t('半关联：仅保留匹配到的左侧记录', 'Semi join: matched left rows only')}</option><option value="left-anti">{t('反关联：仅保留未匹配的左侧记录', 'Anti join: unmatched left rows only')}</option></select></label><label className="space-y-1 text-meta text-ink-3">{t('匹配关系', 'Cardinality')}<select value={cardinality} onChange={(event) => { setCardinality(event.target.value as RelationConfig['cardinality']); changed() }} className={selectClass}><option value="one-to-one">{t('一对一：两侧键均唯一', 'One to one: unique keys on both sides')}</option><option value="one-to-many">{t('一对多：左侧键唯一', 'One to many: unique left keys')}</option><option value="many-to-one">{t('多对一：右侧键唯一', 'Many to one: unique right keys')}</option><option value="many-to-many">{t('多对多：允许重复展开', 'Many to many: expand duplicates')}</option></select></label></div>
    <div className="flex flex-wrap items-end gap-3"><label className="text-meta text-ink-3">{t('匹配键类型', 'Key type')}<select value={keyType} onChange={(event) => { setKeyType(event.target.value as NonNullable<RelationConfig['keyType']>); changed() }} className={selectClass}><option value="text">{t('文本：按字面值', 'Text: literal values')}</option><option value="decimal">{t('十进制：01.0 与 1 视为相同', 'Decimal: 01.0 and 1 are equal')}</option></select></label><label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={trimKeys} onChange={(event) => { setTrimKeys(event.target.checked); changed() }} />{t('去除匹配键首尾空白', 'Trim leading and trailing whitespace in keys')}</label><label className="flex items-center gap-2 text-cell"><input type="checkbox" disabled={keyType === 'decimal'} checked={keyType === 'text' && ignoreCase} onChange={(event) => { setIgnoreCase(event.target.checked); changed() }} />{t('匹配键忽略大小写', 'Ignore case in keys')}</label><label className="text-meta text-ink-3">{t('Unicode 规范化', 'Unicode normalization')}<select value={keyType === 'decimal' ? 'none' : unicodeNormalization} disabled={keyType === 'decimal'} onChange={(event) => { setUnicodeNormalization(event.target.value as NonNullable<RelationConfig['unicodeNormalization']>); changed() }} className={selectClass}><option value="none">{t('不规范化', 'No normalization')}</option><option value="nfc">NFC</option><option value="nfkc">NFKC</option></select></label></div>
    <label className="flex items-start gap-2 text-cell"><input type="checkbox" checked={matchEmptyKeys} onChange={(event) => { setMatchEmptyKeys(event.target.checked); changed() }} /><span>{t('让空键也参与匹配。两侧空键较多时可能形成大量组合；请查看下方全量预检的预计结果行数。', 'Match empty keys too. Many empty keys on both sides can produce many combinations; check the expected row count below.')}</span></label>
    <div className="space-y-3 rounded-control border border-line p-3"><strong className="text-cell">{t('输出字段与顺序', 'Output fields and order')}</strong><p className="text-meta text-ink-3">{t('勾选两侧匹配键会同时保留两侧键；取消某个字段不会改变匹配条件。上下移动决定最终列顺序。', 'Selecting both matching keys retains both columns. Deselecting a field does not change the matching rule. Move fields to set final column order.')}</p>
      <div className="grid gap-2 sm:grid-cols-2">{availableColumns.filter((column) => kind !== 'left-semi' && kind !== 'left-anti' || column.side === 'left').map((column) => {
        const selected = output.some((entry) => entry.side === column.side && entry.id === column.id)
        return <label key={`${column.side}:${column.id}`} className="flex items-center gap-2 text-cell"><input type="checkbox" checked={selected} onChange={() => { const base = outputColumns ?? availableColumns.map(({ side, id }) => ({ side, id })); setOutputColumns(selected ? base.filter((entry) => entry.side !== column.side || entry.id !== column.id) : [...base, { side: column.side, id: column.id }]); changed() }} />{column.side === 'left' ? t('左', 'Left') : t('右', 'Right')} · {column.name}</label>
      })}</div>
      <div className="max-h-52 space-y-1 overflow-auto">{output.map((entry, index) => <div key={`${entry.side}:${entry.id}`} className="flex items-center gap-2 text-cell"><span className="min-w-0 flex-1 truncate">{index + 1}. {entry.side === 'left' ? t('左', 'Left') : t('右', 'Right')} · {availableColumns.find((column) => column.side === entry.side && column.id === entry.id)?.name}</span><Button size="sm" variant="quiet" disabled={index === 0} onClick={() => { const next = [...output]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setOutputColumns(next); changed() }}>{t('上移', 'Move up')}</Button><Button size="sm" variant="quiet" disabled={index === output.length - 1} onClick={() => { const next = [...output]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; setOutputColumns(next); changed() }}>{t('下移', 'Move down')}</Button></div>)}</div>
      <div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('左侧同名字段后缀', 'Left duplicate-name suffix')}<input value={leftSuffix} maxLength={32} onChange={(event) => { setLeftSuffix(event.target.value); changed() }} className={selectClass} /></label><label className="text-meta">{t('右侧同名字段后缀', 'Right duplicate-name suffix')}<input value={rightSuffix} maxLength={32} onChange={(event) => { setRightSuffix(event.target.value); changed() }} className={selectClass} /></label></div>
      <label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={includeSourceRows} onChange={(event) => { setIncludeSourceRows(event.target.checked); changed() }} />{t('在输出末尾加入来源行号', 'Append source row numbers')}</label>
      {!output.length ? <Banner tone="warning">{t('请至少保留一个输出字段。', 'Keep at least one output field.')}</Banner> : null}
    </div>
    {preflight.error ? <Banner tone="danger" title={t('全量预检未通过', 'Full preflight failed')}>{preflight.error.message}</Banner> : null}
    {checkedKey === key && preflight.data ? <div className="rounded-control bg-surface-sunk p-3 text-cell text-ink-2">{t(`全量键检查：预计输出 ${formatNumber(preflight.data.expectedRows)} 行，匹配组合 ${formatNumber(preflight.data.matchedPairs)} 对，左侧未匹配 ${formatNumber(preflight.data.unmatchedLeft)} 行，右侧未匹配 ${formatNumber(preflight.data.unmatchedRight)} 行。`, `Full key check: expected ${formatNumber(preflight.data.expectedRows)} output rows, ${formatNumber(preflight.data.matchedPairs)} matched pairs, ${formatNumber(preflight.data.unmatchedLeft)} unmatched left rows and ${formatNumber(preflight.data.unmatchedRight)} unmatched right rows.`)}</div> : null}
    {checkedKey === key && preflight.data?.sampleWarning ? <Banner tone="warning">{t('样本无法显示：', 'Sample unavailable: ')}{getLocale() === 'en-US' ? 'The selected data or rule could not produce a sample' : preflight.data.sampleWarning}{t('。全量键检查结果仍可用于提交。', '. Full key check results remain valid for submission.')}</Banner> : null}
    {checkedKey === key && preflight.data?.sample ? <div className="space-y-2"><p className="text-meta text-ink-3">{t('结果样本：', 'Result sample: ')}{t(preflight.data.sample.scope, 'First 20 rows from each input; only joins formed within the sample are shown')}{t('。样本行数与完整任务结果可能不同。', '. Sample row counts may differ from the complete job.')}</p><div className="overflow-x-auto"><table className="w-full text-left text-cell"><thead><tr>{preflight.data.sample.headers.map((name, index) => <th key={index} className="px-2 py-1">{name}</th>)}</tr></thead><tbody>{preflight.data.sample.rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column} className="max-w-64 truncate px-2 py-1">{value}</td>)}</tr>)}</tbody></table></div>{preflight.data.sample.columnsTruncated ? <p className="text-meta text-ink-3">{t('仅显示前 30 列。', 'Only the first 30 columns are shown.')}</p> : null}</div> : null}
    {submit.error ? <Banner tone="danger" title={t('关联未提交', 'Join was not submitted')}>{submit.error.message}</Banner> : null}
    <div className="flex flex-wrap gap-2"><Button disabled={!left || !right || left === right || !leftSchema.data || !rightSchema.data || !output.length || preflight.isPending} onClick={() => preflight.mutate({ ids: [left, right], config, key })}>{t('检查全部键与预计行数', 'Check all keys and expected rows')}</Button><Button variant="primary" disabled={checkedKey !== key || !preflight.data || submit.isPending} onClick={() => submit.mutate()}>{t('关联全部记录', 'Join all records')}</Button></div>
  </Panel>
}
