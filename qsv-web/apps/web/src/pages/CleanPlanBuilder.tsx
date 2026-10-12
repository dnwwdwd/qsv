import { useSessionDraft } from '@/ui/useSessionDraft'
import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type CleanStep, type Schema } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner } from '@/ui/Feedback'
import { SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { getLocale, useT } from '@/ui/locale'
import { getDisplayTimezone } from '@/ui/timezone'
import { formatNumber } from '@/lib/format'
import { localizedCleanReason } from '@/lib/errors'

type Kind = CleanStep['type']
const kindNames: Record<Kind, string> = { text: '文本处理', fill: '填充空文本', number: '数值转换', date: '日期转换', rename: '重命名字段', columns: '选择及重排字段', add: '生成字段', 'empty-row': '检查空行', filter: '保留或排除记录', dedupe: '按键去重' }
const kindNamesEn: Record<Kind, string> = { text: 'Text processing', fill: 'Fill empty text', number: 'Number conversion', date: 'Date conversion', rename: 'Rename field', columns: 'Select and reorder fields', add: 'Create field', 'empty-row': 'Check empty rows', filter: 'Keep or exclude records', dedupe: 'Remove duplicates by key' }
const inputClass = 'h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'
type DateStep = Extract<CleanStep, { type: 'date' }>

function DateStepOptions({ step, onChange }: { step: DateStep; onChange: (next: DateStep) => void }) {
  const t = useT()
  return <div className="grid gap-2 sm:grid-cols-2">
    <label className="text-meta">{t('输入格式', 'Input format')}<select value={step.format} onChange={(event) => onChange({
      ...step, format: event.target.value as DateStep['format'], outputOffset: step.outputOffset ?? 'Z',
      inputZone: step.inputZone ?? getDisplayTimezone(), outputZone: step.outputZone ?? 'UTC',
    })} className={inputClass}>
      <option value="yyyy-MM-dd">{t('年-月-日', 'Year-month-day')}</option>
      <option value="yyyy/MM/dd">{t('年/月/日', 'Year/month/day')}</option>
      <option value="dd/MM/yyyy">{t('日/月/年', 'Day/month/year')}</option>
      <option value="MM/dd/yyyy">{t('月/日/年', 'Month/day/year')}</option>
      <option value="iso-time">{t('ISO 时间点（输入含 Z 或 ±HH:MM）', 'ISO instant (input includes Z or ±HH:MM)')}</option>
      <option value="iso-local-time">{t('ISO 本地时间（输入无偏移）', 'ISO local time (input has no offset)')}</option>
    </select></label>
    <label className="text-meta">{t('无法解析', 'Cannot parse')}<select value={step.invalid} onChange={(event) => onChange({ ...step, invalid: event.target.value as DateStep['invalid'] })} className={inputClass}>
      <option value="keep">{t('保留原值并报告', 'Keep original and report')}</option>
      <option value="isolate">{t('隔离该行并报告', 'Isolate row and report')}</option>
      <option value="fail">{t('停止任务', 'Stop job')}</option>
    </select></label>
    {step.format === 'iso-time' ? <><label className="text-meta">{t('输出时区偏移', 'Output time zone offset')}<input value={step.outputOffset ?? 'Z'} onChange={(event) => onChange({ ...step, outputOffset: event.target.value })} placeholder={t('Z 或 +08:00', 'Z or +08:00')} className={inputClass} /></label>
      <p className="text-meta text-ink-3 self-end">{t('按输入中的明确偏移换算，不推断本地时区。', 'Convert using the explicit input offset. The local time zone is not inferred.')}</p></>
      : step.format === 'iso-local-time' ? <><label className="text-meta">{t('输入 IANA 时区', 'Input IANA time zone')}<input value={step.inputZone ?? ''} maxLength={64} onChange={(event) => onChange({ ...step, inputZone: event.target.value })} placeholder="Asia/Taipei" className={inputClass} /></label>
        <label className="text-meta">{t('输出 IANA 时区', 'Output IANA time zone')}<input value={step.outputZone ?? ''} maxLength={64} onChange={(event) => onChange({ ...step, outputZone: event.target.value })} placeholder="UTC" className={inputClass} /></label>
        <p className="text-meta text-ink-3 sm:col-span-2">{t('输入形如 2026-09-28T14:30:00，不含偏移。输出写入对应偏移；夏令时造成的不存在或重复时间会按上方错误策略处理。', 'Input looks like 2026-09-28T14:30:00 without an offset. Output includes the resolved offset. Missing or repeated times around daylight saving changes follow the error rule above.')}</p></>
        : <p className="text-meta text-ink-3 sm:col-span-2">{t('仅转换日历日期，不改变时间或时区。', 'Convert calendar dates only, without changing time or time zones.')}</p>}
  </div>
}

function newStep(type: Kind): CleanStep {
  switch (type) {
    case 'text': return { type, columnId: 'c_0', mode: 'trim' }
    case 'fill': return { type, columnId: 'c_0', mode: 'fixed', value: '', scope: 'all' }
    case 'number': return { type, columnId: 'c_0', decimals: 2, rounding: 'half-up', invalid: 'keep' }
    case 'date': return { type, columnId: 'c_0', format: 'yyyy-MM-dd', invalid: 'keep' }
    case 'rename': return { type, columnId: 'c_0', name: getLocale() === 'en-US' ? 'New field name' : '新字段名' }
    case 'columns': return { type, columnIds: ['c_0'] }
    case 'add': return { type, name: getLocale() === 'en-US' ? 'New field' : '新字段', mode: 'constant', value: '' }
    case 'empty-row': return { type, mode: 'report', whitespace: 'literal' }
    case 'filter': return { type, columnId: 'c_0', operator: 'equals', value: '', action: 'keep' }
    case 'dedupe': return { type, columnIds: [], keep: 'first' }
  }
}
function namesBefore(steps: CleanStep[], start: string[], target: number) {
  let names = [...start]
  for (const step of steps.slice(0, target)) {
    if (step.enabled === false) continue
    if (step.type === 'rename') { const index = Number(step.columnId.slice(2)); if (index < names.length) names[index] = step.name }
    if (step.type === 'columns') names = step.columnIds.map((id) => names[Number(id.slice(2))] ?? id)
    if (step.type === 'add') names.push(step.name)
  }
  return names
}
function namedCleanPlan(steps: CleanStep[], sourceNames: string[]) {
  return { steps: steps.map((step, index) => {
    const names = namesBefore(steps, sourceNames, index)
    const fieldName = (id: string) => {
      const name = names[Number(id.slice(2))]
      if (!/^c_\d+$/u.test(id) || !name || names.filter((item) => item === name).length !== 1) {
        throw new Error(getLocale() === 'en-US' ? 'Templates require unique, nonempty field names. Correct the source header or an earlier rename step.' : '模板需要唯一且非空的字段名，请先修正源数据表头或前面步骤的字段名')
      }
      return name
    }
    const named: Record<string, unknown> = { ...step }
    if ('columnId' in step) { named.column = fieldName(step.columnId); delete named.columnId }
    if ('columnIds' in step && step.columnIds) {
      named.columns = step.columnIds.map(fieldName); delete named.columnIds
    }
    if (step.type === 'dedupe' && step.keep === 'priority' && step.priorityColumnId) {
      named.priorityColumn = fieldName(step.priorityColumnId); delete named.priorityColumnId
    }
    return named
  }) }
}
function cleanParameterNames(steps: CleanStep[]) {
  const fields: Record<string, string[]> = { text: ['find', 'replacement'], fill: ['value'], number: ['prefix', 'suffix'],
    add: ['value', 'separator'], filter: ['value'] }
  const names = new Set<string>()
  for (const step of steps) {
    if (step.enabled === false) continue
    for (const field of fields[step.type] ?? []) {
      const value = (step as unknown as Record<string, unknown>)[field]
      if (typeof value === 'string') for (const match of value.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/gu)) names.add(match[1]!)
    }
  }
  return [...names]
}
export function CleanPlanBuilder({ sourceId, schema }: { sourceId: string; schema: Schema }) {
  const t = useT()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [steps, setSteps] = useSessionDraft<CleanStep[]>('CleanPlanBuilder.steps', [])
  const [kind, setKind] = useSessionDraft<Kind>('CleanPlanBuilder.kind', 'text')
  const [templateName, setTemplateName] = useSessionDraft('CleanPlanBuilder.templateName', getLocale() === 'en-US' ? 'Cleaning template' : '清洗模板')
  const [templateDescription, setTemplateDescription] = useSessionDraft('CleanPlanBuilder.templateDescription', '')
  const parameters = cleanParameterNames(steps)
  const preview = useMutation({ mutationFn: async () => ({ signature: JSON.stringify(steps), result: await api.previewCleanPlan(sourceId, { steps }) }) })
  const submit = useMutation({ mutationFn: () => api.cleanPlan(sourceId, { steps }, `clean_${crypto.randomUUID()}`), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const saveTemplate = useMutation({ mutationFn: () => api.importRecipe({ format: 'qsv-recipe-v1', name: templateName.trim(),
    description: templateDescription.trim(), spec: { version: 1, operation: 'clean-plan',
      plan: namedCleanPlan(steps, schema.columns.map((column) => column.name)) } }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['recipes'] })
    void navigate({ to: '/recipes' })
  } })
  const replace = (index: number, step: CleanStep) => setSteps((items) => items.map((item, at) => at === index ? step : item))
  const move = (index: number, direction: -1 | 1) => setSteps((items) => {
    const next = [...items], other = index + direction
    if (other < 0 || other >= next.length) return next
    ;[next[index], next[other]] = [next[other]!, next[index]!]
    return next
  })
  const select = (step: CleanStep, names: string[], value: string) => <select value={value} onChange={(event) => replace(steps.indexOf(step), { ...step, columnId: event.target.value } as CleanStep)} className={inputClass}>{names.map((name, at) => <option key={at} value={`c_${at}`}>{name}{t(`（第 ${at + 1} 列）`, ` (column ${at + 1})`)}</option>)}</select>
  const columns = (step: CleanStep & { columnIds: string[] }, names: string[], index: number) => <div className="grid gap-2 sm:grid-cols-2">{names.map((name, at) => <label key={at} className="flex items-center gap-2 text-cell"><input type="checkbox" checked={step.columnIds.includes(`c_${at}`)} onChange={() => replace(index, { ...step, columnIds: step.columnIds.includes(`c_${at}`) ? step.columnIds.filter((id) => id !== `c_${at}`) : [...step.columnIds, `c_${at}`] } as CleanStep)} />{name}</label>)}</div>
  return <Panel className="space-y-4"><SectionTitle title={t('多步清洗', 'Multistep cleaning')} />
    <p className="text-cell text-ink-2">{t('规则按显示顺序执行，关闭的步骤不会运行。数值或日期解析错误可保留原值、隔离该行或停止任务；正式运行会保存完整错误清单。按空值来源填充适用于有来源清单的导入和派生数据集；筛选、去重、关联或隔离记录后会按结果行号追溯。无法逐格追溯的结果会拒绝按来源填充。去重按当前顺序保留首条或末条，并保存重复组的全部成员。原数据不会被覆盖。', 'Rules run in the order shown; disabled steps are skipped. Number or date parse errors can keep the original value, isolate the row or stop the job. The full run saves an error report. Filling by empty-value origin works for imported and derived datasets with origin records; rows remain traceable after filtering, deduplication, joining or isolation. Results without per-cell tracing reject origin-based filling. Deduplication keeps the first or last record in the current order and saves every member of duplicate groups. Source data is never overwritten.')}</p>
    {steps.map((step, index) => {
      const names = namesBefore(steps, schema.columns.map((column) => column.name), index)
      return <div key={index} className="space-y-3 rounded-control border border-line p-3"><div className="flex flex-wrap items-center gap-2"><strong className="text-cell">{index + 1}. {t(kindNames[step.type], kindNamesEn[step.type])}</strong><label className="ml-auto text-cell"><input type="checkbox" checked={step.enabled !== false} onChange={(event) => replace(index, { ...step, enabled: event.target.checked })} /> {t('启用', 'Enabled')}</label><Button variant="secondary" disabled={index === 0} onClick={() => move(index, -1)}>{t('上移', 'Move up')}</Button><Button variant="secondary" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>{t('下移', 'Move down')}</Button><Button variant="secondary" onClick={() => setSteps((items) => items.filter((_, at) => at !== index))}>{t('删除', 'Delete')}</Button></div>
      {'columnId' in step ? <label className="block space-y-1 text-meta">{t('字段', 'Field')}{select(step, names, step.columnId)}</label> : null}
      {step.type === 'text' ? <><label className="block space-y-1 text-meta">{t('文本操作', 'Text operation')}<select value={step.mode} onChange={(event) => replace(index, { ...step, mode: event.target.value as typeof step.mode })} className={inputClass}><option value="trim">{t('去首尾空白', 'Trim leading and trailing spaces')}</option><option value="squeeze">{t('压缩连续空白', 'Compress consecutive spaces')}</option><option value="squeeze0">{t('删除全部空白', 'Remove all spaces')}</option><option value="lower">{t('小写', 'Lowercase')}</option><option value="upper">{t('大写', 'Uppercase')}</option><option value="nfc">Unicode NFC</option><option value="nfkc">Unicode NFKC</option><option value="replace">{t('固定文本替换', 'Replace fixed text')}</option><option value="pattern">{t('受限正则匹配整个值后替换', 'Replace with limited full-value pattern')}</option></select></label>{['replace','pattern'].includes(step.mode) ? <div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('查找', 'Find')}<input value={step.find ?? ''} maxLength={160} onChange={(event) => replace(index, { ...step, find: event.target.value })} className={inputClass} /></label><label className="text-meta">{t('替换为', 'Replace with')}<input value={step.replacement ?? ''} maxLength={512} onChange={(event) => replace(index, { ...step, replacement: event.target.value })} className={inputClass} /></label></div> : null}</> : null}
      {step.type === 'fill' ? <><select value={step.mode} onChange={(event) => replace(index, { ...step, mode: event.target.value as 'fixed' | 'forward' | 'backward' })} className={inputClass}><option value="fixed">{t('填充固定值', 'Fill with fixed value')}</option><option value="forward">{t('按当前顺序向前填充', 'Fill forward in current order')}</option><option value="backward">{t('按当前顺序向后填充', 'Fill backward in current order')}</option></select><label className="block text-meta">{t('应用范围', 'Apply to')}<select value={step.scope ?? 'all'} onChange={(event) => replace(index, { ...step, scope: event.target.value as typeof step.scope })} className={inputClass}><option value="all">{t('全部空单元格', 'All empty cells')}</option><option value="empty-text">{t('仅原本为空文本', 'Only original empty text')}</option><option value="missing">{t('仅 JSON 缺字段', 'Only missing JSON fields')}</option><option value="explicit-null">{t('仅 JSON 显式 null', 'Only explicit JSON null')}</option></select></label>{step.mode === 'fixed' ? <input value={step.value ?? ''} onChange={(event) => replace(index, { ...step, value: event.target.value })} className={inputClass} placeholder={t('填充值', 'Fill value')} /> : null}</> : null}
      {step.type === 'number' ? <div className="grid gap-2 sm:grid-cols-3"><label className="text-meta">{t('小数位数', 'Decimal places')}<input type="number" min={0} max={18} value={step.decimals} onChange={(event) => replace(index, { ...step, decimals: Number(event.target.value) })} className={inputClass} /></label><label className="text-meta">{t('舍入', 'Rounding')}<select value={step.rounding} onChange={(event) => replace(index, { ...step, rounding: event.target.value as typeof step.rounding })} className={inputClass}><option value="half-up">{t('四舍五入', 'Round half up')}</option><option value="half-even">{t('银行家舍入', 'Round half to even')}</option><option value="truncate">{t('截去多余位', 'Truncate extra digits')}</option></select></label><label className="text-meta">{t('无法解析', 'Cannot parse')}<select value={step.invalid} onChange={(event) => replace(index, { ...step, invalid: event.target.value as typeof step.invalid })} className={inputClass}><option value="keep">{t('保留原值并报告', 'Keep original and report')}</option><option value="isolate">{t('隔离该行并报告', 'Isolate row and report')}</option><option value="fail">{t('停止任务', 'Stop job')}</option></select></label><label className="text-meta">{t('去除前缀', 'Remove prefix')}<input value={step.prefix ?? ''} onChange={(event) => replace(index, { ...step, prefix: event.target.value })} className={inputClass} /></label><label className="text-meta">{t('去除后缀', 'Remove suffix')}<input value={step.suffix ?? ''} onChange={(event) => replace(index, { ...step, suffix: event.target.value })} className={inputClass} /></label><label className="text-meta"><input type="checkbox" checked={step.thousands ?? false} onChange={(event) => replace(index, { ...step, thousands: event.target.checked })} /> {t('去除千分位逗号', 'Remove thousands commas')}</label></div> : null}
      {step.type === 'date' ? <DateStepOptions step={step} onChange={(next) => replace(index, next)} /> : null}
      {step.type === 'rename' || step.type === 'add' ? <label className="block text-meta">{t('新字段名', 'New field name')}<input value={step.name} maxLength={128} onChange={(event) => replace(index, { ...step, name: event.target.value })} className={inputClass} /></label> : null}
      {step.type === 'columns' ? <><p className="text-meta text-ink-3">{t('按勾选顺序保留字段。可先取消，再按希望的顺序重新勾选。', 'Keep fields in selection order. Deselect and select them again to change the order.')}</p>{columns(step, names, index)}</> : null}
      {step.type === 'add' ? <><select value={step.mode} onChange={(event) => replace(index, { ...step, mode: event.target.value as typeof step.mode })} className={inputClass}><option value="constant">{t('常量', 'Constant')}</option><option value="sequence">{t('原顺序序号', 'Original sequence number')}</option><option value="concat">{t('拼接字段', 'Join fields')}</option><option value="arithmetic">{t('计算字段', 'Calculate field')}</option></select>{step.mode === 'constant' ? <input value={step.value ?? ''} onChange={(event) => replace(index, { ...step, value: event.target.value })} className={inputClass} placeholder={t('固定值', 'Fixed value')} /> : null}{step.mode === 'concat' || step.mode === 'arithmetic' ? <>{columns({ ...step, columnIds: step.columnIds ?? [] }, names, index)}{step.mode === 'concat' ? <input value={step.separator ?? ''} onChange={(event) => replace(index, { ...step, separator: event.target.value })} className={inputClass} placeholder={t('分隔文本', 'Separator text')} /> : <select value={step.operator ?? 'add'} onChange={(event) => replace(index, { ...step, operator: event.target.value as 'add' | 'subtract' | 'multiply' })} className={inputClass}><option value="add">{t('相加', 'Add')}</option><option value="subtract">{t('依次相减', 'Subtract in order')}</option><option value="multiply">{t('相乘', 'Multiply')}</option></select>}</> : null}</> : null}
      {step.type === 'empty-row' ? <div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('空行判定', 'Empty row definition')}<select value={step.whitespace} onChange={(event) => replace(index, { ...step, whitespace: event.target.value as typeof step.whitespace })} className={inputClass}><option value="literal">{t('所有单元格都是空文本', 'Every cell is empty text')}</option><option value="trim">{t('所有单元格为空或只有空白字符', 'Every cell is empty or whitespace')}</option></select></label><label className="text-meta">{t('处理方式', 'Action')}<select value={step.mode} onChange={(event) => replace(index, { ...step, mode: event.target.value as typeof step.mode })} className={inputClass}><option value="report">{t('只报告并保留', 'Report and keep')}</option><option value="remove">{t('移除并生成清单', 'Remove and create report')}</option></select></label><p className="text-meta text-ink-3 sm:col-span-2">{t('只检查已经解析成数据行的记录。原文件中的分隔符或列数错误由导入阶段处理；移除空行会改变结果行号。', 'Check only records parsed into data rows. Import handles delimiter and column count errors in the source file. Removing empty rows changes result row numbers.')}</p></div> : null}
      {step.type === 'filter' ? <div className="grid gap-2 sm:grid-cols-3"><select value={step.operator} onChange={(event) => replace(index, { ...step, operator: event.target.value as typeof step.operator })} className={inputClass}><option value="equals">{t('等于', 'Equals')}</option><option value="not-equals">{t('不等于', 'Does not equal')}</option><option value="contains">{t('包含', 'Contains')}</option><option value="is-empty">{t('为空', 'Is empty')}</option><option value="not-empty">{t('非空', 'Is not empty')}</option></select><input value={step.value ?? ''} disabled={step.operator.endsWith('empty')} onChange={(event) => replace(index, { ...step, value: event.target.value })} className={inputClass} placeholder={t('比较值', 'Comparison value')} /><select value={step.action} onChange={(event) => replace(index, { ...step, action: event.target.value as 'keep' | 'exclude' })} className={inputClass}><option value="keep">{t('保留匹配记录', 'Keep matching records')}</option><option value="exclude">{t('排除匹配记录', 'Exclude matching records')}</option></select></div> : null}
      {step.type === 'dedupe' ? <><p className="text-meta text-ink-3">{t('不选字段时按整行比较。第一、最后均按当前记录顺序确定；指定排序优先值相同则保留靠前记录。按手机号等非唯一业务字段去重可能误合并不同记录。', 'With no fields selected, compare whole rows. First and last follow the current record order. Equal priority values keep the earlier record. Deduplicating by a nonunique field such as a phone number may merge different records.')}</p>{columns(step, names, index)}<select value={step.keep} onChange={(event) => replace(index, { ...step, keep: event.target.value as typeof step.keep,
        priorityColumnId: step.priorityColumnId ?? 'c_0', priorityOrder: step.priorityOrder ?? 'asc',
        priorityType: step.priorityType ?? 'text', emptyPriority: step.emptyPriority ?? 'last' })} className={inputClass}><option value="first">{t('保留第一条', 'Keep first')}</option><option value="last">{t('保留最后一条', 'Keep last')}</option><option value="priority">{t('按指定字段排序优先保留', 'Keep by priority field')}</option></select>
      {step.keep === 'priority' ? <div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('优先字段', 'Priority field')}<select value={step.priorityColumnId ?? 'c_0'} onChange={(event) => replace(index, { ...step, priorityColumnId: event.target.value })} className={inputClass}>{names.map((name, at) => <option key={at} value={`c_${at}`}>{name}{t(`（第 ${at + 1} 列）`, ` (column ${at + 1})`)}</option>)}</select></label><label className="text-meta">{t('顺序', 'Order')}<select value={step.priorityOrder ?? 'asc'} onChange={(event) => replace(index, { ...step, priorityOrder: event.target.value as 'asc' | 'desc' })} className={inputClass}><option value="asc">{t('值小优先', 'Lower value first')}</option><option value="desc">{t('值大优先', 'Higher value first')}</option></select></label><label className="text-meta">{t('比较方式', 'Compare as')}<select value={step.priorityType ?? 'text'} onChange={(event) => replace(index, { ...step, priorityType: event.target.value as 'text' | 'decimal' })} className={inputClass}><option value="text">{t('文本顺序', 'Text order')}</option><option value="decimal">{t('十进制数值', 'Decimal value')}</option></select></label><label className="text-meta">{t('空值顺序', 'Empty value order')}<select value={step.emptyPriority ?? 'last'} onChange={(event) => replace(index, { ...step, emptyPriority: event.target.value as 'first' | 'last' })} className={inputClass}><option value="last">{t('排在最后', 'Last')}</option><option value="first">{t('排在最前', 'First')}</option></select></label></div> : null}</> : null}
      </div>
    })}
    <div className="flex flex-wrap gap-2"><select value={kind} onChange={(event) => setKind(event.target.value as Kind)} className={inputClass}>{Object.entries(kindNames).map(([value, label]) => <option key={value} value={value}>{t(label, kindNamesEn[value as Kind])}</option>)}</select><Button variant="secondary" disabled={steps.length >= 24} onClick={() => setSteps((items) => [...items, newStep(kind)])}>{t('添加步骤', 'Add step')}</Button><Button variant="secondary" disabled={!sourceId || steps.length === 0 || parameters.length > 0 || preview.isPending} onClick={() => preview.mutate()}>{t('试跑前 200 行', 'Preview first 200 rows')}</Button><Button variant="primary" disabled={!sourceId || steps.length === 0 || parameters.length > 0 || submit.isPending} onClick={() => submit.mutate()}>{t('运行全部步骤', 'Run all steps')}</Button></div>
    <div className="space-y-3 rounded-control bg-surface-sunk p-3"><strong className="text-cell">{t('保存为模板', 'Save as template')}</strong><p className="text-meta text-ink-3">{t('按字段名保存规则，新数据集缺字段时会拒绝运行。需要每次填写的文本值可写成', 'Rules are saved by field name. A new dataset missing a field will be rejected. Values to enter for each run can use')} {t('{{参数名}}', '{{parameter}}')}{t('；模板运行前会要求填写并试跑。', '; the template asks for values and a preview before running.')}{parameters.length ? t(`当前参数：${parameters.join('、')}`, ` Current parameters: ${parameters.join(', ')}`) : ''}</p><div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('模板名称', 'Template name')}<input value={templateName} maxLength={120} onChange={(event) => setTemplateName(event.target.value)} className={inputClass} /></label><label className="text-meta">{t('说明', 'Description')}<input value={templateDescription} maxLength={1000} onChange={(event) => setTemplateDescription(event.target.value)} className={inputClass} /></label></div><Button disabled={!steps.length || !templateName.trim() || saveTemplate.isPending} onClick={() => saveTemplate.mutate()}>{t('保存清洗模板', 'Save cleaning template')}</Button>{saveTemplate.error ? <Banner tone="danger">{saveTemplate.error.message}</Banner> : null}</div>
    {preview.error ? <Banner tone="danger" title={t('样本试跑失败', 'Sample preview failed')}>{preview.error.message}</Banner> : null}
    {preview.data?.signature === JSON.stringify(steps) ? <div className="space-y-2"><p className="text-cell text-ink-2">{t(`样本范围：${preview.data.result.scope}；取样 ${formatNumber(preview.data.result.sampledRows)} 行，全表 ${formatNumber(preview.data.result.sourceRows)} 行。样本计数不能替代全表结果。`, `Sample: first 200 input records; ${formatNumber(preview.data.result.sampledRows)} sampled rows, ${formatNumber(preview.data.result.sourceRows)} rows in the full dataset. Sample counts do not represent full results.`)}</p><div className="overflow-x-auto"><table className="w-full text-left text-cell"><thead><tr><th>{t('步骤', 'Step')}</th><th>{t('输入', 'Input')}</th><th>{t('输出', 'Output')}</th><th>{t('修改或移除', 'Changed or removed')}</th><th>{t('解析错误', 'Parse errors')}</th><th>{t('空行', 'Empty rows')}</th><th>{t('重复组 / 成员', 'Duplicate groups / members')}</th></tr></thead><tbody>{preview.data.result.steps.map((item) => <tr key={item.step}><td>{item.step}. {t(kindNames[item.type as Kind] ?? item.type, kindNamesEn[item.type as Kind] ?? item.type)}</td><td>{item.rowsIn}</td><td>{item.rowsOut}</td><td>{item.changed}</td><td>{item.errors}</td><td>{item.emptyRows ?? '—'}</td><td>{item.duplicateGroups === undefined ? '—' : `${item.duplicateGroups} / ${item.duplicateMembers ?? 0}`}</td></tr>)}</tbody></table></div>{preview.data.result.steps.some((item) => item.sampleErrors.length > 0) ? <details><summary className="cursor-pointer text-cell text-accent-ink">{t('查看样本解析错误', 'View sample parse errors')}</summary><div className="mt-2 space-y-1">{preview.data.result.steps.flatMap((item) => item.sampleErrors.map((error) => <p key={`${item.step}-${error.row}`} className="text-meta">{t(`步骤 ${item.step} · 第 ${error.row} 行：`, `Step ${item.step} · row ${error.row}: `)}{error.value}{error.reason ? ` · ${localizedCleanReason(error.reason)}` : ''}</p>))}</div></details> : null}<div className="overflow-x-auto"><table className="w-full text-left text-cell"><thead><tr>{preview.data.result.headers.map((name, index) => <th key={index} className="px-2 py-1">{name}</th>)}</tr></thead><tbody>{preview.data.result.rows.slice(0, 20).map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column} className="max-w-64 truncate px-2 py-1">{value}</td>)}</tr>)}</tbody></table></div></div> : null}
    {submit.error ? <Banner tone="danger" title={t('清洗计划未提交', 'Cleaning plan was not submitted')}>{submit.error.message}</Banner> : null}
  </Panel>
}
