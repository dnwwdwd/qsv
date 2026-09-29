import { useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Recipe } from '@/api/client'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { getLocale, useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'
import { localizedStage } from '@/lib/stage'
import { localizedErrorMessage } from '@/lib/errors'

const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
const operationLabels: Record<string, string> = {
  filter: '全表筛选', clean: '字段清洗', 'clean-plan': '多步清洗', dedup: '按键去重', quality: '质量检查', analyze: '字段统计',
  export: '格式导出', split: '数据拆分', reshape: '数据重组', combine: '数据合并', relation: '按键关联', set: '集合运算', 'filter-plan': '组合筛选与排序', sql: '受限 SQL', compare: '双表核对', pipeline: '连续步骤',
}
const operationLabelsEn: Record<string, string> = {
  filter: 'Full dataset filter', clean: 'Field cleaning', 'clean-plan': 'Multistep cleaning', dedup: 'Deduplicate by key',
  quality: 'Quality check', analyze: 'Field statistics', export: 'Export format', split: 'Split data', reshape: 'Reshape data',
  combine: 'Combine data', relation: 'Join by key', set: 'Set operation', 'filter-plan': 'Combined filter and sort',
  sql: 'Restricted SQL', compare: 'Compare datasets', pipeline: 'Sequential steps',
}
const operationLabel = (operation: string) => getLocale() === 'en-US'
  ? operationLabelsEn[operation] ?? operation : operationLabels[operation] ?? operation
const jobStateLabel = (state: string) => getLocale() === 'en-US'
  ? ({ draft: 'Draft', queued: 'Queued', running: 'Running', cancel_requested: 'Cancelling', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' } as Record<string, string>)[state] ?? state
  : ({ draft: '草稿', queued: '排队中', running: '运行中', cancel_requested: '正在取消', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' } as Record<string, string>)[state] ?? state
function localizedRecipeFinding(message: string): string {
  if (getLocale() !== 'en-US' || !/[\p{Script=Han}]/u.test(message)) return message
  let match = /^模板记录的引擎版本为 (.+)，当前为 (.+)$/u.exec(message)
  if (match) return `Template engine version is ${match[1]}; current version is ${match[2]}`
  match = /^输入 (\d+) 的数据集不可用$/u.exec(message)
  if (match) return `Dataset for input ${match[1]} is unavailable`
  match = /^输入 (\d+) 缺少唯一字段：(.+)$/u.exec(message)
  if (match) return `Input ${match[1]} lacks a unique field: ${match[2]}`
  match = /^(SQL 规则|清洗规则|步骤) (\d+)：(.+)$/u.exec(message)
  if (match) return `${match[1] === '步骤' ? 'Step' : match[1] === 'SQL 规则' ? 'SQL rule' : 'Cleaning rule'} ${match[2]}: ${localizedRecipeFinding(match[3]!)}`
  match = /^步骤 (\d+) 的输入没有可追溯的空值来源$/u.exec(message)
  if (match) return `Input for step ${match[1]} has no traceable null origin`
  if (message === '导出行范围或字段选择无效') return 'The export row range or selected columns are invalid'
  if (message === '导出数据需要超过 20 张工作表，请增大每张工作表的行数') return 'The export needs more than 20 worksheets. Increase the rows per sheet.'
  if (message === '规则与输入不兼容') return 'The rule does not match the selected input'
  match = /^缺少唯一字段：(.+)$/u.exec(message)
  if (match) return `A unique field is missing: ${match[1]}`
  return 'The template cannot run with this input or these settings.'
}
const eligible = new Set(Object.keys(operationLabels))
const cleanValueFields: Record<string, string[]> = {
  text: ['find', 'replacement'], fill: ['value'], number: ['prefix', 'suffix'],
  add: ['value', 'separator'], filter: ['value'],
}
function cleanTemplateParameters(spec: Recipe['spec']) {
  const rules = spec.operation === 'pipeline' ? ((spec.steps as { enabled?: boolean; rule?: Record<string, unknown> }[] | undefined) ?? [])
    .filter((step) => step.enabled !== false).map((step) => step.rule).filter((rule) => rule?.operation === 'clean-plan') :
    spec.operation === 'clean-plan' ? [spec] : []
  const names = new Set<string>()
  for (const rule of rules) {
    const steps = (rule?.plan as { steps?: Record<string, unknown>[] } | undefined)?.steps ?? []
    for (const step of steps) {
      if (step.enabled === false) continue
      for (const field of cleanValueFields[String(step.type)] ?? []) {
        const value = step[field]
        if (typeof value === 'string') for (const match of value.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/gu)) names.add(match[1]!)
      }
    }
  }
  return [...names]
}

interface DraftPipelineStep { id: string; recipeId: string; inputRefs: string[]; enabled: boolean; expose: boolean }

function PipelineComposer({ recipes, onChanged }: { recipes: Recipe[]; onChanged: () => void }) {
  const t = useT()
  const [name, setName] = useSessionDraft('PipelineComposer.name', '')
  const [description, setDescription] = useSessionDraft('PipelineComposer.description', '')
  const [inputs, setInputs] = useSessionDraft('PipelineComposer.inputs', [{ name: getLocale() === 'en-US' ? 'Input dataset' : '输入数据集', requiredHeaders: '' }])
  const [steps, setSteps] = useSessionDraft<DraftPipelineStep[]>('PipelineComposer.steps', [])
  const available = recipes.filter((recipe) => recipe.spec.operation !== 'pipeline')
  const fileOperations = new Set(['export', 'split'])
  const recipeById = (id: string) => available.find((item) => item.id === id)
  const refsAt = (index: number) => [
    ...inputs.map((input, at) => ({ value: `input:${at}`, label: t(`输入 ${at + 1} · ${input.name || '未命名'}`, `Input ${at + 1} · ${input.name || 'Unnamed'}`) })),
    ...steps.slice(0, index).map((step, at) => ({ step, at })).filter(({ step }) =>
      step.enabled && !fileOperations.has(recipeById(step.recipeId)?.spec.operation ?? '')).map(({ step, at }) =>
      ({ value: `step:${step.id}`, label: t(`步骤 ${at + 1} · ${recipeById(step.recipeId)?.name ?? '模板不可用'}`, `Step ${at + 1} · ${recipeById(step.recipeId)?.name ?? 'Template unavailable'}`) })),
  ]
  const issues = steps.flatMap((step, index) => {
    const recipe = recipeById(step.recipeId)
    if (!recipe) return [t(`步骤 ${index + 1} 的模板已不可用`, `Step ${index + 1} uses an unavailable template`)]
    const expected = recipe.compatibility.inputCount ?? 1
    if (step.inputRefs.length !== expected) return [t(`步骤 ${index + 1} 需要 ${expected} 个输入`, `Step ${index + 1} needs ${expected} inputs`)]
    const refs = new Set(refsAt(index).map((item) => item.value))
    if (step.inputRefs.some((ref) => !refs.has(ref))) return [t(`步骤 ${index + 1} 引用了后续、已删除或文件型步骤的结果`, `Step ${index + 1} references a later, deleted or file-producing step`)]
    if (new Set(step.inputRefs).size !== step.inputRefs.length) return [t(`步骤 ${index + 1} 的多个输入不能引用同一结果`, `Step ${index + 1} cannot use the same result for multiple inputs`)]
    return []
  })
  const save = useMutation({ mutationFn: () => {
    const lastEnabled = [...steps].reverse().find((step) => step.enabled)
    if (!lastEnabled || issues.length) throw new Error(issues[0] ?? t('请至少启用一个有效步骤', 'Enable at least one valid step'))
    const spec = { version: 1, operation: 'pipeline',
      inputs: inputs.map((input) => ({ name: input.name.trim(), requiredHeaders: input.requiredHeaders.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean) })),
      steps: steps.map((step) => ({ id: step.id, enabled: step.enabled, inputs: step.inputRefs, rule: recipeById(step.recipeId)!.spec })),
      output: `step:${lastEnabled.id}`,
      outputs: [...new Set([...steps.filter((step) => step.enabled && step.expose).map((step) => `step:${step.id}`), `step:${lastEnabled.id}`])] }
    return api.importRecipe({ format: 'qsv-recipe-v1', name, description, spec })
  }, onSuccess: () => { setName(''); setDescription(''); setInputs([{ name: getLocale() === 'en-US' ? 'Input dataset' : '输入数据集', requiredHeaders: '' }]); setSteps([]); onChanged() } })
  const addStep = () => {
    const recipe = available[0]
    if (!recipe) return
    const count = recipe.compatibility.inputCount ?? 1
    const refs = refsAt(steps.length)
    setSteps((current) => [...current, { id: `s${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, recipeId: recipe.id, enabled: true, expose: false,
      inputRefs: Array.from({ length: count }, (_, at) => refs[Math.min(at, refs.length - 1)]?.value ?? 'input:0') }])
  }
  const move = (index: number, direction: -1 | 1) => {
    const next = [...steps], other = index + direction
    if (other < 0 || other >= next.length) return
    ;[next[index], next[other]] = [next[other]!, next[index]!]
    setSteps(next)
  }
  return <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('组合流程步骤', 'Compose pipeline steps')} />
    <p className="text-cell text-ink-3">{t('可为流程指定多个输入和结果。每一步选择现有工具模板，再明确选择输入槽位或前面步骤的结果。运行时按显示顺序提交，已完成步骤的结果保留在任务记录中。', 'A pipeline can have multiple inputs and outputs. Choose an existing tool template for each step, then select an input slot or an earlier result. Steps run in displayed order, and completed results remain in the job record.')}</p>
    <div className="grid gap-3 sm:grid-cols-2"><label className="text-meta text-ink-3">{t('流程名称', 'Pipeline name')}<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className={selectClass} /></label><label className="text-meta text-ink-3">{t('说明', 'Description')}<input value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} className={selectClass} /></label></div>
    <div className="space-y-2"><strong className="text-cell text-ink">{t('输入槽位', 'Input slots')}</strong>{inputs.map((input, index) => <div key={index} className="grid gap-2 rounded-control bg-surface-sunk p-3 sm:grid-cols-[1fr_2fr_auto]"><label className="text-meta text-ink-2">{t('名称', 'Name')}<input value={input.name} maxLength={120} onChange={(event) => setInputs((current) => current.map((value, at) => at === index ? { ...value, name: event.target.value } : value))} className={selectClass} /></label><label className="text-meta text-ink-2">{t('必需字段（每行一个）', 'Required fields (one per line)')}<textarea rows={2} value={input.requiredHeaders} onChange={(event) => setInputs((current) => current.map((value, at) => at === index ? { ...value, requiredHeaders: event.target.value } : value))} className="block w-full rounded-control bg-surface px-2 py-1 text-cell shadow-rail" /></label><Button size="sm" variant="quiet" disabled={inputs.length === 1 || index !== inputs.length - 1} onClick={() => setInputs((current) => current.slice(0, -1))}>{t('移除', 'Remove')}</Button></div>)}<Button size="sm" disabled={inputs.length >= 20} onClick={() => setInputs((current) => [...current, { name: t(`输入 ${current.length + 1}`, `Input ${current.length + 1}`), requiredHeaders: '' }])}>{t('添加输入槽位', 'Add input slot')}</Button></div>
    <ol className="space-y-3">{steps.map((step, index) => {
      const recipe = recipeById(step.recipeId)
      const refs = refsAt(index)
      return <li key={step.id} className="space-y-3 rounded-control bg-surface-sunk p-3"><div className="flex flex-wrap items-center gap-2"><span className="figure w-6 text-cell text-accent-ink">{index + 1}</span><select aria-label={t(`步骤 ${index + 1} 的模板`, `Template for step ${index + 1}`)} value={step.recipeId} onChange={(event) => {
        const next = recipeById(event.target.value)
        const count = next?.compatibility.inputCount ?? 1
        setSteps((current) => current.map((item, at) => at === index ? { ...item, recipeId: event.target.value,
          inputRefs: Array.from({ length: count }, (_, position) => item.inputRefs[position] ?? refs[Math.min(position, refs.length - 1)]?.value ?? 'input:0') } : item))
      }} className="h-9 min-w-40 flex-1 rounded-control bg-surface px-2 text-cell">{available.map((item) => <option key={item.id} value={item.id}>{item.name} · {operationLabel(item.spec.operation)}</option>)}</select><Button size="sm" variant="quiet" onClick={() => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, enabled: !item.enabled } : item))}>{step.enabled ? t('关闭此步', 'Disable step') : t('启用此步', 'Enable step')}</Button><Button size="sm" variant="quiet" disabled={index === 0} onClick={() => move(index, -1)}>{t('上移', 'Move up')}</Button><Button size="sm" variant="quiet" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>{t('下移', 'Move down')}</Button><Button size="sm" variant="quiet" onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}>{t('移除', 'Remove')}</Button></div><p className="text-meta text-ink-3">{t(step.enabled ? '已启用' : '已关闭', step.enabled ? 'Enabled' : 'Disabled')}{t('；预计输出：', '; expected output: ')}{fileOperations.has(recipe?.spec.operation ?? '') ? t('文件', 'file') : t('数据集', 'dataset')}{t(`；所需输入：${recipe?.compatibility.inputCount ?? 1} 份。`, `; required inputs: ${recipe?.compatibility.inputCount ?? 1}.`)}</p><label className="flex items-center gap-2 text-meta text-ink-2"><input type="checkbox" checked={step.expose} disabled={!step.enabled} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item, expose: event.target.checked } : item))} />{t('将此步骤列为流程结果', 'Expose this step as a pipeline result')}</label><div className="grid gap-2 sm:grid-cols-2">{step.inputRefs.map((ref, position) => <label key={position} className="text-meta text-ink-2">{t(`输入 ${position + 1}`, `Input ${position + 1}`)}<select value={ref} onChange={(event) => setSteps((current) => current.map((item) => item.id === step.id ? { ...item,
          inputRefs: item.inputRefs.map((value, at) => at === position ? event.target.value : value) } : item))} className={selectClass}>{!refs.some((item) => item.value === ref) ? <option value={ref}>{t('引用已失效：', 'Invalid reference: ')}{ref}</option> : null}{refs.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>)}</div></li>
    })}</ol>
    {issues.map((issue) => <Banner key={issue} tone="warning">{issue}</Banner>)}
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!available.length || steps.length >= 64} onClick={addStep}>{t('添加步骤', 'Add step')}</Button><Button size="sm" variant="primary" disabled={!name.trim() || !steps.some((step) => step.enabled) || issues.length > 0 || inputs.some((input) => !input.name.trim()) || save.isPending} onClick={() => save.mutate()}>{t('保存流程模板', 'Save pipeline template')}</Button></div>
    {save.error ? <Banner tone="danger" title={t('流程未保存', 'Pipeline was not saved')}>{localizedRecipeFinding(save.error.message)}</Banner> : null}
  </Panel>
}

function RecipeCard({ recipe, resources, onChanged }: {
  recipe: Recipe; resources: { id: string; name: string; rowCount: number | null }[]; onChanged: () => void
}) {
  const t = useT()
  const navigate = useNavigate()
  const [name, setName] = useState(recipe.name)
  const [description, setDescription] = useState(recipe.description)
  const [specText, setSpecText] = useState(() => JSON.stringify(recipe.spec, null, 2))
  const [showVersions, setShowVersions] = useState(false)
  const [runVersionId, setRunVersionId] = useState(recipe.id)
  const versions = useQuery({ queryKey: ['recipeVersions', recipe.id], queryFn: () => api.recipeVersions(recipe.id), enabled: showVersions })
  const [resourceSearch, setResourceSearch] = useState('')
  const [resourceSearchOffset, setResourceSearchOffset] = useState(0)
  const resourceMatches = useQuery({ queryKey: ['recipe-resource-search', resourceSearch.trim(), resourceSearchOffset],
    queryFn: () => api.findResources({ name: resourceSearch.trim(), kind: 'dataset', status: 'ready' }, resourceSearchOffset, 100),
    enabled: Boolean(resourceSearch.trim()) })
  const [groups, setGroups] = useSessionDraft<string[][]>(`RecipeCard.${recipe.id}.groups`, [Array.from({ length: recipe.compatibility.inputCount ?? 1 }, () => '')])
  const [parameterValues, setParameterValues] = useSessionDraft<Record<string, string>>(`RecipeCard.${recipe.id}.parameterValues`, {})
  const selectedIds = [...new Set(groups.flat().filter(Boolean))]
  const selectedResources = useQueries({ queries: selectedIds.map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const availableResources = [...new Map([...(resourceSearch.trim() ? resourceMatches.data?.items ?? [] : resources), ...selectedResources.flatMap((query) => query.data?.kind === 'dataset' &&
    query.data.status === 'ready' ? [{ id: query.data.id, name: query.data.name, rowCount: query.data.rowCount }] : [])]
    .map((item) => [item.id, item] as const)).values()]
  const [key, setKey] = useState(() => `recipe_${crypto.randomUUID()}`)
  const version = useMutation({ mutationFn: () => api.versionRecipe(recipe.id, name, description, recipe.updatedAt, JSON.parse(specText) as unknown), onSuccess: onChanged })
  const copy = useMutation({ mutationFn: () => api.copyRecipe(recipe.id, t(`${name} 副本`, `${name} copy`)), onSuccess: onChanged })
  const remove = useMutation({ mutationFn: () => api.deleteRecipe(recipe.id, recipe.updatedAt), onSuccess: onChanged })
  const selectedVersion = versions.data?.find((item) => item.id === runVersionId) ?? recipe
  const inputCount = selectedVersion.compatibility.inputCount ?? 1
  const preflightSignature = JSON.stringify({ versionId: runVersionId, groups, parameterValues })
  const preflight = useMutation({ mutationFn: async () => ({ signature: preflightSignature,
    results: await Promise.all(groups.map((group) => api.recipePreflight(runVersionId, group, parameterValues))) }) })
  const preflightReady = preflight.data?.signature === preflightSignature && preflight.data.results.every((result) => result.ready)
  const trial = useMutation({ mutationFn: async () => {
    const signature = preflightSignature
    const results = []
    for (const group of groups) results.push(await api.recipeTrial(runVersionId, group, parameterValues))
    return { signature, results }
  } })
  const trialReady = trial.data?.signature === preflightSignature && trial.data.results.every((result) => result.ready)
  const sqlRules = selectedVersion.spec.operation === 'pipeline' ? ((selectedVersion.spec.steps as { enabled?: boolean; rule?: Record<string, unknown> }[] | undefined) ?? []).filter((step) => step.enabled !== false).map((step) => step.rule).filter((rule) => rule?.operation === 'sql') : selectedVersion.spec.operation === 'sql' ? [selectedVersion.spec] : []
  const parameterDefinitions = [...new Map([...sqlRules.flatMap((rule) => (rule?.parameterDefinitions as { name: string; type: string }[] | undefined) ?? []),
    ...cleanTemplateParameters(selectedVersion.spec).map((name) => ({ name, type: 'text' }))]
    .map((item) => [item.name, item] as const)).values()]
  const run = useMutation({ mutationFn: () => api.runRecipeBatch(runVersionId, groups, key,
    Object.fromEntries(parameterDefinitions.map((item) => [item.name, parameterValues[item.name] ?? '']))), onSuccess: (result) => {
    void navigate({ to: '/recipes/batches/$batchId', params: { batchId: result.batch.id } })
  } })
  const updateGroup = (groupIndex: number, slotIndex: number, value: string) => {
    setGroups((current) => current.map((group, at) => at === groupIndex ? group.map((id, slot) => slot === slotIndex ? value : id) : group))
    setKey(`recipe_${crypto.randomUUID()}`)
  }
  const exportRecipe = () => {
    const payload = JSON.stringify({ format: 'qsv-recipe-v1', name: recipe.name, description: recipe.description, spec: recipe.spec }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `qsv-recipe-${recipe.id}.json`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return <Panel className="space-y-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-title font-semibold text-ink">{recipe.name}</h2><p className="mt-1 text-meta text-ink-3">{operationLabel(recipe.spec.operation)}{t(` · 版本 ${recipe.version} · ${inputCount} 个输入槽位`, ` · version ${recipe.version} · ${inputCount} input slots`)}</p>{recipe.description ? <p className="mt-1 text-cell text-ink-2">{recipe.description}</p> : null}</div></div>
    <details className="space-y-3"><summary className="cursor-pointer text-cell text-accent-ink">{t('编辑并保存新版本', 'Edit and save a new version')}</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('名称', 'Name')}<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className={selectClass} /></label><label className="space-y-1 text-meta text-ink-3">{t('说明', 'Description')}<input value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} className={selectClass} /></label></div><label className="mt-3 block space-y-1 text-meta text-ink-3">{t('规则 JSON', 'Rule JSON')}<textarea value={specText} spellCheck={false} onChange={(event) => setSpecText(event.target.value)} rows={9} className="w-full rounded-control bg-surface p-3 font-mono text-cell text-ink shadow-rail" /></label><p className="text-meta text-ink-3">{t('保存时会检查字段名、步骤依赖和操作范围。清洗模板可在查找、替换、填充值、常量、分隔文本及筛选值中写入', 'Saving checks field names, step dependencies and operation scope. Cleaning templates can use')} {'{{名称}}'}{t('，运行前填写对应参数。旧版本及已运行任务保留原规则。', ' for find, replacement, fill, constant, separator and filter values. Enter parameters before running. Old versions and jobs retain their original rules.')}</p><div className="mt-3 flex flex-wrap gap-2"><Button disabled={!name.trim() || version.isPending} onClick={() => version.mutate()}>{t('保存为新版本', 'Save as new version')}</Button><Button variant="quiet" disabled={copy.isPending} onClick={() => copy.mutate()}>{t('复制模板', 'Copy template')}</Button><Button variant="quiet" onClick={exportRecipe}>{t('导出模板 JSON', 'Export template JSON')}</Button><Button variant="quiet" disabled={remove.isPending} onClick={() => remove.mutate()}>{t('删除模板', 'Delete template')}</Button></div>{version.error || copy.error || remove.error ? <Banner tone="danger">{(version.error ?? copy.error ?? remove.error)?.message}</Banner> : null}</details>
    <div className="space-y-3 border-t border-hairline-soft pt-4"><SectionTitle title={t('替换输入并运行', 'Replace inputs and run')} /><p className="text-meta text-ink-3">{t('每组独立创建任务。提交前会按字段名称检查新数据集；缺列、重复列名或不可用资源会显示为该组失败。模板修改不会改变旧任务的规则。', 'Each group creates its own job. Before submission, new datasets are checked by field name. Missing or duplicate fields and unavailable resources fail that group. Editing a template does not change older jobs.')}</p>
      <DraftInputWarning ids={selectedIds} availableIds={availableResources.map((item) => item.id)} loading={selectedResources.some((query) => query.isLoading)} />
      <Button variant="quiet" size="sm" onClick={() => setShowVersions((value) => !value)}>{showVersions ? t('收起版本', 'Hide versions') : t('查看并选择版本', 'View and select version')}</Button>
      {showVersions ? versions.isLoading ? <Spinner /> : versions.error ? <Banner tone="danger">{versions.error.message}</Banner> : <label className="block space-y-1 text-meta text-ink-3">{t('运行版本', 'Version to run')}<select value={runVersionId} onChange={(event) => { const next = versions.data?.find((item) => item.id === event.target.value); setRunVersionId(event.target.value); setGroups((current) => current.map((group) => Array.from({ length: next?.compatibility.inputCount ?? 1 }, (_, index) => group[index] ?? ''))); setKey(`recipe_${crypto.randomUUID()}`) }} className={selectClass}>{versions.data?.map((item) => <option key={item.id} value={item.id}>{t(`版本 ${item.version}`, `Version ${item.version}`)} · {item.name}</option>)}</select></label> : null}
      {parameterDefinitions.length ? <div className="space-y-2 rounded-control bg-surface-sunk p-3"><strong className="text-cell">{t('本次运行的参数', 'Parameters for this run')}</strong>{parameterDefinitions.map((definition) => <label key={definition.name} className="block space-y-1 text-meta">{definition.name} · {definition.type}<input value={parameterValues[definition.name] ?? ''} maxLength={1024} onChange={(event) => { setParameterValues((current) => ({ ...current, [definition.name]: event.target.value })); setKey(`recipe_${crypto.randomUUID()}`) }} className={selectClass} /></label>)}</div> : null}
      <div className="space-y-2"><label className="block max-w-sm space-y-1 text-meta text-ink-3">{t('按名称查找输入数据集', 'Find input dataset by name')}<input type="search" value={resourceSearch} onChange={(event) => { setResourceSearch(event.target.value); setResourceSearchOffset(0) }} placeholder={t('可查找列表第一页以外的数据集', 'Search beyond the first resource page')} className={selectClass} /></label>{resourceSearch.trim() ? <div className="flex items-center gap-2"><Button size="sm" disabled={resourceSearchOffset === 0} onClick={() => setResourceSearchOffset((value) => Math.max(0, value - 100))}>{t('上一段', 'Previous')}</Button><span className="text-meta text-ink-3">{t(`${formatNumber(resourceMatches.data?.total)} 项匹配`, `${formatNumber(resourceMatches.data?.total)} matches`)}</span><Button size="sm" disabled={resourceSearchOffset + 100 >= (resourceMatches.data?.total ?? 0)} onClick={() => setResourceSearchOffset((value) => value + 100)}>{t('下一段', 'Next')}</Button></div> : null}</div>
      {groups.map((group, groupIndex) => <div key={groupIndex} className="rounded-control bg-surface-sunk p-3"><div className="mb-2 flex items-center justify-between"><strong className="text-cell text-ink">{t(`第 ${groupIndex + 1} 组`, `Group ${groupIndex + 1}`)}</strong><Button variant="quiet" size="sm" disabled={groups.length === 1} onClick={() => { setGroups((items) => items.filter((_, at) => at !== groupIndex)); setKey(`recipe_${crypto.randomUUID()}`) }}>{t('移除', 'Remove')}</Button></div><div className="grid gap-2 sm:grid-cols-2">{group.map((id, slotIndex) => <label key={slotIndex} className="space-y-1 text-meta text-ink-3">{t(`输入 ${slotIndex + 1}`, `Input ${slotIndex + 1}`)}<select value={id} onChange={(event) => updateGroup(groupIndex, slotIndex, event.target.value)} className={selectClass}><option value="">{t('请选择数据集', 'Select a dataset')}</option>{id && !availableResources.some((item) => item.id === id) ? <option value={id} disabled>{t(`原数据集不可用：${id}`, `Previous dataset unavailable: ${id}`)}</option> : null}{availableResources.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label>)}</div></div>)}
      <div className="space-y-2 rounded-control border border-line p-3"><p className="text-cell font-medium">{t('运行前检查', 'Check before running')}</p><p className="text-meta text-ink-3">{t('检查输入版本、必需字段及直接使用原始输入的步骤。依赖前一步输出的步骤需在运行时以真实结果继续检查；这里不是样本试跑。', 'Check input versions, required fields and steps using original inputs directly. Steps depending on earlier outputs are checked against real results at runtime. This check is not a sample run.')}</p><Button size="sm" disabled={groups.some((group) => group.some((id) => !id) || new Set(group).size !== group.length) || preflight.isPending} onClick={() => preflight.mutate()}>{preflight.isPending ? t('正在检查…', 'Checking…') : t('检查全部输入组', 'Check all input groups')}</Button>{preflight.error ? <Banner tone="danger">{localizedRecipeFinding(preflight.error.message)}</Banner> : null}{preflight.data?.signature === preflightSignature ? preflight.data.results.map((result, index) => <div key={index} className="text-meta text-ink-2"><p>{t(`第 ${index + 1} 组：`, `Group ${index + 1}: `)}{result.ready ? t('已通过可预先检查的项目', 'Preflight checks passed') : t('发现问题', 'Issues found')}{t(`；已检查 ${result.checkedSteps} 步，运行时检查 ${result.deferredSteps} 步。`, `; ${result.checkedSteps} steps checked, ${result.deferredSteps} deferred to runtime.`)}</p>{result.problems.map((problem) => <p key={problem} className="text-danger-ink">{localizedRecipeFinding(problem)}</p>)}</div>) : <p className="text-meta text-ink-3">{t('当前输入尚未检查。', 'Current inputs have not been checked.')}</p>}</div>
      <div className="space-y-2 rounded-control border border-line p-3"><p className="text-cell font-medium">{t('样本试跑', 'Sample run')}</p><p className="text-meta text-ink-3">{t('通常每份输入取前 200 条记录；单步固定范围导出会从所选范围取前 200 条。所有启用步骤在隔离工作区执行。样本成功不代表完整数据一定成功；输入或参数变化后需重新试跑。', 'Usually the first 200 records of each input are sampled. A single export with a fixed range samples its first 200 selected records. Enabled steps run in an isolated workspace. Sample success does not guarantee full-data success. Run the sample again after changing inputs or parameters.')}</p><Button size="sm" disabled={!preflightReady || trial.isPending} onClick={() => trial.mutate()}>{trial.isPending ? t('正在试跑…', 'Running sample…') : t('试跑全部输入组', 'Run sample for all groups')}</Button>{trial.error ? <Banner tone="danger">{localizedRecipeFinding(trial.error.message)}</Banner> : null}{trial.data?.signature === preflightSignature ? trial.data.results.map((result, index) => <div key={index} className="space-y-1 rounded-control bg-surface-sunk p-2 text-meta text-ink-2"><p>{t(`第 ${index + 1} 组：`, `Group ${index + 1}: `)}{result.ready ? t('样本步骤已完成', 'Sample steps completed') : t(`试跑失败：${result.error ?? '查看步骤错误'}`, `Sample failed: ${result.error ? localizedRecipeFinding(result.error) : 'see step errors'}`)}{t(`；各输入样本行数 ${result.sampledRows.map(formatNumber).join(' / ')}`, `; sampled rows per input: ${result.sampledRows.map(formatNumber).join(' / ')}`)}</p>{result.steps.map((step, stepIndex) => <p key={`${step.id}-${stepIndex}`}>{t(`步骤 ${stepIndex + 1}`, `Step ${stepIndex + 1}`)} · {operationLabel(step.operation)}{t('：', ': ')}{jobStateLabel(step.state)}{t(`；输入 ${formatNumber(step.rowsIn)} 行，输出 ${step.rowsOut ?? '文件'}`, `; input ${formatNumber(step.rowsIn)} rows, output ${step.rowsOut === null || step.rowsOut === undefined ? 'file' : formatNumber(step.rowsOut)} rows`)}{step.error ? t(`；${step.error}`, `; ${localizedRecipeFinding(step.error)}`) : ''}</p>)}{result.preview ? <div className="max-h-56 overflow-auto"><table className="min-w-full text-left text-meta"><thead><tr>{result.preview.headers.map((header, at) => <th key={at} className="border-b border-line px-2 py-1">{header}</th>)}</tr></thead><tbody>{result.preview.rows.map((row, at) => <tr key={at}>{row.map((cell, cellAt) => <td key={cellAt} className="max-w-40 truncate border-b border-hairline-soft px-2 py-1" title={cell}>{cell}</td>)}</tr>)}</tbody></table></div> : null}</div>) : <p className="text-meta text-ink-3">{t('当前输入尚未试跑。', 'Current inputs have not had a sample run.')}</p>}</div>
      <div className="flex flex-wrap gap-2"><Button disabled={groups.length >= 20} onClick={() => { setGroups((items) => [...items, Array.from({ length: inputCount }, () => '')]); setKey(`recipe_${crypto.randomUUID()}`) }}>{t('添加一组', 'Add group')}</Button><Button variant="primary" disabled={run.isPending || !preflightReady || !trialReady} onClick={() => run.mutate()}>{t(`运行 ${groups.length} 组`, `Run ${groups.length} groups`)}</Button></div>
      {run.error ? <Banner tone="danger" title={t('批量任务未提交', 'Batch job was not submitted')}>{run.error.message}</Banner> : null}
    </div>
  </Panel>
}

export function RecipesPage() {
  const t = useT()
  const { sourceJobId } = useSearch({ from: '/recipes' })
  const client = useQueryClient()
  const recipes = useQuery({ queryKey: ['recipes'], queryFn: api.recipes })
  const resources = useQuery({ queryKey: ['recipes', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const jobs = useQuery({ queryKey: ['recipes', 'jobs'], queryFn: () => api.jobPage(0, 100) })
  const [jobCursor, setJobCursor] = useState('')
  const [previousJobCursors, setPreviousJobCursors] = useState<string[]>([])
  const sourceJobPage = useQuery({ queryKey: ['recipes', 'source-jobs', jobCursor], queryFn: () => api.jobCursorPage(jobCursor, 100) })
  const pinnedJob = useQuery({ queryKey: ['job', sourceJobId], queryFn: () => api.job(sourceJobId!), enabled: Boolean(sourceJobId) })
  const datasets = resources.data?.items.filter((item) => item.kind === 'dataset' && item.status === 'ready') ?? []
  const sourceJobs = [
    ...(pinnedJob.data && eligible.has(pinnedJob.data.kind) && ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(pinnedJob.data.state) ? [pinnedJob.data] : []),
    ...(sourceJobPage.data?.items.filter((job) => job.id !== pinnedJob.data?.id && eligible.has(job.kind) &&
      ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(job.state)) ?? []),
  ]
  const [jobId, setJobId] = useState(sourceJobId ?? '')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [templateSearch, setTemplateSearch] = useState('')
  const [includeHistory, setIncludeHistory] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const selected = jobId || sourceJobs[0]?.id || ''
  const selectedJob = sourceJobs.find((job) => job.id === selected)
  const canIncludeHistory = selectedJob?.state === 'succeeded'
  const create = useMutation({ mutationFn: () => api.recipeFromJob(selected, name, description, Boolean(includeHistory && canIncludeHistory)), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['recipes'] })
    setName(''); setDescription('')
  } })
  const importMutation = useMutation({ mutationFn: async () => {
    if (!importFile || importFile.size > 256 * 1024) throw new Error(t('请选择不超过 256 KiB 的模板文件', 'Select a template file no larger than 256 KiB'))
    const raw = JSON.parse(await importFile.text()) as Record<string, unknown>
    if (raw.format !== 'qsv-recipe-v1' || typeof raw.name !== 'string' || typeof raw.description !== 'string') {
      throw new Error(t('模板文件格式无效', 'Invalid template file format'))
    }
    return api.importRecipe({ format: 'qsv-recipe-v1', name: raw.name, description: raw.description, spec: raw.spec })
  }, onSuccess: () => { setImportFile(null); void client.invalidateQueries({ queryKey: ['recipes'] }) } })
  const batches = jobs.data?.items.filter((job) => job.kind === 'batch') ?? []
  const visibleRecipes = recipes.data?.filter((recipe) => {
    const query = templateSearch.trim().toLocaleLowerCase(getLocale())
    if (!query) return true
    return [recipe.name, recipe.description, operationLabel(recipe.spec.operation), recipe.spec.operation]
      .some((value) => value.toLocaleLowerCase(getLocale()).includes(query))
  }) ?? []
  return <><PageTopBar title={t('模板与流程', 'Templates and pipelines')} /><PageBody className="space-y-4">
    <Banner tone="info">{t('从已有任务保存可复用的规则，换用新数据集时按字段名核对。批量运行时每组独立执行，失败组可单独修正后再试。', 'Save reusable rules from existing jobs and check field names when replacing datasets. Batch groups run independently, and a failed group can be corrected and retried.')}</Banner>
    <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('从现有任务创建模板', 'Create a template from a job')} />
      {sourceJobPage.isLoading || pinnedJob.isLoading ? <Spinner /> : null}
      {sourceJobPage.error ? <Banner tone="danger" title={t('任务读取失败', 'Could not load jobs')}>{sourceJobPage.error.message}</Banner> : null}
      {sourceJobId && (pinnedJob.error || (pinnedJob.data && !sourceJobs.some((job) => job.id === sourceJobId))) ? <Banner tone="danger" title={t('指定任务不可用于保存模板', 'This job cannot become a template')}>{t('请选择已结束且支持模板的任务。', 'Select a completed or stopped job from a supported tool.')}</Banner> : null}
      {sourceJobs.length === 0 && !sourceJobPage.isLoading ? <p className="text-cell text-ink-3">{jobCursor || sourceJobPage.data?.nextCursor ? t('本段没有可保存为模板的任务，可继续查看前后段。', 'No eligible jobs in this segment. Check adjacent segments.') : t('还没有可保存为模板的任务。先运行一次清洗、筛选、去重、合并、核对、质量检查、统计、导出或 SQL。', 'No eligible jobs yet. First run a cleaning, filtering, deduplication, combining, comparison, quality, analysis, export or SQL job.')}</p> : null}
      <label className="block space-y-1 text-meta text-ink-3">{t('原任务', 'Source job')}<select value={selected} onChange={(event) => { setJobId(event.target.value); const job = sourceJobs.find((item) => item.id === event.target.value); if (job) setName(t(`${job.name} 模板`, `${job.name} template`)) }} className={selectClass}>{sourceJobs.map((job) => <option key={job.id} value={job.id}>{job.name} · {jobStateLabel(job.state)}</option>)}</select></label>
      <div className="flex items-center gap-2"><Button size="sm" disabled={previousJobCursors.length === 0} onClick={() => { setJobId(''); setJobCursor(previousJobCursors[previousJobCursors.length - 1]!); setPreviousJobCursors((current) => current.slice(0, -1)) }}>{t('上一段任务', 'Previous jobs')}</Button><span className="text-meta text-ink-3">{t(`第 ${previousJobCursors.length + 1} 段`, `Segment ${previousJobCursors.length + 1}`)}</span><Button size="sm" disabled={!sourceJobPage.data?.nextCursor} onClick={() => { setJobId(''); setPreviousJobCursors((current) => [...current, jobCursor]); setJobCursor(sourceJobPage.data!.nextCursor!) }}>{t('下一段任务', 'Next jobs')}</Button></div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-3">{t('模板名称', 'Template name')}<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className={selectClass} /></label><label className="space-y-1 text-meta text-ink-3">{t('说明', 'Description')}<input value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} className={selectClass} /></label></div>
      <label className="flex items-start gap-2 text-cell text-ink-2"><input type="checkbox" checked={Boolean(includeHistory && canIncludeHistory)} disabled={!canIncludeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} /><span>{t('包含此任务之前的连续处理步骤。仅使用已完成且可追溯的处理结果；多个来源会成为多个输入槽位。', 'Include earlier consecutive processing steps. Only completed, traceable results are used, and multiple sources become multiple input slots.')}{!canIncludeHistory ? t(' 失败或中断的任务仍可单独保存规则；连续历史只适用于已完成任务。', ' You can still save rules from a failed or interrupted job. Full history requires a completed job.') : null}</span></label>
      {create.error ? <Banner tone="danger" title={t('模板未创建', 'Template was not created')}>{create.error.message}</Banner> : null}
      <Button variant="primary" disabled={!selectedJob || !name.trim() || create.isPending} onClick={() => create.mutate()}>{t('保存模板', 'Save template')}</Button>
    </Panel>
    <PipelineComposer recipes={recipes.data ?? []} onChanged={() => void client.invalidateQueries({ queryKey: ['recipes'] })} />
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('导入模板', 'Import template')} /><p className="text-cell text-ink-3">{t('选择此前导出的 qsv 模板 JSON。导入后需要重新选择本人数据集运行，文件中不保存原始数据或本机路径。', 'Select a previously exported qsv template JSON file. After importing, select your own datasets again. The file contains no original data or local paths.')}</p><input type="file" accept=".json,application/json" onChange={(event) => setImportFile(event.target.files?.[0] ?? null)} className="block max-w-full text-cell text-ink-2" /><Button disabled={!importFile || importMutation.isPending} onClick={() => importMutation.mutate()}>{t('导入并检查模板', 'Import and check template')}</Button>{importMutation.error ? <Banner tone="danger">{importMutation.error.message}</Banner> : null}</Panel>
    <section className="max-w-4xl space-y-3"><SectionTitle title={t('我的模板', 'My templates')} />
      <label className="block max-w-sm space-y-1 text-meta text-ink-3">{t('检索模板', 'Search templates')}<input type="search" value={templateSearch} onChange={(event) => setTemplateSearch(event.target.value)} placeholder={t('名称、说明或工具类型', 'Name, description or tool type')} className={selectClass} /></label>
      {recipes.isLoading ? <Spinner /> : null}
      {recipes.error ? <Banner tone="danger" title={t('模板读取失败', 'Could not load templates')}>{recipes.error.message}</Banner> : null}
      {recipes.data?.length === 0 ? <p className="text-cell text-ink-3">{t('还没有模板。', 'No templates yet.')}</p> : visibleRecipes.length === 0 ? <p className="text-cell text-ink-3">{t('没有符合条件的模板。', 'No templates match your search.')}</p> : visibleRecipes.map((recipe) => <RecipeCard key={recipe.id} recipe={recipe} resources={datasets} onChanged={() => void client.invalidateQueries({ queryKey: ['recipes'] })} />)}
    </section>
    <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('最近批量运行', 'Recent batch runs')} />{batches.length === 0 ? <p className="text-cell text-ink-3">{t('还没有批量运行记录。', 'No batch runs yet.')}</p> : batches.map((job) => <div key={job.id} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-3 text-cell"><Link to="/recipes/batches/$batchId" params={{ batchId: job.id }} className="min-w-0 flex-1 text-accent-ink hover:underline">{job.name}</Link><span className="text-meta text-ink-3">{jobStateLabel(job.state)}</span></div>)}</Panel>
  </PageBody></>
}

export function RecipeBatchPage() {
  const t = useT()
  const { batchId } = useParams({ from: '/recipes/batches/$batchId' })
  const client = useQueryClient()
  const batch = useQuery({ queryKey: ['recipeBatch', batchId], queryFn: () => api.recipeBatch(batchId),
    refetchInterval: (query) => query.state.data?.batch.state === 'running' ? 1500 : false })
  const resources = useQuery({ queryKey: ['recipeBatch', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const [replacements, setReplacements] = useState<Record<number, string[]>>({})
  const [errors, setErrors] = useState<Record<number, string>>({})
  const [retrying, setRetrying] = useState<number | null>(null)
  const [retryTrials, setRetryTrials] = useState<Record<number, { signature: string; ready: boolean; message: string }>>({})
  const [resourceSearch, setResourceSearch] = useState('')
  const [resourceSearchOffset, setResourceSearchOffset] = useState(0)
  const resourceMatches = useQuery({ queryKey: ['recipe-batch-resource-search', resourceSearch.trim(), resourceSearchOffset],
    queryFn: () => api.findResources({ name: resourceSearch.trim(), kind: 'dataset', status: 'ready' }, resourceSearchOffset, 100),
    enabled: Boolean(resourceSearch.trim()) })
  const selectedReplacementIds = [...new Set([...Object.values(replacements).flat(), ...(batch.data?.groups.flatMap((group) => group.sourceIds) ?? [])].filter(Boolean))]
  const replacementResources = useQueries({ queries: selectedReplacementIds.map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const datasets = [...new Map([...(resourceSearch.trim() ? resourceMatches.data?.items ?? [] : resources.data?.items ?? []),
    ...replacementResources.flatMap((query) => query.data?.kind === 'dataset' && query.data.status === 'ready' ? [query.data] : [])]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready').map((item) => [item.id, item] as const)).values()]
  const trialReplacement = async (index: number, sourceIds: string[]) => {
    if (!batch.data) return
    setRetrying(index)
    setErrors((value) => ({ ...value, [index]: '' }))
    const signature = JSON.stringify(sourceIds)
    try {
      const preflight = await api.recipePreflight(batch.data.recipeId, sourceIds, batch.data.parameterValues)
      if (!preflight.ready) throw new Error(preflight.problems.map(localizedRecipeFinding).join(t('；', '; ')))
      const result = await api.recipeTrial(batch.data.recipeId, sourceIds, batch.data.parameterValues)
      setRetryTrials((value) => ({ ...value, [index]: { signature, ready: result.ready,
        message: result.ready ? t(`样本试跑完成；${result.steps.length} 个步骤已执行`, `Sample run complete; ${result.steps.length} steps executed`) : result.error ? localizedRecipeFinding(result.error) : t('样本试跑失败', 'Sample run failed') } }))
    } catch (error) {
      setRetryTrials((value) => ({ ...value, [index]: { signature, ready: false,
        message: error instanceof Error ? error.message : t('样本试跑失败', 'Sample run failed') } }))
    } finally { setRetrying(null) }
  }
  const retry = async (index: number, sourceIds: string[]) => {
    setRetrying(index)
    setErrors((value) => ({ ...value, [index]: '' }))
    try { await api.retryRecipeBatchGroup(batchId, index, sourceIds, `recipe_retry_${crypto.randomUUID()}`); void client.invalidateQueries({ queryKey: ['recipeBatch', batchId] }) }
    catch (error) { setErrors((value) => ({ ...value, [index]: error instanceof Error ? error.message : t('重试失败', 'Retry failed') })) }
    finally { setRetrying(null) }
  }
  return <><PageTopBar title={t('批量运行结果', 'Batch run results')} /><PageBody className="space-y-4">
    <Link to="/recipes" className="text-cell text-accent-ink hover:underline">{t('返回模板列表', 'Back to templates')}</Link>
    <div className="max-w-sm space-y-2"><label className="block space-y-1 text-meta text-ink-3">{t('按名称查找替换数据集', 'Find replacement dataset by name')}<input type="search" value={resourceSearch} onChange={(event) => { setResourceSearch(event.target.value); setResourceSearchOffset(0) }} placeholder={t('可查找列表第一页以外的数据集', 'Search beyond the first resource page')} className={selectClass} /></label>{resourceSearch.trim() ? <div className="flex items-center gap-2"><Button size="sm" disabled={resourceSearchOffset === 0} onClick={() => setResourceSearchOffset((value) => Math.max(0, value - 100))}>{t('上一段', 'Previous')}</Button><span className="text-meta text-ink-3">{t(`${formatNumber(resourceMatches.data?.total)} 项匹配`, `${formatNumber(resourceMatches.data?.total)} matches`)}</span><Button size="sm" disabled={resourceSearchOffset + 100 >= (resourceMatches.data?.total ?? 0)} onClick={() => setResourceSearchOffset((value) => value + 100)}>{t('下一段', 'Next')}</Button></div> : null}</div>
    {batch.isLoading ? <Spinner /> : null}
    {batch.error ? <Banner tone="danger" title={t('批量任务读取失败', 'Could not load batch job')}>{batch.error.message}</Banner> : null}
    {batch.data ? <><Panel className="max-w-4xl space-y-2"><SectionTitle title={batch.data.batch.name} /><p className="text-cell text-ink-2">{batch.data.batch.progress.stage ? localizedStage(batch.data.batch.progress.stage) : jobStateLabel(batch.data.batch.state)}</p><p className="text-meta text-ink-3">{t(`共 ${batch.data.groups.length} 组；成功、失败和进行中的组分别记录。成功产物可以继续浏览和下载。`, `${batch.data.groups.length} groups; succeeded, failed and active groups are recorded separately. Completed outputs remain browsable and downloadable.`)}</p></Panel>
      <div className="max-w-4xl space-y-3">{batch.data.groups.map((group) => {
        const ids = replacements[group.index] ?? group.sourceIds
        const status = group.job?.state ?? 'failed'
        const canRetry = !group.job || ['failed', 'cancelled', 'interrupted'].includes(status)
        const changed = JSON.stringify(ids) !== JSON.stringify(group.sourceIds)
        const replacementTrialReady = retryTrials[group.index]?.signature === JSON.stringify(ids) && retryTrials[group.index]?.ready
        return <Panel key={group.index} className="space-y-3"><div className="flex flex-wrap justify-between gap-2"><strong className="text-cell text-ink">{t(`第 ${group.index + 1} 组`, `Group ${group.index + 1}`)}</strong><span className="text-meta text-ink-3">{jobStateLabel(status)}{t(` · 已完成 ${group.stepIndex}/${group.stepCount} 步`, ` · ${group.stepIndex}/${group.stepCount} steps completed`)}</span></div>
          {group.submissionError || group.job?.error ? <Banner tone="danger">{group.job?.error ? localizedErrorMessage(group.job.error.code, group.job.error.message) : localizedRecipeFinding(group.submissionError ?? '')}</Banner> : null}
          {group.job ? <Link to="/jobs/$jobId" params={{ jobId: group.job.id }} className="text-cell text-accent-ink hover:underline">{t('查看这组任务与结果', 'View this group job and result')}</Link> : null}
          {group.selectedOutputs.length ? <div className="flex flex-wrap gap-3 text-cell">{group.selectedOutputs.map((output) =>
            <Link key={output.stepId} to="/resources/$resourceId" params={{ resourceId: output.resourceId }} className="text-accent-ink hover:underline">{t('查看流程结果', 'View pipeline output')} · {output.stepId}</Link>)}</div> : null}
          {group.history.length > 1 ? <details><summary className="cursor-pointer text-cell text-accent-ink">{t('查看各步骤和已完成产物', 'View steps and completed outputs')}</summary><div className="mt-2 space-y-2">{group.history.map((job, step) => <div key={job.id} className="flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-2 text-meta"><Link to="/jobs/$jobId" params={{ jobId: job.id }} className="min-w-0 flex-1 text-accent-ink hover:underline">{t(`步骤 ${step + 1}`, `Step ${step + 1}`)} · {job.name}</Link><span className="text-ink-3">{jobStateLabel(job.state)}</span>{job.state === 'succeeded' && job.summary.outputId ? job.kind === 'export' ? <a href={api.downloadUrl(job.summary.outputId)} className="text-accent-ink hover:underline">{t('下载', 'Download')}</a> : job.kind === 'split' ? <Link to="/split" className="text-accent-ink hover:underline">{t('查看拆分', 'View split')}</Link> : <Link to="/datasets/$resourceId" params={{ resourceId: job.summary.outputId }} className="text-accent-ink hover:underline">{t('查看结果', 'View result')}</Link> : null}</div>)}</div></details> : null}
          {canRetry ? <div className="space-y-3 border-t border-hairline-soft pt-3"><p className="text-meta text-ink-3">{t('只重试这一组。替换输入后需重新检查并试跑样本，确保引用的字段与步骤仍可执行。', 'Retry only this group. After replacing inputs, recheck and run a sample to ensure fields and steps still work.')}</p><div className="grid gap-2 sm:grid-cols-2">{ids.map((id, slot) => <label key={slot} className="space-y-1 text-meta text-ink-3">{t(`输入 ${slot + 1}`, `Input ${slot + 1}`)}<select value={id} onChange={(event) => setReplacements((current) => ({ ...current, [group.index]: ids.map((value, at) => at === slot ? event.target.value : value) }))} className={selectClass}><option value="">{t('请选择数据集', 'Select a dataset')}</option>{id && !datasets.some((item) => item.id === id) ? <option value={id} disabled>{t(`原数据集不可用：${id}`, `Previous dataset unavailable: ${id}`)}</option> : null}{datasets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>)}</div>{changed ? <Button size="sm" disabled={retrying !== null || ids.some((id) => !id) || new Set(ids).size !== ids.length} onClick={() => void trialReplacement(group.index, ids)}>{retrying === group.index ? t('正在检查…', 'Checking…') : t('检查并试跑替换输入', 'Check and sample replacement inputs')}</Button> : null}{changed && retryTrials[group.index]?.signature === JSON.stringify(ids) ? <p className="text-meta text-ink-2">{retryTrials[group.index]!.message}</p> : null}<Button variant="primary" disabled={retrying !== null || ids.some((id) => !id) || new Set(ids).size !== ids.length || changed && !replacementTrialReady} onClick={() => void retry(group.index, ids)}>{t(`重试第 ${group.index + 1} 组`, `Retry group ${group.index + 1}`)}</Button>{errors[group.index] ? <Banner tone="danger">{errors[group.index]}</Banner> : null}</div> : null}
        </Panel>
      })}</div></> : null}
  </PageBody></>
}
