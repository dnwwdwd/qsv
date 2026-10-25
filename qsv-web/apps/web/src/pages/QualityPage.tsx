import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useDatasetSearch } from '@/ui/useDatasetSearch'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type QualityRule } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'

type DraftRule = { kind: QualityRule['kind']; columnId: string; min: string; max: string; values: string;
  dataType: 'integer' | 'decimal' | 'date'; otherColumnId: string; columnIds: string[]; pattern: string;
  leftColumnId: string; rightColumnId: string; tolerance: string; referenceId: string; referenceColumnId: string }
const emptyRule = (): DraftRule => ({ kind: 'required', columnId: 'c_0', min: '0', max: '100', values: '', dataType: 'integer',
  otherColumnId: 'c_1', columnIds: ['c_0'], pattern: '^[A-Z]{2}[0-9]{6}$', leftColumnId: 'c_0', rightColumnId: 'c_0', tolerance: '0',
  referenceId: '', referenceColumnId: 'c_0' })
const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
const kindLabel: Record<QualityRule['kind'], string> = {
  required: '必填', length: '文本长度', enum: '允许值', type: '字段类型', range: '数值范围',
  'date-order': '日期顺序', unique: '唯一键', pattern: '表达式格式', arithmetic: '金额计算', reference: '参考值',
}
const kindLabelEn: Record<QualityRule['kind'], string> = {
  required: 'Required', length: 'Text length', enum: 'Allowed values', type: 'Field type', range: 'Numeric range',
  'date-order': 'Date order', unique: 'Unique key', pattern: 'Pattern', arithmetic: 'Amount calculation', reference: 'Reference value',
}

