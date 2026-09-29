import { useState } from 'react'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type CompareAnnotation, type CompareDetail, type CompareFilters, type CompareSummary } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { Fact, PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'
import { localizedCompareReason, localizedCompareState } from '@/lib/compare-text'

const count = formatNumber
const categoryLabel: Record<string, string> = {
  equal: '一致', different: '字段差异', pair_error: '解析异常', left_only: '仅左', right_only: '仅右',
  key_conflict: '键冲突', invalid_left_key: '左侧无效键', invalid_right_key: '右侧无效键',
}
const categoryLabelEn: Record<string, string> = {
  equal: 'Equal', different: 'Field difference', pair_error: 'Parse error', left_only: 'Left only', right_only: 'Right only',
  key_conflict: 'Key conflict', invalid_left_key: 'Invalid left key', invalid_right_key: 'Invalid right key',
}

function GroupMembers({ rows, sourceId, readable }: { rows: string; sourceId?: string; readable: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const members = rows ? rows.split(',').filter(Boolean) : []
  if (!members.length) return null
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer whitespace-nowrap text-accent-ink">{t(`${members.length} 条来源记录`, `${members.length} source rows`)}</summary>
    {open ? <div className="mt-1 flex max-w-72 flex-wrap gap-x-2 gap-y-1 whitespace-normal">{members.map((row, index) => readable && sourceId
      ? <Link key={`${row}-${index}`} to="/datasets/$resourceId" params={{ resourceId: sourceId }} search={{ row: Number(row) }} className="text-accent-ink hover:underline">{row}</Link>
      : <span key={`${row}-${index}`} className="text-ink-3">{row}</span>)}</div> : null}</details>
}

function ContextValues({ value }: { value: string }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (!value) return null
  let formatted = value
  if (open) { try { formatted = JSON.stringify(JSON.parse(value), null, 2) } catch { /* 保留原始字段快照。 */ } }
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer whitespace-nowrap text-accent-ink">{t('查看字段快照', 'View field snapshot')}</summary>
    {open ? <pre className="mt-1 max-h-64 max-w-96 overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface-sunk p-2 text-meta text-ink-2">{formatted}</pre> : null}</details>
}

export function CompareResultPage() {
  const t = useT()
  const { resourceId } = useSearch({ from: '/compare/result' })
  const navigate = useNavigate()
  const client = useQueryClient()
  const [offset, setOffset] = useState(0)
  const [listCursor, setListCursor] = useState('')
  const [listPreviousCursors, setListPreviousCursors] = useState<string[]>([])
  const [draft, setDraft] = useState({ category: '', key: '', field: '', fieldState: '', value: '',
    differenceMin: '', differenceMax: '', sourceRow: '', annotationStatus: '' })
  const [filters, setFilters] = useState<CompareFilters>({})
  const [selectedRows, setSelectedRows] = useState<number[]>([])
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [editStatus, setEditStatus] = useState<'pending' | 'verified' | 'ignored' | ''>('pending')
  const [editNote, setEditNote] = useState('')
  const [bulkStatus, setBulkStatus] = useState<'pending' | 'verified' | 'ignored'>('pending')
  const [bulkNote, setBulkNote] = useState('')
  const filtering = Object.values(filters).some((value) => value !== undefined && value !== '')
  const list = useQuery({ queryKey: ['compare', 'results', listCursor], queryFn: () => api.resourceCursorPage(listCursor, 100), enabled: !resourceId })
  const resource = useQuery({ queryKey: ['resource', resourceId], queryFn: () => api.resource(resourceId!), enabled: Boolean(resourceId) })
  const sourceIds = resource.data?.sourceIds.slice(0, 2) ?? []
  const sources = useQueries({ queries: sourceIds.map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id), retry: false })) })
  const view = useQuery({ queryKey: ['compare', 'view', resourceId], queryFn: () => api.createView(resourceId!), enabled: Boolean(resourceId && resource.data?.status === 'ready' && !filtering) })
  const rows = useQuery({ queryKey: ['compare', 'rows', view.data?.id, offset], queryFn: () => api.rows(view.data!.id, offset, 100), enabled: Boolean(view.data && !filtering) })
  const matches = useQuery({ queryKey: ['compare', 'find', resourceId, filters, offset],
    queryFn: () => api.compareDetails(resourceId!, filters, offset), enabled: Boolean(resourceId && resource.data?.status === 'ready' && filtering) })
  const annotations = useQuery({ queryKey: ['compare', 'annotations', resourceId, offset],
    queryFn: () => api.compareAnnotations(resourceId!, offset), enabled: Boolean(resourceId && resource.data?.status === 'ready' && !filtering) })
  const summary = resource.data?.metadata.compareSummary as CompareSummary | undefined
  const labels = (resource.data?.metadata.compare as { config?: { leftLabel?: string; rightLabel?: string } } | undefined)?.config
  const results = list.data?.items.filter((item) => item.status === 'ready' && Boolean(item.metadata.compareSummary)) ?? []
  const displayItems: CompareDetail[] = filtering ? matches.data?.items ?? [] : (rows.data?.rows ?? []).map((row, index) => ({
    detailRow: offset + index + 1, cells: row.map((value) => value ?? ''),
    annotation: annotations.data?.items.find((item) => item.detailRow === offset + index + 1) ?? null }))
  const sourceRow = (value: string, column: number) => {
    const sourceIndex = column === 3 ? 0 : 1
    const sourceId = sourceIds[sourceIndex]
    const source = sources[sourceIndex]
    if (!sourceId || source?.isPending) return value
    if (source?.isError || source?.data?.status !== 'ready') {
      return <span title={t('原数据集已删除或不可用，无法读取原记录', 'The source dataset was deleted or is unavailable; original row cannot be read')}>{value}{t(' · 来源不可读取', ' · source unavailable')}</span>
    }
    return <Link to="/datasets/$resourceId" params={{ resourceId: sourceId }} search={{ row: Number(value) }} className="text-accent-ink hover:underline">{value}</Link>
  }
  const editing = displayItems.find((item) => item.detailRow === editingRow)
  const annotate = useMutation({ mutationFn: (edits: { detailRow: number; status: CompareAnnotation['status'] | null;
    note: string; expectedUpdatedAt: number | null }[]) => api.setCompareAnnotations(resourceId!, edits), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['compare', 'annotations', resourceId] })
    void client.invalidateQueries({ queryKey: ['compare', 'find', resourceId] })
    setEditingRow(null); setSelectedRows([])
  } })
  const report = useMutation({ mutationFn: (format: 'zip' | 'xlsx') => api.compareReport(resourceId!, format, `report_${crypto.randomUUID()}`),
    onSuccess: (result) => { void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } }) } })
  const apply = () => { setFilters({ category: draft.category, key: draft.key.trim(), field: draft.field.trim(),
    fieldState: draft.fieldState, value: draft.value.trim(), differenceMin: draft.differenceMin.trim(),
    differenceMax: draft.differenceMax.trim(), sourceRow: draft.sourceRow ? Number(draft.sourceRow) : undefined,
    annotationStatus: draft.annotationStatus }); setOffset(0); setSelectedRows([]) }
  return <><PageTopBar title={t('双表核对结果', 'Comparison results')} facts={resource.data ? <Fact label={t('明细行', 'Detail rows')}>{count(resource.data.rowCount ?? undefined)}</Fact> : undefined}
    actions={resourceId ? <Link to="/compare/result" search={{ resourceId: undefined }} className="text-cell text-accent-ink hover:underline">{t('返回结果列表', 'Back to results')}</Link> : <Link to="/compare" className="text-cell text-accent-ink hover:underline">{t('新建核对', 'New comparison')}</Link>} />
    <PageBody className="space-y-4">
      {!resourceId ? <Panel className="max-w-4xl space-y-3"><SectionTitle title={t('已完成的核对', 'Completed comparisons')} />{list.isLoading ? <Spinner /> : null}{list.error ? <Banner tone="danger" title={t('结果读取失败', 'Could not load results')}>{list.error.message}</Banner> : null}
        {results.length === 0 && !list.isLoading ? <p className="text-cell text-ink-3">{listCursor || list.data?.nextCursor ? t('本段资源中没有已完成的核对，可继续查看前后段。', 'No completed comparisons in this resource segment. Check adjacent segments.') : t('还没有已完成的核对任务。', 'No completed comparisons yet.')}</p> : null}
        {results.map((item) => <Link key={item.id} to="/compare/result" search={{ resourceId: item.id }} className="block rounded-control bg-surface-sunk px-3 py-2 text-cell text-accent-ink hover:underline">{item.name} · {t(`${count(item.rowCount)} 条明细`, `${count(item.rowCount)} detail rows`)}</Link>)}
        <div className="flex items-center gap-2"><Button size="sm" disabled={listPreviousCursors.length === 0} onClick={() => { setListCursor(listPreviousCursors[listPreviousCursors.length - 1]!); setListPreviousCursors((current) => current.slice(0, -1)) }}>{t('上一段资源', 'Previous resources')}</Button><span className="text-meta text-ink-3">{t(`第 ${listPreviousCursors.length + 1} 段`, `Segment ${listPreviousCursors.length + 1}`)}</span><Button size="sm" disabled={!list.data?.nextCursor} onClick={() => { setListPreviousCursors((current) => [...current, listCursor]); setListCursor(list.data!.nextCursor!) }}>{t('下一段资源', 'Next resources')}</Button></div>
      </Panel> : null}
      {resource.isLoading ? <Spinner /> : null}
      {resource.error ? <Banner tone="danger" title={t('结果读取失败', 'Could not load results')}>{resource.error.message}</Banner> : null}
      {resourceId && resource.data && !summary ? <Banner tone="warning">{t('此资源没有已完成的双表核对汇总。', 'This resource has no completed comparison summary.')}</Banner> : null}
      {summary ? <><Panel className="max-w-5xl space-y-4"><SectionTitle title={t('核对汇总', 'Comparison summary')} /><p className="text-cell text-ink-2">{t('左侧：', 'Left: ')}{labels?.leftLabel || sources[0]?.data?.name || t('左侧数据', 'Left data')}{t('；右侧：', '; right: ')}{labels?.rightLabel || sources[1]?.data?.name || t('右侧数据', 'Right data')}{t('。名称来自本次固定规则，原数据集版本仍以来源资源为准。', '. Labels come from the fixed rules for this comparison; source resource IDs determine dataset versions.')}</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {([[t('左侧输入', 'Left input'), summary.leftRows], [t('右侧输入', 'Right input'), summary.rightRows], [t('一致匹配对', 'Equal pairs'), summary.equalPairs], [t('字段差异匹配对', 'Differing pairs'), summary.differentPairs],
          [t('字段解析异常对', 'Parse-error pairs'), summary.pairErrors], [t('仅左记录', 'Left-only records'), summary.leftOnly], [t('仅右记录', 'Right-only records'), summary.rightOnly], [t('左侧键冲突记录', 'Left key conflicts'), summary.leftConflict],
          [t('右侧键冲突记录', 'Right key conflicts'), summary.rightConflict], [t('左侧无效键记录', 'Invalid left keys'), summary.leftInvalid], [t('右侧无效键记录', 'Invalid right keys'), summary.rightInvalid],
          [t('差异字段数', 'Differing fields'), summary.differentFields], [t('重复键组', 'Duplicate key groups'), summary.conflictGroups],
          [t('左侧聚合增加记录', 'Extra left records after aggregation'), summary.leftAggregatedExtra ?? 0],
          [t('右侧聚合增加记录', 'Extra right records after aggregation'), summary.rightAggregatedExtra ?? 0]] as [string, number][]).map(([label, value]) => <div key={label} className="rounded-control bg-surface-sunk px-3 py-2"><p className="text-meta text-ink-3">{label}</p><p className="figure text-xl font-semibold text-ink">{count(value)}</p></div>)}
      </div><p className="text-meta text-ink-3">{t('左右输入记录均已按无效键、键冲突、仅本侧、匹配一致、匹配差异或解析异常归类。使用重复键聚合时，“聚合增加记录”计入数量核对；匹配对数按聚合后的键组计算。', 'Records from both inputs are classified by invalid key, key conflict, one-sided presence, equal match, differing match or parse error. When duplicate keys are aggregated, extra aggregated records count toward reconciliation; matched pairs use aggregated key groups.')}</p>
      <div className="flex flex-wrap items-center gap-3 text-cell"><a href={api.downloadUrl(resourceId!)} className="text-accent-ink hover:underline">{t('下载完整 CSV 明细', 'Download complete CSV details')}</a><Link to="/datasets/$resourceId" params={{ resourceId: resourceId! }} className="text-accent-ink hover:underline">{t('用数据集浏览器查看全部行', 'Browse all rows as a dataset')}</Link>
        {sourceIds.length === 2 ? <Link to="/compare" search={{ leftId: sourceIds[0], rightId: sourceIds[1], copyResultId: resourceId }} className="text-accent-ink hover:underline">{t('复制规则新建核对', 'Create comparison from these rules')}</Link> : null}
        <Button size="sm" disabled={report.isPending} onClick={() => report.mutate('zip')}>{t('生成分类 CSV 报告', 'Create categorized CSV report')}</Button>
        <Button size="sm" disabled={report.isPending} onClick={() => report.mutate('xlsx')}>{t('生成 Excel 报告', 'Create Excel report')}</Button>
      </div><p className="text-meta text-ink-3">{t('CSV 报告为 ZIP，内含汇总和各分类明细。报告创建为任务，完成后从任务详情下载；人工标注以生成报告时的状态为准。', 'The CSV report is a ZIP with a summary and details by category. It runs as a job; download it from the job details when complete. Annotations use their state when the report is generated.')}</p>
      {report.error ? <Banner tone="danger" title={t('报告提交失败', 'Could not submit report')}>{report.error.message}</Banner> : null}</Panel>
      <Panel className="space-y-3"><SectionTitle title={t('核对明细', 'Comparison details')} /><p className="text-meta text-ink-3">{t('每段最多 100 行。分类检索扫描固定的完整结果；原值、规范化值和使用的比较规则同时保留。', 'Each segment contains up to 100 rows. Category search scans the complete fixed result and retains original values, normalized values and comparison rules.')}</p>
        <form className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6" onSubmit={(event) => { event.preventDefault(); apply() }}>
          <label className="space-y-1 text-meta text-ink-3">{t('分类', 'Category')}<select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option>{Object.entries(categoryLabel).map(([value, label]) => <option key={value} value={value}>{t(label, categoryLabelEn[value] ?? label)}</option>)}</select></label>
          <label className="space-y-1 text-meta text-ink-3">{t('匹配键', 'Matching key')}<input value={draft.key} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <label className="space-y-1 text-meta text-ink-3">{t('字段', 'Field')}<input value={draft.field} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, field: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <label className="space-y-1 text-meta text-ink-3">{t('字段状态', 'Field status')}<select value={draft.fieldState} onChange={(event) => setDraft((current) => ({ ...current, fieldState: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option><option value="equal">{t('一致', 'Equal')}</option><option value="different">{t('差异', 'Different')}</option><option value="error">{t('解析异常', 'Parse error')}</option></select></label>
          <label className="space-y-1 text-meta text-ink-3">{t('原值或规范化值', 'Original or normalized value')}<input value={draft.value} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <label className="space-y-1 text-meta text-ink-3">{t('差值绝对值下限', 'Minimum absolute difference')}<input inputMode="decimal" value={draft.differenceMin} maxLength={42} onChange={(event) => setDraft((current) => ({ ...current, differenceMin: event.target.value }))} placeholder="0.01" className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <label className="space-y-1 text-meta text-ink-3">{t('差值绝对值上限', 'Maximum absolute difference')}<input inputMode="decimal" value={draft.differenceMax} maxLength={42} onChange={(event) => setDraft((current) => ({ ...current, differenceMax: event.target.value }))} placeholder="100" className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <label className="space-y-1 text-meta text-ink-3">{t('源行号', 'Source row')}<input type="number" min={1} value={draft.sourceRow} onChange={(event) => setDraft((current) => ({ ...current, sourceRow: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
          <label className="space-y-1 text-meta text-ink-3">{t('人工标注', 'Annotation')}<select value={draft.annotationStatus} onChange={(event) => setDraft((current) => ({ ...current, annotationStatus: event.target.value }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="">{t('全部', 'All')}</option><option value="unmarked">{t('未标注', 'Unmarked')}</option><option value="pending">{t('待核实', 'Pending review')}</option><option value="verified">{t('已核实', 'Verified')}</option><option value="ignored">{t('忽略', 'Ignored')}</option></select></label>
          <p className="text-meta text-ink-3 sm:col-span-3 xl:col-span-6">{t('差值范围只匹配有数值差值的明细；金额、日历日和秒数沿用该字段的核对规则与单位，文本差异不参与范围检索。', 'Difference bounds match only rows with a numeric difference. Amounts, calendar days and seconds use each field’s comparison rule and unit. Text differences are excluded.')}</p>
          <div className="flex gap-2 sm:col-span-3 xl:col-span-6"><Button size="sm" type="submit" variant="primary">{t('检索完整结果', 'Search complete result')}</Button><Button size="sm" onClick={() => { setDraft({ category: '', key: '', field: '', fieldState: '', value: '', differenceMin: '', differenceMax: '', sourceRow: '', annotationStatus: '' }); setFilters({}); setOffset(0) }}>{t('清除条件', 'Clear filters')}</Button></div>
        </form>
        {rows.error || view.error || matches.error ? <Banner tone="danger" title={t('明细读取失败', 'Could not load details')}>{(matches.error ?? rows.error ?? view.error)?.message}</Banner> : null}
        {filtering ? matches.isLoading ? <Spinner /> : <p className="figure text-meta text-ink-3">{t(`完整结果中符合条件的明细：${count(matches.data?.total)}`, `Matching details in complete result: ${count(matches.data?.total)}`)}</p> : rows.isLoading || view.isLoading ? <Spinner /> : null}
        <div className="overflow-auto rounded-control"><table className="min-w-full text-left text-cell"><thead className="bg-surface-sunk text-meta text-ink-3"><tr><th className="px-3 py-2">{t('选择', 'Select')}</th>{[['分类', 'Category'], ['字段状态', 'Field state'], ['键', 'Key'], ['左侧行号', 'Left row'], ['右侧行号', 'Right row'], ['比较字段', 'Compared field'], ['左原值', 'Left original'], ['右原值', 'Right original'], ['左规范化值', 'Left normalized'], ['右规范化值', 'Right normalized'], ['差值', 'Difference'], ['依据', 'Reason'], ['左组成员行', 'Left group members'], ['右组成员行', 'Right group members'], ['左侧上下文', 'Left context'], ['右侧上下文', 'Right context'], ['标注', 'Annotation']].map(([zh, en]) => <th key={zh} className="whitespace-nowrap px-3 py-2">{t(zh, en)}</th>)}</tr></thead><tbody className="divide-y divide-hairline-soft">{displayItems.map((item) => { const oldCells = item.cells.length === 10 ? [...item.cells.slice(0, 8), '', '', ...item.cells.slice(8), '', ''] : item.cells.length === 12 ? [...item.cells, '', ''] : item.cells; const cells = oldCells.length === 14 ? [...oldCells, '', ''] : oldCells; return <tr key={item.detailRow}><td className="px-3 py-2"><input type="checkbox" aria-label={t(`选择明细 ${item.detailRow}`, `Select detail ${item.detailRow}`)} checked={selectedRows.includes(item.detailRow)} onChange={() => setSelectedRows((current) => current.includes(item.detailRow) ? current.filter((row) => row !== item.detailRow) : [...current, item.detailRow])} /></td>{cells.map((value, column) => <td key={column} className={`${column >= 12 ? "min-w-36" : "max-w-72 truncate"} px-3 py-2 text-ink-2`} title={column === 11 ? localizedCompareReason(value ?? '') : column >= 14 ? undefined : value ?? ''}>{column === 12 || column === 13 ? <GroupMembers rows={value ?? ''} sourceId={sourceIds[column - 12]} readable={sources[column - 12]?.data?.status === 'ready'} /> : column === 14 || column === 15 ? <ContextValues value={value ?? ''} /> : (column === 3 || column === 4) && value ? sourceRow(value, column) : column === 0 ? t(categoryLabel[value ?? ''] ?? value, categoryLabelEn[value ?? ''] ?? value) : column === 1 ? localizedCompareState(value ?? '') : column === 11 ? localizedCompareReason(value ?? '') : value}</td>)}<td className="whitespace-nowrap px-3 py-2"><span className="mr-2 text-ink-3">{item.annotation?.status === 'pending' ? t('待核实', 'Pending review') : item.annotation?.status === 'verified' ? t('已核实', 'Verified') : item.annotation?.status === 'ignored' ? t('忽略', 'Ignored') : t('未标注', 'Unmarked')}</span><Button size="sm" onClick={() => { setEditingRow(item.detailRow); setEditStatus(item.annotation?.status ?? 'pending'); setEditNote(item.annotation?.note ?? '') }}>{t('编辑', 'Edit')}</Button></td></tr> })}</tbody></table></div>
        {editing ? <div className="space-y-3 rounded-control bg-surface-sunk p-3"><strong className="text-cell text-ink">{t(`明细 ${editing.detailRow} 的人工标注`, `Annotation for detail ${editing.detailRow}`)}</strong><div className="grid gap-2 sm:grid-cols-[12rem_1fr]"><label className="space-y-1 text-meta text-ink-3">{t('状态', 'Status')}<select value={editStatus} onChange={(event) => setEditStatus(event.target.value as typeof editStatus)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="pending">{t('待核实', 'Pending review')}</option><option value="verified">{t('已核实', 'Verified')}</option><option value="ignored">{t('忽略', 'Ignored')}</option><option value="">{t('清除标注', 'Clear annotation')}</option></select></label><label className="space-y-1 text-meta text-ink-3">{t('备注', 'Note')}<textarea value={editNote} maxLength={1000} onChange={(event) => setEditNote(event.target.value)} rows={2} className="block w-full rounded-control bg-surface p-2 text-cell text-ink shadow-rail" /></label></div><div className="flex gap-2"><Button size="sm" variant="primary" disabled={annotate.isPending} onClick={() => annotate.mutate([{ detailRow: editing.detailRow, status: editStatus || null, note: editStatus ? editNote : '', expectedUpdatedAt: editing.annotation?.updatedAt ?? null }])}>{t('保存标注', 'Save annotation')}</Button><Button size="sm" onClick={() => setEditingRow(null)}>{t('取消', 'Cancel')}</Button></div></div> : null}
        {selectedRows.length ? <div className="flex flex-wrap items-end gap-2 rounded-control bg-surface-sunk p-3 text-cell"><span>{t(`已选 ${selectedRows.length} 条`, `${selectedRows.length} selected`)}</span><label className="space-y-1 text-meta text-ink-3">{t('批量状态', 'Bulk status')}<select value={bulkStatus} onChange={(event) => setBulkStatus(event.target.value as typeof bulkStatus)} className="block h-9 rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="pending">{t('待核实', 'Pending review')}</option><option value="verified">{t('已核实', 'Verified')}</option><option value="ignored">{t('忽略', 'Ignored')}</option></select></label><label className="min-w-44 flex-1 space-y-1 text-meta text-ink-3">{t('共同备注（留空则保留原备注）', 'Shared note (blank keeps existing notes)')}<input value={bulkNote} maxLength={1000} onChange={(event) => setBulkNote(event.target.value)} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label><Button size="sm" variant="primary" disabled={annotate.isPending} onClick={() => annotate.mutate(selectedRows.map((detailRow) => { const item = displayItems.find((candidate) => candidate.detailRow === detailRow)!; return { detailRow, status: bulkStatus, note: bulkNote || item.annotation?.note || '', expectedUpdatedAt: item.annotation?.updatedAt ?? null } }))}>{t('批量保存', 'Save selected')}</Button></div> : null}
        {annotate.error ? <Banner tone="danger" title={t('标注未保存', 'Annotation was not saved')}>{annotate.error.message}</Banner> : null}
        <div className="flex items-center gap-2"><Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>{t('上一段', 'Previous segment')}</Button><span className="figure text-meta text-ink-3">{t(`第 ${displayItems.length ? offset + 1 : 0}—${offset + displayItems.length} 行`, `Rows ${displayItems.length ? offset + 1 : 0}–${offset + displayItems.length}`)}</span><Button size="sm" disabled={filtering ? offset + 100 >= (matches.data?.total ?? 0) : !rows.data?.hasMore} onClick={() => setOffset(filtering ? offset + 100 : rows.data?.nextOffset ?? offset + 100)}>{t('下一段', 'Next segment')}</Button></div>
      </Panel></> : null}
    </PageBody></>
}
