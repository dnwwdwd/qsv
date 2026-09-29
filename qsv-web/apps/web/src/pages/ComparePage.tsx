import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CompareConfig, type CompareField } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { getLocale, useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'
import { localizedStage } from '@/lib/stage'
import { localizedErrorMessage } from '@/lib/errors'
import { useDatasetSearch } from '@/ui/useDatasetSearch'

const newField = (): CompareField => ({ leftColumnId: 'c_1', rightColumnId: 'c_1', mode: 'text', tolerance: '0' })
const validTimeZone = (value?: string) => {
  if (!value) return true
  if (value.length > 64 || !/^(?:UTC|[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+)$/u.test(value)) return false
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); return true } catch { return false }
}

export function ComparePage() {
  const t = useT()
  const navigate = useNavigate()
  const { leftId: requestedLeftId, rightId: requestedRightId, copyResultId } = useSearch({ from: '/compare' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['compare', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('compare')
  const [leftId, setLeftId] = useSessionDraft('ComparePage.leftId', '')
  const [rightId, setRightId] = useSessionDraft('ComparePage.rightId', '')
  const lookupLeft = leftId || requestedLeftId, lookupRight = rightId || requestedRightId
  const requestedLeft = useQuery({ queryKey: ['resource', lookupLeft], queryFn: () => api.resource(lookupLeft), enabled: Boolean(lookupLeft) })
  const requestedRight = useQuery({ queryKey: ['resource', lookupRight], queryFn: () => api.resource(lookupRight), enabled: Boolean(lookupRight) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), requestedLeft.data, requestedRight.data]
    .filter((item) => item?.kind === 'dataset' && item.status === 'ready' && !item.metadata.compareSummary)
    .map((item) => [item!.id, item!] as const)).values()]
  useEffect(() => {
    if (requestedLeftId) setLeftId(requestedLeftId)
    if (requestedRightId) setRightId(requestedRightId)
  }, [requestedLeftId, requestedRightId, setLeftId, setRightId])
  const defaultDatasets = resources.data?.items.filter((item) => item.kind === 'dataset' && item.status === 'ready' && !item.metadata.compareSummary) ?? []
  const selectedLeft = leftId || requestedLeftId || defaultDatasets[0]?.id || datasets[0]?.id || ''
  const selectedRight = rightId || requestedRightId || defaultDatasets.find((item) => item.id !== selectedLeft)?.id || datasets.find((item) => item.id !== selectedLeft)?.id || ''
  const leftSchema = useQuery({ queryKey: ['schema', selectedLeft], queryFn: () => api.schema(selectedLeft), enabled: Boolean(selectedLeft) })
  const rightSchema = useQuery({ queryKey: ['schema', selectedRight], queryFn: () => api.schema(selectedRight), enabled: Boolean(selectedRight) })
  const savedRecipes = useQuery({ queryKey: ['compare', 'saved-recipes'], queryFn: api.recipes })
  const [showSamples, setShowSamples] = useState(false)
  const leftSample = useQuery({ queryKey: ['compare', 'sample', selectedLeft], queryFn: async () => {
    const view = await api.createView(selectedLeft)
    return api.rows(view.id, 0, 20)
  }, enabled: showSamples && Boolean(selectedLeft) })
  const rightSample = useQuery({ queryKey: ['compare', 'sample', selectedRight], queryFn: async () => {
    const view = await api.createView(selectedRight)
    return api.rows(view.id, 0, 20)
  }, enabled: showSamples && Boolean(selectedRight) })
  const [keys, setKeys] = useSessionDraft<{ left: string; right: string }[]>('ComparePage.keys', [{ left: 'c_0', right: 'c_0' }])
  const [fields, setFields] = useSessionDraft<CompareField[]>('ComparePage.fields', [newField()])
  const [trimKeys, setTrimKeys] = useSessionDraft('ComparePage.trimKeys', false)
  const [ignoreKeyCase, setIgnoreKeyCase] = useSessionDraft('ComparePage.ignoreKeyCase', false)
  const [leftLabel, setLeftLabel] = useSessionDraft('ComparePage.leftLabel', getLocale() === 'en-US' ? 'Left data' : '左侧数据')
  const [rightLabel, setRightLabel] = useSessionDraft('ComparePage.rightLabel', getLocale() === 'en-US' ? 'Right data' : '右侧数据')
  const [duplicatePolicy, setDuplicatePolicy] = useSessionDraft<'isolate' | 'abort' | 'aggregate'>('ComparePage.duplicatePolicy', 'isolate')
  const [emptyValuePolicy, setEmptyValuePolicy] = useSessionDraft<'mode-default' | 'match-both' | 'error'>('ComparePage.emptyValuePolicy', 'mode-default')
  const [parseFailurePolicy, setParseFailurePolicy] = useSessionDraft<'isolate' | 'abort'>('ComparePage.parseFailurePolicy', 'isolate')
  const [contextLeftIds, setContextLeftIds] = useSessionDraft<string[]>('ComparePage.contextLeftIds', [])
  const [contextRightIds, setContextRightIds] = useSessionDraft<string[]>('ComparePage.contextRightIds', [])
  const [aggregateMethods, setAggregateMethods] = useSessionDraft<('sum' | 'count')[]>('ComparePage.aggregateMethods', ['sum'])
  const [preflightJobId, setPreflightJobId] = useState('')
  const [key, setKey] = useState(() => `compare_${crypto.randomUUID()}`)
  const [copiedFromResultId, setCopiedFromResultId] = useSessionDraft('ComparePage.copiedFromResultId', '')
  const copiedResult = useQuery({ queryKey: ['resource', copyResultId], queryFn: () => api.resource(copyResultId!), enabled: Boolean(copyResultId), retry: false })
  const savedConfig = (copiedResult.data?.metadata.compare as { config?: CompareConfig } | undefined)?.config
  const copySourceValid = copiedResult.data?.status === 'ready' && Boolean(copiedResult.data.metadata.compareSummary) &&
    copiedResult.data.sourceIds.length === 2 && savedConfig !== undefined && Array.isArray(savedConfig.leftKeyIds) && Array.isArray(savedConfig.rightKeyIds) &&
    savedConfig.leftKeyIds.length > 0 && savedConfig.leftKeyIds.length === savedConfig.rightKeyIds.length &&
    Array.isArray(savedConfig.fields) && savedConfig.fields.length > 0
  useEffect(() => {
    if (!copyResultId) { setCopiedFromResultId(''); return }
    if (!copySourceValid || !savedConfig || !copiedResult.data || copiedFromResultId === copyResultId) return
    setLeftId(copiedResult.data.sourceIds[0]!)
    setRightId(copiedResult.data.sourceIds[1]!)
    setKeys(savedConfig.leftKeyIds.map((left, index) => ({ left, right: savedConfig.rightKeyIds[index]! })))
    setFields(savedConfig.fields.map((field) => ({ ...field })))
    setTrimKeys(Boolean(savedConfig.trimKeys))
    setIgnoreKeyCase(Boolean(savedConfig.ignoreKeyCase))
    setLeftLabel(savedConfig.leftLabel ?? (getLocale() === 'en-US' ? 'Left data' : '左侧数据'))
    setRightLabel(savedConfig.rightLabel ?? (getLocale() === 'en-US' ? 'Right data' : '右侧数据'))
    setDuplicatePolicy(savedConfig.duplicatePolicy ?? 'isolate')
    setEmptyValuePolicy(savedConfig.emptyValuePolicy ?? 'mode-default')
    setParseFailurePolicy(savedConfig.parseFailurePolicy ?? 'isolate')
    setContextLeftIds(savedConfig.contextLeftIds ?? [])
    setContextRightIds(savedConfig.contextRightIds ?? [])
    setAggregateMethods(savedConfig.aggregateMethods?.length === savedConfig.fields.length ? [...savedConfig.aggregateMethods] : savedConfig.fields.map(() => 'sum'))
    setPreflightJobId('')
    setKey(`compare_${crypto.randomUUID()}`)
    setCopiedFromResultId(copyResultId)
  }, [copyResultId, copySourceValid, copiedFromResultId, copiedResult.data, savedConfig, setAggregateMethods, setCopiedFromResultId,
    setContextLeftIds, setContextRightIds, setDuplicatePolicy, setEmptyValuePolicy, setFields, setIgnoreKeyCase, setKeys, setLeftId, setLeftLabel,
    setParseFailurePolicy, setRightId, setRightLabel, setTrimKeys])
  const change = () => { setKey(`compare_${crypto.randomUUID()}`); setPreflightJobId('') }
  const config: CompareConfig = { leftKeyIds: keys.map((item) => item.left), rightKeyIds: keys.map((item) => item.right), fields,
    trimKeys, ignoreKeyCase, leftLabel: leftLabel.trim(), rightLabel: rightLabel.trim(), duplicatePolicy,
    aggregateMethods: duplicatePolicy === 'aggregate' ? aggregateMethods : undefined, emptyValuePolicy, parseFailurePolicy,
    contextLeftIds, contextRightIds }
  const preflight = useMutation({ mutationFn: () => api.comparePreflight(selectedLeft, selectedRight, config, `preflight_${crypto.randomUUID()}`),
    onSuccess: (result) => setPreflightJobId(result.job.id) })
  const preflightJob = useQuery({ queryKey: ['compare', 'preflight', preflightJobId],
    queryFn: () => api.job(preflightJobId), enabled: Boolean(preflightJobId),
    refetchInterval: (query) => query.state.data && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(query.state.data.state) ? false : 1500 })
  const preflightResult = preflightJob.data?.state === 'succeeded' ? preflightJob.data.summary.preflight : undefined
  const submit = useMutation({ mutationFn: () => api.compare(selectedLeft, selectedRight, config, preflightJobId, key), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const updateKey = (at: number, side: 'left' | 'right', value: string) => { setKeys((items) => items.map((item, index) => index === at ? { ...item, [side]: value } : item)); change() }
  const updateField = (at: number, values: Partial<CompareField>) => { setFields((items) => items.map((item, index) => index === at ? { ...item, ...values } : item)); change() }
  const resetMappings = () => { setKeys([{ left: 'c_0', right: 'c_0' }]); setFields([newField()]); setAggregateMethods(['sum']);
    setContextLeftIds([]); setContextRightIds([]); change() }
  const leftColumns = leftSchema.data?.columns ?? []
  const rightColumns = rightSchema.data?.columns ?? []
  const normalizedName = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase()
  const savedPairs = (savedRecipes.data ?? []).filter((recipe) => recipe.isCurrent && recipe.spec.operation === 'compare')
    .flatMap((recipe) => {
      const config = recipe.spec.config as { fields?: { left?: string; right?: string }[] } | undefined
      return Array.isArray(config?.fields) ? config.fields.filter((field) => typeof field.left === 'string' && typeof field.right === 'string')
        .map((field) => ({ left: field.left!, right: field.right!, recipe: recipe.name })) : []
    })
  const mappingSuggestions = leftColumns.flatMap((left) => {
    if (!left.name.trim() || keys.some((key) => key.left === left.id)) return []
    const sameName = rightColumns.filter((right) => normalizedName(left.name) === normalizedName(right.name))
    if (sameName.length === 1 && !keys.some((key) => key.right === sameName[0]!.id)) {
      return [{ left, right: sameName[0]!, reason: t('规范化后同名', 'Same name after normalization') }]
    }
    const aliases = savedPairs.filter((pair) => pair.left === left.name)
      .flatMap((pair) => rightColumns.filter((right) => right.name === pair.right)
        .map((right) => ({ left, right, reason: t(`已保存模板“${pair.recipe}”`, `Saved template “${pair.recipe}”`) })))
    const uniqueAliases = aliases.filter((item, index, all) => all.findIndex((candidate) => candidate.right.id === item.right.id) === index)
    return uniqueAliases.length === 1 && !keys.some((key) => key.right === uniqueAliases[0]!.right.id) ? uniqueAliases : []
  }).filter((item, index, all) => all.findIndex((candidate) => candidate.right.id === item.right.id) === index).slice(0, 16)
  const valid = (!copyResultId || copySourceValid && copiedFromResultId === copyResultId) &&
    selectedLeft && selectedRight && selectedLeft !== selectedRight && leftColumns.length > 0 && rightColumns.length > 0 &&
    Boolean(leftLabel.trim() && rightLabel.trim() && leftLabel.length <= 100 && rightLabel.length <= 100) &&
    keys.length > 0 && fields.length > 0 && keys.every((item) => leftColumns.some((column) => column.id === item.left) && rightColumns.some((column) => column.id === item.right)) &&
    contextLeftIds.length <= 8 && contextRightIds.length <= 8 &&
    contextLeftIds.every((id) => leftColumns.some((column) => column.id === id)) &&
    contextRightIds.every((id) => rightColumns.some((column) => column.id === id)) &&
    (duplicatePolicy !== 'aggregate' || fields.every((field) => field.mode === 'decimal') && aggregateMethods.length === fields.length) &&
    fields.every((item) => leftColumns.some((column) => column.id === item.leftColumnId) && rightColumns.some((column) => column.id === item.rightColumnId) &&
      (item.mode !== 'decimal' || /^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(item.tolerance ?? '0') &&
        /^(?:0(?:\.\d{1,18})?|1(?:\.0{1,18})?)$/.test(item.relativeTolerance ?? '0')) &&
      (item.mode !== 'calendar-date' || Number.isSafeInteger(item.dayTolerance ?? 0) && (item.dayTolerance ?? 0) >= 0 && (item.dayTolerance ?? 0) <= 365) &&
      (item.mode !== 'instant' || Number.isSafeInteger(item.timeToleranceSeconds ?? 0) && (item.timeToleranceSeconds ?? 0) >= 0 && (item.timeToleranceSeconds ?? 0) <= 604800 &&
        validTimeZone(item.leftTimeZone) && validTimeZone(item.rightTimeZone)))
  const contextPicker = (side: 'left' | 'right') => {
    const selected = side === 'left' ? contextLeftIds : contextRightIds
    const setSelected = side === 'left' ? setContextLeftIds : setContextRightIds
    const columns = side === 'left' ? leftColumns : rightColumns
    return <div className="space-y-2"><label className="block space-y-1 text-meta text-ink-3">{side === 'left' ? t('左侧上下文字段', 'Left context fields') : t('右侧上下文字段', 'Right context fields')}
      <select value="" disabled={selected.length >= 8} onChange={(event) => { const id = event.target.value; if (id && !selected.includes(id)) { setSelected((current) => [...current, id]); change() } }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('选择要保留的字段', 'Choose a field to retain')}</option>{columns.filter((column) => !selected.includes(column.id)).map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
      <div className="flex flex-wrap gap-2">{selected.map((id) => <span key={id} className="inline-flex items-center gap-2 rounded-control bg-surface-sunk px-2 py-1 text-meta text-ink-2">{columns.find((column) => column.id === id)?.name ?? id}<Button size="sm" onClick={() => { setSelected((current) => current.filter((item) => item !== id)); change() }}>{t('移除', 'Remove')}</Button></span>)}</div>
    </div>
  }
  return <><PageTopBar title={t('双表核对配置', 'Compare two datasets')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    <DraftInputWarning ids={[leftId, rightId]} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || requestedLeft.isLoading || requestedRight.isLoading} />
    {copyResultId && copiedResult.isLoading ? <Spinner /> : null}
    {copyResultId && copiedResult.error ? <Banner tone="danger" title={t('旧核对结果无法读取', 'Could not load the previous comparison')}>{copiedResult.error.message}</Banner> : null}
    {copyResultId && copiedResult.data && !copySourceValid ? <Banner tone="danger">{t('旧资源没有可用的核对规则。请返回核对结果，或新建核对。', 'This resource has no usable comparison rules. Return to the results or start a new comparison.')} <Link to="/compare" search={{ leftId: undefined, rightId: undefined, copyResultId: undefined }} className="text-accent-ink hover:underline">{t('新建核对', 'New comparison')}</Link></Banner> : null}
    {copyResultId && copySourceValid && copiedFromResultId === copyResultId ? <Banner tone="info">{t('已载入旧结果的固定输入与规则。修改后仍须重新执行全量预检；提交会生成独立任务，旧结果保持原样。', 'The fixed inputs and rules from the previous result are loaded. Run a new full preflight after editing; submission creates a separate job and preserves the old result.')}</Banner> : null}
    <Banner tone="info">{t('固定两份数据集版本，按组合键匹配。空键始终隔离；重复键由下方策略处理。金额按原始十进制文本计算，不先四舍五入。', 'Fix two dataset versions and match them by a combined key. Empty keys are isolated; use the policy below for duplicates. Amounts are calculated from original decimal text without prior rounding.')}</Banner>
    <Panel className="max-w-5xl space-y-4"><SectionTitle title={t('输入数据集', 'Input datasets')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {requestedLeft.error || requestedRight.error ? <Banner tone="danger" title={t('指定版本无法读取', 'Could not load selected version')}>{(requestedLeft.error ?? requestedRight.error)?.message}</Banner> : null}
      {!resources.isLoading && datasets.length < 2 ? <p className="text-cell text-ink-3">{t('请先导入至少两份数据集。', 'Import at least two datasets first.')}</p> : null}
      <div className="grid gap-3 md:grid-cols-2">{(['left', 'right'] as const).map((side) => <label key={side} className="block space-y-1 text-meta text-ink-3">{side === 'left' ? t('左侧数据集', 'Left dataset') : t('右侧数据集', 'Right dataset')}<select value={side === 'left' ? selectedLeft : selectedRight} onChange={(event) => { side === 'left' ? setLeftId(event.target.value) : setRightId(event.target.value); resetMappings() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label>)}</div>
      <div className="grid gap-3 md:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('左侧业务名称', 'Left business label')}<input value={leftLabel} maxLength={100} onChange={(event) => { setLeftLabel(event.target.value); change() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label><label className="space-y-1 text-meta text-ink-3">{t('右侧业务名称', 'Right business label')}<input value={rightLabel} maxLength={100} onChange={(event) => { setRightLabel(event.target.value); change() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label></div>
      <div className="space-y-2"><Button size="sm" onClick={() => setShowSamples((value) => !value)}>{showSamples ? t('收起两侧样本', 'Hide both samples') : t('查看两侧前 20 行样本', 'View first 20 rows from both sides')}</Button>{showSamples ? <div className="grid gap-3 lg:grid-cols-2">{([{ side: t('左侧', 'Left'), schema: leftSchema.data, sample: leftSample }, { side: t('右侧', 'Right'), schema: rightSchema.data, sample: rightSample }] as const).map((item) => <div key={item.side} className="min-w-0 space-y-1"><p className="text-meta font-medium">{t(`${item.side} · 前 20 行、最多 8 列；只用于字段映射检查`, `${item.side} · first 20 rows, up to 8 columns; for mapping review only`)}</p>{item.sample.isLoading ? <Spinner /> : null}{item.sample.error ? <Banner tone="danger">{item.sample.error.message}</Banner> : null}{item.sample.data ? <div className="max-h-56 overflow-auto rounded-control bg-surface-sunk"><table className="min-w-full text-left text-meta"><thead><tr>{item.schema?.columns.slice(0, 8).map((column) => <th key={column.id} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={column.name}>{column.name}</th>)}</tr></thead><tbody>{item.sample.data.rows.map((row, index) => <tr key={index}>{row.slice(0, 8).map((cell, column) => <td key={column} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={cell ?? ''}>{cell ?? ''}</td>)}</tr>)}</tbody></table></div> : null}</div>)}</div> : null}</div>
      {leftSchema.error || rightSchema.error ? <Banner tone="danger" title={t('字段读取失败', 'Could not load fields')}>{(leftSchema.error ?? rightSchema.error)?.message}</Banner> : null}
    </Panel>
    <Panel className="max-w-5xl space-y-4"><SectionTitle title={t('匹配键', 'Matching keys')} /><p className="text-meta text-ink-3">{t('两侧可以选择不同字段名。每组映射构成复合键的一部分；默认不匹配空值。', 'Each side may use a different field. Every mapping is part of the combined key; empty values do not match by default.')}</p>
      {keys.map((item, at) => <div key={at} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <label className="space-y-1 text-meta text-ink-3">{t('左侧字段', 'Left field')}<select value={item.left} onChange={(event) => updateKey(at, 'left', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{leftColumns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
        <label className="space-y-1 text-meta text-ink-3">{t('右侧字段', 'Right field')}<select value={item.right} onChange={(event) => updateKey(at, 'right', event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{rightColumns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
        <Button size="sm" disabled={keys.length === 1} onClick={() => { setKeys((items) => items.filter((_, index) => index !== at)); change() }}>{t('移除', 'Remove')}</Button>
      </div>)}
      <Button size="sm" disabled={keys.length >= 4} onClick={() => { setKeys((items) => [...items, { left: 'c_0', right: 'c_0' }]); change() }}>{t('添加键字段', 'Add key field')}</Button>
      <div className="flex flex-wrap gap-4 text-cell text-ink-2"><label className="flex gap-2"><input type="checkbox" checked={trimKeys} onChange={(event) => { setTrimKeys(event.target.checked); change() }} />{t('匹配时忽略键的首尾空白', 'Ignore leading and trailing spaces in keys')}</label><label className="flex gap-2"><input type="checkbox" checked={ignoreKeyCase} onChange={(event) => { setIgnoreKeyCase(event.target.checked); change() }} />{t('匹配时忽略键的大小写', 'Ignore case in keys')}</label></div>
      <label className="block max-w-md space-y-1 text-meta text-ink-3">{t('重复键处理', 'Duplicate key policy')}<select value={duplicatePolicy} onChange={(event) => { setDuplicatePolicy(event.target.value as typeof duplicatePolicy); change() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="isolate">{t('隔离所有重复组成员（默认）', 'Isolate all duplicate group members (default)')}</option><option value="abort">{t('发现重复键即停止任务', 'Stop job when a duplicate key is found')}</option><option value="aggregate">{t('按每个字段的 SUM/COUNT 聚合后比较', 'Aggregate each field by SUM or COUNT before comparing')}</option></select></label>
      {duplicatePolicy === 'aggregate' ? <p className="text-meta text-ink-3">{t('聚合只用于两侧都有的键；单侧缺失的记录逐条保留。比较字段须全部选“十进制数值”，结果保留成员行号与聚合前原值。', 'Aggregation applies only to keys found on both sides; unmatched records stay separate. All compared fields must use decimal mode. Results retain member row numbers and original values.')}</p> : null}
      <div className="grid gap-3 md:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('比较字段为空时', 'When a compared value is empty')}<select value={emptyValuePolicy} onChange={(event) => { setEmptyValuePolicy(event.target.value as typeof emptyValuePolicy); change() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="mode-default">{t('按字段类型处理（文本照常比较，其余记为解析异常）', 'Use field mode (compare text; other modes report a parse error)')}</option><option value="match-both">{t('两侧都为空视为一致，只有一侧为空视为差异', 'Both empty: equal; one empty: different')}</option><option value="error">{t('任一侧为空都记为解析异常', 'Any empty value: parse error')}</option></select></label><label className="space-y-1 text-meta text-ink-3">{t('比较字段解析失败时', 'When a compared value cannot be parsed')}<select value={parseFailurePolicy} onChange={(event) => { setParseFailurePolicy(event.target.value as typeof parseFailurePolicy); change() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="isolate">{t('记入解析异常，继续核对', 'Record a parse error and continue')}</option><option value="abort">{t('停止任务，不发布部分结果', 'Stop the job without publishing partial results')}</option></select></label></div>
    </Panel>
    <Panel className="max-w-5xl space-y-4"><SectionTitle title={t('比较字段', 'Fields to compare')} /><p className="text-meta text-ink-3">{t('数量可选十进制精确比较（容差 0），金额可设置非负绝对容差。无法解析的数值进入“解析异常”。', 'Use exact decimal comparison with tolerance 0 for quantities, or a nonnegative absolute tolerance for amounts. Unparseable numbers enter the parse error category.')}</p>
      <div className="space-y-2 rounded-control bg-surface-sunk p-3"><p className="text-meta text-ink-3">{t('上下文字段随结果保存，但不参与一致或差异判定；每侧最多 8 个。来源行仍可打开完整的固定版本。', 'Context fields are saved with the result but do not affect equality or difference; up to eight per side. Source rows still open the complete fixed version.')}</p><div className="grid gap-3 md:grid-cols-2">{contextPicker('left')}{contextPicker('right')}</div></div>
      {mappingSuggestions.length ? <div className="space-y-2 rounded-control bg-surface-sunk p-3 text-meta text-ink-2"><p className="font-medium">{t('字段映射建议', 'Field mapping suggestions')}</p><p>{t('仅根据两侧同名字段和当前已保存的核对模板提出候选；不会自动设定业务主键或数值容差。套用后仍需逐项确认并完成全量预检。', 'Suggestions use matching field names and saved comparison templates. They do not set business keys or numeric tolerances. Confirm each mapping and complete the full preflight check.')}</p><div className="flex flex-wrap gap-x-4 gap-y-1">{mappingSuggestions.map((item) => <span key={`${item.left.id}-${item.right.id}`}>{item.left.name} ↔ {item.right.name}{t(`（${item.reason}）`, ` (${item.reason})`)}</span>)}</div><Button size="sm" onClick={() => { setFields(mappingSuggestions.map((item) => ({ leftColumnId: item.left.id, rightColumnId: item.right.id, mode: 'text' as const, tolerance: '0' }))); setAggregateMethods(mappingSuggestions.map(() => 'sum' as const)); change() }}>{t('套用这些字段映射', 'Use these field mappings')}</Button></div> : null}
      {fields.map((item, at) => <div key={at} className="space-y-3 border-t border-hairline-soft pt-3">
        <div className="grid items-end gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_12rem_auto]">
          <label className="space-y-1 text-meta text-ink-3">{t('左侧字段', 'Left field')}<select value={item.leftColumnId} onChange={(event) => updateField(at, { leftColumnId: event.target.value })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{leftColumns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
          <label className="space-y-1 text-meta text-ink-3">{t('右侧字段', 'Right field')}<select value={item.rightColumnId} onChange={(event) => updateField(at, { rightColumnId: event.target.value })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{rightColumns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
          <label className="space-y-1 text-meta text-ink-3">{t('比较方式', 'Comparison mode')}<select value={item.mode} onChange={(event) => updateField(at, { mode: event.target.value as CompareField['mode'] })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="text">{t('文本', 'Text')}</option><option value="decimal">{t('十进制数值', 'Decimal value')}</option><option value="calendar-date">{t('日历日期', 'Calendar date')}</option><option value="instant">{t('带时区时间点', 'Instant with time zone')}</option></select></label>
          <Button size="sm" disabled={fields.length === 1} onClick={() => { setFields((items) => items.filter((_, index) => index !== at)); setAggregateMethods((items) => items.filter((_, index) => index !== at)); change() }}>{t('移除', 'Remove')}</Button>
        </div>
        {duplicatePolicy === 'aggregate' ? <label className="block max-w-xs space-y-1 text-meta text-ink-3">{t('重复组聚合方式', 'Duplicate group aggregation')}<select value={aggregateMethods[at] ?? 'sum'} onChange={(event) => { setAggregateMethods((items) => items.map((method, index) => index === at ? event.target.value as 'sum' | 'count' : method)); change() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="sum">{t('SUM：十进制精确求和', 'SUM: exact decimal sum')}</option><option value="count">{t('COUNT：记录数', 'COUNT: record count')}</option></select></label> : null}
        {item.mode === 'text' ? <div className="flex flex-wrap gap-4 text-cell text-ink-2"><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(item.textTrim)} onChange={(event) => updateField(at, { textTrim: event.target.checked })} />{t('忽略首尾空白', 'Ignore leading and trailing spaces')}</label><label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(item.textIgnoreCase)} onChange={(event) => updateField(at, { textIgnoreCase: event.target.checked })} />{t('忽略大小写', 'Ignore case')}</label><label className="space-y-1 text-meta text-ink-3">Unicode<select value={item.unicode ?? 'none'} onChange={(event) => updateField(at, { unicode: event.target.value as CompareField['unicode'] })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="none">{t('不转换', 'No conversion')}</option><option value="NFC">NFC</option><option value="NFKC">NFKC</option></select></label></div> : null}
        {item.mode === 'decimal' ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('绝对容差', 'Absolute tolerance')}<input value={item.tolerance ?? '0'} onChange={(event) => updateField(at, { tolerance: event.target.value })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label><label className="space-y-1 text-meta text-ink-3">{t('相对容差（0 至 1）', 'Relative tolerance (0 to 1)')}<input value={item.relativeTolerance ?? '0'} onChange={(event) => updateField(at, { relativeTolerance: event.target.value })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label><p className="text-meta text-ink-3 sm:col-span-2">{t('通过条件：绝对差值 ≤ 绝对容差，或绝对差值 ≤ 相对容差 × max(|左值|, |右值|)。两值均为 0 时相对部分为 0。', 'Pass when the absolute difference is at most the absolute tolerance, or at most the relative tolerance times max(|left|, |right|). The relative part is 0 when both values are 0.')}</p></div> : null}
        {item.mode === 'calendar-date' ? <label className="block max-w-xs space-y-1 text-meta text-ink-3">{t('允许相差日历日', 'Allowed calendar-day difference')}<input type="number" min={0} max={365} value={item.dayTolerance ?? 0} onChange={(event) => updateField(at, { dayTolerance: Number(event.target.value) })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label> : null}
        {item.mode === 'instant' ? <div className="space-y-2"><div className="grid gap-3 sm:grid-cols-3"><label className="block space-y-1 text-meta text-ink-3">{t('允许相差秒数', 'Allowed difference in seconds')}<input type="number" min={0} max={604800} value={item.timeToleranceSeconds ?? 0} onChange={(event) => updateField(at, { timeToleranceSeconds: Number(event.target.value) })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label><label className="block space-y-1 text-meta text-ink-3">{t('左侧无偏移时间的时区', 'Left local time zone')}<input value={item.leftTimeZone ?? ''} maxLength={64} onChange={(event) => updateField(at, { leftTimeZone: event.target.value || undefined })} placeholder="Asia/Taipei" className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label><label className="block space-y-1 text-meta text-ink-3">{t('右侧无偏移时间的时区', 'Right local time zone')}<input value={item.rightTimeZone ?? ''} maxLength={64} onChange={(event) => updateField(at, { rightTimeZone: event.target.value || undefined })} placeholder="UTC" className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label></div><p className="text-meta text-ink-3">{t('带 Z 或 ±HH:MM 的值直接按自身偏移比较。无偏移的 ISO 本地时间须填写对应 IANA 时区；夏令时造成的不存在或重复时间记为解析异常，不自动选择。', 'Values with Z or ±HH:MM use their own offset. For local ISO times without an offset, enter each side’s IANA time zone. Missing or repeated daylight-saving times are parse errors and are never guessed.')}</p></div> : null}
      </div>)}
      <Button size="sm" disabled={fields.length >= 16} onClick={() => { setFields((items) => [...items, newField()]); setAggregateMethods((items) => [...items, 'sum']); change() }}>{t('添加比较字段', 'Add comparison field')}</Button>
      <div className="rounded-control bg-surface-sunk p-3 text-cell text-ink-2"><strong className="text-ink">{t('执行前规则', 'Rules before running')}</strong>
        <p>{t('左侧：', 'Left: ')}{datasets.find((item) => item.id === selectedLeft)?.name ?? t('未选择', 'Not selected')}{t(`，${formatNumber(datasets.find((item) => item.id === selectedLeft)?.rowCount)} 行；右侧：`, `, ${formatNumber(datasets.find((item) => item.id === selectedLeft)?.rowCount)} rows; right: `)}{datasets.find((item) => item.id === selectedRight)?.name ?? t('未选择', 'Not selected')}{t(`，${formatNumber(datasets.find((item) => item.id === selectedRight)?.rowCount)} 行。`, `, ${formatNumber(datasets.find((item) => item.id === selectedRight)?.rowCount)} rows.`)}</p>
        <p>{t(`匹配键 ${keys.length} 组；比较字段 ${fields.length} 组；重复键策略：`, `${keys.length} matching keys; ${fields.length} compared fields; duplicate policy: `)}{duplicatePolicy === 'isolate' ? t('隔离', 'isolate') : duplicatePolicy === 'abort' ? t('发现即停止', 'stop on duplicate') : t('SUM/COUNT 聚合', 'SUM/COUNT aggregation')}{t('。完整规则和输入版本保存在任务记录中。', '. Complete rules and input versions are saved in the job record.')}</p>
      </div>
      <Button variant="primary" disabled={!valid || preflight.isPending || Boolean(preflightJobId && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(preflightJob.data?.state ?? 'queued'))} onClick={() => preflight.mutate()}>{t('执行全量预检', 'Run full preflight check')}</Button>
      {preflight.error ? <Banner tone="danger" title={t('预检未提交', 'Preflight was not submitted')}>{preflight.error.message}</Banner> : null}
      {preflightJobId && preflightJob.data && preflightJob.data.state !== 'succeeded' ? <p className="text-cell text-ink-3">{t('预检任务：', 'Preflight job: ')}{localizedStage(preflightJob.data.progress.stage ?? preflightJob.data.state)}{t('。可离开页面后在', '. You can leave this page and use ')}<Link to="/jobs/$jobId" params={{ jobId: preflightJobId }} className="text-accent-ink hover:underline">{t('任务详情', 'Job details')}</Link>{t('查看。', ' to view progress.')}</p> : null}
      {preflightJob.data?.error ? <Banner tone="danger" title={t('全量预检失败', 'Full preflight failed')}>{localizedErrorMessage(preflightJob.data.error.code, preflightJob.data.error.message)}</Banner> : null}
      {preflightResult ? <div className="space-y-2 rounded-control bg-surface-sunk p-3 text-cell text-ink-2"><strong className="text-ink">{t('全量预检结果', 'Full preflight results')}</strong>
        <p>{t(`左侧空键 ${formatNumber(preflightResult.leftKeys.emptyKeys)} 条、重复组 ${formatNumber(preflightResult.leftKeys.duplicateGroups)} 组、规范化冲突 ${formatNumber(preflightResult.leftKeys.normalizedCollisionGroups)} 组；右侧空键 ${formatNumber(preflightResult.rightKeys.emptyKeys)} 条、重复组 ${formatNumber(preflightResult.rightKeys.duplicateGroups)} 组、规范化冲突 ${formatNumber(preflightResult.rightKeys.normalizedCollisionGroups)} 组。`, `Left: ${formatNumber(preflightResult.leftKeys.emptyKeys)} empty keys, ${formatNumber(preflightResult.leftKeys.duplicateGroups)} duplicate groups, ${formatNumber(preflightResult.leftKeys.normalizedCollisionGroups)} normalization collisions. Right: ${formatNumber(preflightResult.rightKeys.emptyKeys)} empty keys, ${formatNumber(preflightResult.rightKeys.duplicateGroups)} duplicate groups, ${formatNumber(preflightResult.rightKeys.normalizedCollisionGroups)} normalization collisions.`)}</p>
        <p>{t(`预计一致 ${formatNumber(preflightResult.summary.equalPairs)} 对、字段差异 ${formatNumber(preflightResult.summary.differentPairs)} 对、解析异常 ${formatNumber(preflightResult.summary.pairErrors)} 对、仅左 ${formatNumber(preflightResult.summary.leftOnly)} 条、仅右 ${formatNumber(preflightResult.summary.rightOnly)} 条。依据完整输入计算，正式执行会生成可检索明细。`, `Expected: ${formatNumber(preflightResult.summary.equalPairs)} equal pairs, ${formatNumber(preflightResult.summary.differentPairs)} differing pairs, ${formatNumber(preflightResult.summary.pairErrors)} parse-error pairs, ${formatNumber(preflightResult.summary.leftOnly)} left-only records and ${formatNumber(preflightResult.summary.rightOnly)} right-only records. Counts use the complete inputs; the full run creates searchable details.`)}</p>
        {preflightResult.sample.length ? <div className="space-y-1"><p className="text-meta text-ink-3">{t(`前 ${preflightResult.sample.length} 条异常或差异样本`, `First ${preflightResult.sample.length} error or difference samples`)}</p>{preflightResult.sample.map((item) => <p key={item.detailRow} className="break-all text-meta">{t(`第 ${item.detailRow} 条`, `Record ${item.detailRow}`)} · {item.category} · {item.key} · {item.field} · {item.leftValue} / {item.rightValue}</p>)}</div> : null}
        {preflightResult.wouldAbort ? <Banner tone="warning">{t('预检发现当前规则会停止任务：存在需要终止的重复键或比较字段解析异常。请调整数据或处理策略后重新预检。', 'Preflight found that the selected rules would stop the job because of duplicate keys or parse errors. Adjust the data or the handling rules, then run preflight again.')}</Banner> : null}
      </div> : null}
      {submit.error ? <Banner tone="danger" title={t('核对未提交', 'Comparison was not submitted')}>{submit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!valid || !preflightResult || preflightResult.wouldAbort || submit.isPending} onClick={() => submit.mutate()}>{t('确认规则并运行全量核对', 'Confirm rules and compare complete datasets')}</Button>
    </Panel>
  </PageBody></>
}