export function QualityPage() {
  const t = useT()
  const navigate = useNavigate()
  const { sourceId: requestedSourceId } = useSearch({ from: '/quality' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['quality', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('quality')
  const [reportOffset, setReportOffset] = useState(0)
  const reportPage = useQuery({ queryKey: ['quality', 'reports', reportOffset],
    queryFn: () => api.findResources({ kind: 'dataset', status: 'ready' }, reportOffset, 100), refetchInterval: 5000 })
  const [sourceId, setSourceId] = useSessionDraft('QualityPage.sourceId', '')
  const lookupId = requestedSourceId || sourceId
  const requestedResource = useQuery({ queryKey: ['resource', lookupId], queryFn: () => api.resource(lookupId), enabled: Boolean(lookupId) })
  const [draftRules, setDraftRules] = useSessionDraft<DraftRule[]>('QualityPage.draftRules', [emptyRule()])
  const referenceResources = useQueries({ queries: [...new Set(draftRules.filter((rule) => rule.kind === 'reference')
    .map((rule) => rule.referenceId).filter(Boolean))].map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), requestedResource.data,
    ...referenceResources.map((query) => query.data)].filter((item) => Boolean(item)).map((item) => [item!.id, item!] as const)).values()]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready' && !item.metadata.qualitySummary && !item.metadata.analysis && !item.metadata.compareSummary)
  const reports = reportPage.data?.items.filter((item) => Boolean(item.metadata.qualitySummary)) ?? []
  useEffect(() => { if (requestedSourceId) setSourceId(requestedSourceId) }, [requestedSourceId, setSourceId])
  const [outputMode, setOutputMode] = useSessionDraft<'report' | 'valid' | 'invalid'>('QualityPage.outputMode', 'report')
  const [rulesFile, setRulesFile] = useState<File | null>(null)
  const [rulesFileError, setRulesFileError] = useState('')
  const [key, setKey] = useState(() => `quality_${crypto.randomUUID()}`)
  const selected = sourceId || resources.data?.items.find((item) => item.kind === 'dataset' && item.status === 'ready' && !item.metadata.qualitySummary && !item.metadata.analysis && !item.metadata.compareSummary)?.id || datasets[0]?.id || ''
  const referenceCandidates = datasets.filter((item) => item.id !== selected)
  const schema = useQuery({ queryKey: ['schema', selected], queryFn: () => api.schema(selected), enabled: Boolean(selected) })
  const updateRule = (index: number, patch: Partial<DraftRule>) => {
    setDraftRules((rules) => rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule))
    setKey(`quality_${crypto.randomUUID()}`)
  }
  const parsed = draftRules.map((rule): QualityRule => rule.kind === 'required'
    ? { kind: 'required', columnId: rule.columnId }
    : rule.kind === 'length' ? { kind: 'length', columnId: rule.columnId, min: Number(rule.min), max: Number(rule.max) }
    : rule.kind === 'enum' ? { kind: 'enum', columnId: rule.columnId, values: rule.values.split('\n').map((value) => value.trim()).filter(Boolean) }
    : rule.kind === 'type' ? { kind: 'type', columnId: rule.columnId, dataType: rule.dataType }
    : rule.kind === 'range' ? { kind: 'range', columnId: rule.columnId, min: rule.min, max: rule.max }
    : rule.kind === 'date-order' ? { kind: 'date-order', columnId: rule.columnId, otherColumnId: rule.otherColumnId }
    : rule.kind === 'pattern' ? { kind: 'pattern', columnId: rule.columnId, pattern: rule.pattern }
    : rule.kind === 'arithmetic' ? { kind: 'arithmetic', columnId: rule.columnId, leftColumnId: rule.leftColumnId,
      rightColumnId: rule.rightColumnId, tolerance: rule.tolerance }
    : rule.kind === 'reference' ? { kind: 'reference', columnId: rule.columnId,
      referenceId: rule.referenceId || referenceCandidates[0]?.id || '', referenceColumnId: rule.referenceColumnId }
    : { kind: 'unique', columnIds: rule.columnIds })
  const invalid = parsed.some((rule) => rule.kind === 'length'
    ? !Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) || rule.min < 0 || rule.max < rule.min || rule.max > 100000
    : rule.kind === 'enum' ? rule.values.length === 0 || rule.values.length > 100
    : rule.kind === 'range' ? !/^[+-]?\d+(?:\.\d{1,18})?$/u.test(rule.min) || !/^[+-]?\d+(?:\.\d{1,18})?$/u.test(rule.max)
    : rule.kind === 'date-order' ? rule.columnId === rule.otherColumnId || !schema.data?.columns.some((column) => column.id === rule.otherColumnId)
    : rule.kind === 'pattern' ? !rule.pattern || rule.pattern.length > 160
    : rule.kind === 'arithmetic' ? !/^[+]?(?:0|\d+)(?:\.\d{1,18})?$/u.test(rule.tolerance) ||
      !schema.data?.columns.some((column) => column.id === rule.leftColumnId) ||
      !schema.data?.columns.some((column) => column.id === rule.rightColumnId)
    : rule.kind === 'reference' ? !rule.referenceId || !rule.referenceColumnId || !referenceCandidates.some((item) => item.id === rule.referenceId)
    : rule.kind === 'unique' && (rule.columnIds.length < 1 || rule.columnIds.length > 16))
  const submit = useMutation({ mutationFn: () => api.quality(selected, parsed, key, outputMode), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const previewSignature = JSON.stringify({ selected, parsed })
  const trial = useMutation({ mutationFn: async () => ({ signature: previewSignature, result: await api.qualityPreview(selected, parsed) }) })
  const exportRules = () => {
    const columns = schema.data?.columns.map((column) => column.name) ?? []
    if (!columns.length || columns.some((name) => !name) || new Set(columns).size !== columns.length) {
      setRulesFileError(t('字段名为空或重复，无法按名称导出可复用规则', 'Empty or duplicate field names prevent exporting reusable rules by name')); return
    }
    const payload = JSON.stringify({ format: 'qsv-quality-rules-v1', columns, outputMode,
      rules: draftRules.map((rule) => ({ ...rule, referenceId: '' })) }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'qsv-quality-rules.json'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setRulesFileError('')
  }
  const importRules = async () => {
    if (!rulesFile || !schema.data) return
    try {
      if (rulesFile.size > 256 * 1024) throw new Error(t('规则文件不能超过 256 KiB', 'Rule file must be 256 KiB or smaller'))
      const file = JSON.parse(await rulesFile.text()) as Record<string, unknown>
      if (file.format !== 'qsv-quality-rules-v1' || !Array.isArray(file.columns) || !Array.isArray(file.rules) ||
        file.rules.length < 1 || file.rules.length > 32 || file.columns.some((name) => typeof name !== 'string' || !name)) {
        throw new Error(t('规则文件结构无效', 'Invalid rule file structure'))
      }
      const oldNames = file.columns as string[]
      if (new Set(oldNames).size !== oldNames.length) throw new Error(t('规则文件字段名重复', 'Duplicate field names in rule file'))
      const currentNames = schema.data.columns.map((column) => column.name)
      if (currentNames.some((name) => !name) || new Set(currentNames).size !== currentNames.length) throw new Error(t('当前数据集字段名为空或重复', 'Current dataset has empty or duplicate field names'))
      const current = new Map(schema.data.columns.map((column) => [column.name, column.id]))
      const bind = (value: unknown) => {
        if (typeof value !== 'string' || !/^c_\d+$/u.test(value)) throw new Error(t('规则文件中的字段编号无效', 'Invalid field ID in rule file'))
        const name = oldNames[Number(value.slice(2))]
        const id = name && current.get(name)
        if (!id) throw new Error(t(`当前数据集缺少字段：${name ?? value}`, `Current dataset is missing field: ${name ?? value}`))
        return id
      }
      const fallback = schema.data.columns[0]?.id ?? 'c_0'
      const kinds = new Set(['required', 'length', 'enum', 'type', 'range', 'date-order', 'unique', 'pattern', 'arithmetic', 'reference'])
      const next = file.rules.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('规则项目无效', 'Invalid rule item'))
        const record = value as Record<string, unknown>
        if (typeof record.kind !== 'string' || !kinds.has(record.kind) || typeof record.min !== 'string' ||
          typeof record.max !== 'string' || typeof record.values !== 'string' || typeof record.pattern !== 'string' ||
          typeof record.tolerance !== 'string' || !Array.isArray(record.columnIds)) throw new Error(t('规则参数无效', 'Invalid rule settings'))
        return { ...emptyRule(), kind: record.kind as DraftRule['kind'], columnId: bind(record.columnId),
          min: record.min, max: record.max, values: record.values, pattern: record.pattern,
          tolerance: record.tolerance, dataType: record.dataType as DraftRule['dataType'],
          otherColumnId: record.kind === 'date-order' ? bind(record.otherColumnId) : fallback,
          leftColumnId: record.kind === 'arithmetic' ? bind(record.leftColumnId) : fallback,
          rightColumnId: record.kind === 'arithmetic' ? bind(record.rightColumnId) : fallback,
          columnIds: record.kind === 'unique' ? record.columnIds.map(bind) : [fallback],
          referenceId: '', referenceColumnId: 'c_0' } satisfies DraftRule
      })
      setDraftRules(next); setOutputMode(['report', 'valid', 'invalid'].includes(String(file.outputMode)) ? file.outputMode as typeof outputMode : 'report')
      setKey(`quality_${crypto.randomUUID()}`); setRulesFileError(''); setRulesFile(null)
    } catch (error) { setRulesFileError(error instanceof Error ? error.message : t('无法读取规则文件', 'Could not read rule file')) }
  }
  const suggested = schema.data?.columns.flatMap((column) => {
    const type = column.type.toLowerCase()
    const dataType = (type.includes('integer') ? 'integer' : type.includes('decimal') ? 'decimal' : type.includes('date') ? 'date' : null) as DraftRule['dataType'] | null
    return dataType ? [{ ...emptyRule(), kind: 'type' as const, columnId: column.id, dataType }] : []
  }) ?? []

  return <><PageTopBar title={t('数据质量检查', 'Data quality check')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    <DraftInputWarning ids={[sourceId, ...draftRules.filter((rule) => rule.kind === 'reference').map((rule) => rule.referenceId)]} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || requestedResource.isLoading || referenceResources.some((query) => query.isLoading)} />
    <Banner tone="info">{t('按规则扫描完整数据集，可生成异常明细、有效记录副本或异常记录副本。检查不会修改原数据。', 'Scan the complete dataset against rules to create a violation report, a copy of valid records or a copy of invalid records. Source data is unchanged.')}</Banner>
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('检查规则', 'Check rules')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length === 0 ? <p className="text-cell text-ink-3">{t('请先导入至少一个数据集。', 'Import at least one dataset first.')}</p> : null}
      <label className="block space-y-1 text-meta text-ink-3">{t('数据集', 'Dataset')}<select value={selected} onChange={(event) => { setSourceId(event.target.value); setDraftRules([emptyRule()]); setKey(`quality_${crypto.randomUUID()}`) }} className={selectClass}>{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label>
      {schema.error ? <Banner tone="danger" title={t('字段读取失败', 'Could not load fields')}>{schema.error.message}</Banner> : null}
      <div className="flex flex-wrap items-center gap-2 rounded-control bg-surface-sunk p-3"><Button size="sm" disabled={!schema.data || !suggested.length} onClick={() => { setDraftRules((items) => [...items, ...suggested].slice(0, 32)); setKey(`quality_${crypto.randomUUID()}`) }}>{t('从已知字段类型添加建议', 'Suggest checks from known field types')}</Button><span className="text-meta text-ink-3">{suggested.length ? t(`可添加 ${suggested.length} 条类型检查；请逐条确认`, `${suggested.length} type checks available; confirm each one`) : t('当前字段没有可用的类型建议', 'No type suggestions for the current fields')}</span></div>
      <div className="space-y-2 rounded-control bg-surface-sunk p-3"><p className="text-meta text-ink-3">{t('规则文件按字段名称绑定。导入后若字段缺失会拒绝；参考数据需要重新选择。', 'Rule files bind by field name. Import rejects missing fields, and reference datasets must be selected again.')}</p><div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={!schema.data} onClick={exportRules}>{t('导出当前规则', 'Export current rules')}</Button><input type="file" accept=".json,application/json" onChange={(event) => setRulesFile(event.target.files?.[0] ?? null)} className="max-w-full text-meta" /><Button size="sm" disabled={!rulesFile || !schema.data} onClick={() => void importRules()}>{t('导入规则', 'Import rules')}</Button></div>{rulesFileError ? <Banner tone="danger">{rulesFileError}</Banner> : null}</div>
      {draftRules.map((rule, index) => <div key={index} className="space-y-3 rounded-panel bg-surface-sunk p-4">
        <div className="flex items-center justify-between gap-3"><strong className="text-cell text-ink">{t(`规则 ${index + 1}`, `Rule ${index + 1}`)}</strong><Button variant="quiet" disabled={draftRules.length === 1} onClick={() => { setDraftRules((items) => items.filter((_, at) => at !== index)); setKey(`quality_${crypto.randomUUID()}`) }}>{t('移除', 'Remove')}</Button></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<select value={rule.columnId} onChange={(event) => updateRule(index, { columnId: event.target.value })} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>
          <label className="space-y-1 text-meta text-ink-3">{t('检查方式', 'Check type')}<select value={rule.kind} onChange={(event) => updateRule(index, { kind: event.target.value as QualityRule['kind'] })} className={selectClass}><option value="required">{t('必填：不允许空文本', 'Required: no empty text')}</option><option value="length">{t('文本长度范围', 'Text length range')}</option><option value="enum">{t('允许值列表', 'List of allowed values')}</option><option value="type">{t('字段类型', 'Field type')}</option><option value="range">{t('十进制数值范围', 'Decimal range')}</option><option value="date-order">{t('开始日期不晚于结束日期', 'Start date is not after end date')}</option><option value="unique">{t('单字段或组合键唯一', 'Unique field or combined key')}</option><option value="pattern">{t('受限表达式格式', 'Limited pattern')}</option><option value="arithmetic">{t('金额等于数量乘单价', 'Amount equals quantity times unit price')}</option><option value="reference">{t('值存在于参考数据', 'Value exists in reference dataset')}</option></select></label></div>
        {rule.kind === 'length' ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('最短字符数', 'Minimum characters')}<input type="number" min="0" max="100000" value={rule.min} onChange={(event) => updateRule(index, { min: event.target.value })} className={selectClass} /></label><label className="space-y-1 text-meta text-ink-3">{t('最长字符数', 'Maximum characters')}<input type="number" min="0" max="100000" value={rule.max} onChange={(event) => updateRule(index, { max: event.target.value })} className={selectClass} /></label></div> : null}
        {rule.kind === 'enum' ? <label className="block space-y-1 text-meta text-ink-3">{t('允许值，每行一个', 'Allowed values, one per line')}<textarea value={rule.values} onChange={(event) => updateRule(index, { values: event.target.value })} rows={4} className="block w-full rounded-control bg-surface p-2 text-cell text-ink shadow-rail" /></label> : null}
        {rule.kind === 'type' ? <label className="block space-y-1 text-meta text-ink-3">{t('类型', 'Type')}<select value={rule.dataType} onChange={(event) => updateRule(index, { dataType: event.target.value as DraftRule['dataType'] })} className={selectClass}><option value="integer">{t('整数文本', 'Integer text')}</option><option value="decimal">{t('十进制数文本', 'Decimal text')}</option><option value="date">{t('YYYY-MM-DD 日历日期', 'YYYY-MM-DD calendar date')}</option></select></label> : null}
        {rule.kind === 'range' ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('最小值，包含', 'Minimum, inclusive')}<input value={rule.min} onChange={(event) => updateRule(index, { min: event.target.value })} className={selectClass} /></label><label className="space-y-1 text-meta text-ink-3">{t('最大值，包含', 'Maximum, inclusive')}<input value={rule.max} onChange={(event) => updateRule(index, { max: event.target.value })} className={selectClass} /></label></div> : null}
        {rule.kind === 'date-order' ? <label className="block space-y-1 text-meta text-ink-3">{t('结束日期字段', 'End date field')}<select value={rule.otherColumnId} onChange={(event) => updateRule(index, { otherColumnId: event.target.value })} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label> : null}
        {rule.kind === 'pattern' ? <div className="space-y-2"><label className="block space-y-1 text-meta text-ink-3">{t('完整匹配表达式', 'Full-match pattern')}<input value={rule.pattern} maxLength={160} onChange={(event) => updateRule(index, { pattern: event.target.value })} className={selectClass} /></label><p className="text-meta text-ink-3">{t('支持普通字符、[A-Z] 等字符类及 {6} 等精确重复；不支持分组或可变次数。', 'Supports literal characters, character classes such as [A-Z] and exact repeats such as {6}. Groups and variable repeats are unsupported.')}</p></div> : null}
        {rule.kind === 'arithmetic' ? <div className="grid gap-3 sm:grid-cols-3"><label className="space-y-1 text-meta text-ink-3">{t('数量字段', 'Quantity field')}<select value={rule.leftColumnId} onChange={(event) => updateRule(index, { leftColumnId: event.target.value })} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('单价字段', 'Unit price field')}<select value={rule.rightColumnId} onChange={(event) => updateRule(index, { rightColumnId: event.target.value })} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('允许绝对差额', 'Allowed absolute difference')}<input value={rule.tolerance} onChange={(event) => updateRule(index, { tolerance: event.target.value })} className={selectClass} /></label><p className="text-meta text-ink-3 sm:col-span-3">{t('上方“字段”是要核对的金额；按原始十进制文本计算，不把解析失败当作零。', 'The field above is the amount to check. Calculation uses original decimal text and never treats parse errors as zero.')}</p></div> : null}
        {rule.kind === 'reference' ? <ReferenceFields rule={rule} candidates={referenceCandidates} update={(patch) => updateRule(index, patch)} /> : null}
        {rule.kind === 'unique' ? <div className="space-y-2"><p className="text-meta text-ink-3">{t('按选中字段组合查找全部重复成员；空键也会报告。', 'Find every duplicate member by the selected combined fields. Empty keys are reported too.')}</p><div className="flex flex-wrap gap-3">{schema.data?.columns.map((column) => <label key={column.id} className="flex items-center gap-1 text-cell text-ink-2"><input type="checkbox" checked={rule.columnIds.includes(column.id)} onChange={() => updateRule(index, { columnIds: rule.columnIds.includes(column.id) ? rule.columnIds.filter((id) => id !== column.id) : [...rule.columnIds, column.id] })} />{column.name}</label>)}</div></div> : null}
      </div>)}
      <Button variant="quiet" disabled={draftRules.length >= 20} onClick={() => { setDraftRules((items) => [...items, emptyRule()]); setKey(`quality_${crypto.randomUUID()}`) }}>{t('添加规则', 'Add rule')}</Button>
      <label className="block max-w-md space-y-1 text-meta text-ink-3">{t('输出内容', 'Output')}<select value={outputMode} onChange={(event) => { setOutputMode(event.target.value as typeof outputMode); setKey(`quality_${crypto.randomUUID()}`) }} className={selectClass}><option value="report">{t('异常明细报告', 'Violation details report')}</option><option value="valid">{t('仅有效记录副本', 'Copy of valid records only')}</option><option value="invalid">{t('仅异常记录副本', 'Copy of invalid records only')}</option></select></label>
      {outputMode === 'report' ? <p className="text-meta text-ink-3">{t('完整报告逐行列出所有违规记录；唯一键重复成员共享同一个重复组 ID，可按规则编号和组 ID 查看整组来源行。空键逐行列出。', 'The complete report lists every violating row. Members of a duplicate unique key share a group ID; use the rule number and group ID to find all source rows. Empty keys are listed row by row.')}</p> : null}
      {invalid ? <Banner tone="danger">{t('请检查规则参数：长度、允许值、数值范围或跨字段日期配置无效。', 'Check rule settings: length, allowed values, numeric range or cross-field date settings are invalid.')}</Banner> : null}
      <Button disabled={!selected || !schema.data || invalid || trial.isPending} onClick={() => trial.mutate()}>{t('检查前 200 行样本', 'Check first 200 rows')}</Button>
      {trial.error ? <Banner tone="danger" title={t('样本检查失败', 'Sample check failed')}>{trial.error.message}</Banner> : null}
      {trial.data?.signature === previewSignature ? <div className="space-y-2 rounded-control bg-surface-sunk p-3"><p className="text-cell text-ink-2">{t(`${trial.data.result.scope} 已检查 ${formatNumber(trial.data.result.summary.checkedRows)} 行，异常 ${formatNumber(trial.data.result.summary.failedRows)} 行，违规 ${formatNumber(trial.data.result.summary.violations)} 项。`, `First 200 input records, with unique keys counted only within the sample: ${formatNumber(trial.data.result.summary.checkedRows)} checked rows, ${formatNumber(trial.data.result.summary.failedRows)} failing rows and ${formatNumber(trial.data.result.summary.violations)} violations.`)}</p><div className="overflow-auto"><table className="w-full min-w-96 text-left text-meta"><thead><tr><th>{t('规则', 'Rule')}</th><th>{t('失败', 'Failures')}</th><th>{t('未检查', 'Not checked')}</th></tr></thead><tbody>{draftRules.map((rule, index) => <tr key={index}><td>{index + 1}. {t(kindLabel[rule.kind], kindLabelEn[rule.kind])}</td><td>{trial.data!.result.summary.ruleFailures[index] ?? 0}</td><td>{trial.data!.result.summary.ruleSkipped[index] ?? 0}</td></tr>)}</tbody></table></div>{trial.data.result.preview.rows.length ? <details><summary className="cursor-pointer text-accent-ink">{t('查看前 20 条异常明细', 'View first 20 violation details')}</summary><div className="mt-2 max-h-52 overflow-auto"><table className="min-w-full text-left text-meta"><thead><tr>{trial.data.result.preview.headers.map((header, index) => <th key={index} className="px-2">{header}</th>)}</tr></thead><tbody>{trial.data.result.preview.rows.map((row, index) => <tr key={index}>{row.map((value, at) => <td key={at} className="max-w-48 truncate px-2" title={value}>{value}</td>)}</tr>)}</tbody></table></div></details> : null}</div> : null}
      {submit.error ? <Banner tone="danger" title={t('检查未提交', 'Check was not submitted')}>{submit.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selected || !schema.data || invalid || submit.isPending} onClick={() => submit.mutate()}>{t('运行全表检查', 'Check complete dataset')}</Button>
    </Panel>
    <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('检查结果', 'Check results')} />
      {reportPage.isLoading ? <Spinner /> : null}
      {reportPage.error ? <Banner tone="danger">{reportPage.error.message}</Banner> : null}
      {reports.length === 0 && !reportPage.isLoading ? <p className="text-cell text-ink-3">{reportOffset || (reportPage.data?.total ?? 0) > 100 ? t('本段没有质量检查结果，可继续翻页。', 'No quality check results in this segment. Continue to another page.') : t('还没有已完成的质量检查。', 'No completed quality checks yet.')}</p> : reports.map((item) => {
        const summary = item.metadata.qualitySummary as { checkedRows?: number; failedRows?: number; violations?: number }
        return <div key={item.id} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-3 text-cell"><Link to="/datasets/$resourceId" params={{ resourceId: item.id }} className="min-w-0 flex-1 text-accent-ink hover:underline">{item.name}</Link><span className="figure text-meta text-ink-3">{t(`${formatNumber(summary.failedRows)} / ${formatNumber(summary.checkedRows)} 行异常 · ${formatNumber(summary.violations)} 项`, `${formatNumber(summary.failedRows)} / ${formatNumber(summary.checkedRows)} failing rows · ${formatNumber(summary.violations)} violations`)}</span><button type="button" onClick={() => { void api.downloadResource(item.id, item.name) }} className="cursor-pointer text-accent-ink hover:underline">{t('下载 CSV', 'Download CSV')}</button></div>
      })}
      <div className="flex items-center gap-2"><Button size="sm" disabled={reportOffset === 0} onClick={() => setReportOffset((value) => Math.max(0, value - 100))}>{t('上一段', 'Previous')}</Button><span className="text-meta text-ink-3">{t(`第 ${Math.floor(reportOffset / 100) + 1} 段`, `Segment ${Math.floor(reportOffset / 100) + 1}`)}</span><Button size="sm" disabled={reportOffset + 100 >= (reportPage.data?.total ?? 0)} onClick={() => setReportOffset((value) => value + 100)}>{t('下一段', 'Next')}</Button></div>
    </Panel>
  </PageBody></>
}

function ReferenceFields({ rule, candidates, update }: { rule: DraftRule;
  candidates: { id: string; name: string }[]; update: (patch: Partial<DraftRule>) => void }) {
  const t = useT()
  const referenceId = rule.referenceId
  const schema = useQuery({ queryKey: ['schema', referenceId], queryFn: () => api.schema(referenceId), enabled: Boolean(referenceId) })
  return <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('参考数据集', 'Reference dataset')}<select value={referenceId} onChange={(event) => update({ referenceId: event.target.value, referenceColumnId: 'c_0' })} className={selectClass}><option value="">{t('请选择', 'Select one')}</option>{candidates.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="space-y-1 text-meta text-ink-3">{t('参考字段', 'Reference field')}<select value={rule.referenceColumnId} disabled={!schema.data} onChange={(event) => update({ referenceColumnId: event.target.value })} className={selectClass}>{schema.data?.columns.map((column) => <option key={column.id} value={column.id}>{column.name}</option>)}</select></label>{schema.error ? <Banner tone="danger">{schema.error.message}</Banner> : null}<p className="text-meta text-ink-3 sm:col-span-2">{t('按参考数据固定版本的完整字段值检查；空的待检查值记为未检查，不自动判为存在。', 'Check against every value in the fixed version of the reference dataset. An empty checked value is marked untested and is not treated as present.')}</p></div>
}
