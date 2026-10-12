import { useEffect, useRef, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useDatasetSearch } from '@/ui/useDatasetSearch'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ExportScope, type JsonExportOptions, type TextExportOptions } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { BatchExportPanel } from './BatchExportPanel'
import { useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'
import { localizedExportFinding } from '@/lib/export-findings'

export function ConvertPage() {
  const t = useT()
  const navigate = useNavigate()
  const { sourceId: requestedSourceId } = useSearch({ from: '/convert' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['convert', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('convert')
  const [sourceId, setSourceId] = useSessionDraft('ConvertPage.sourceId', '')
  const lookupId = requestedSourceId || sourceId
  const requestedResource = useQuery({ queryKey: ['resource', lookupId], queryFn: () => api.resource(lookupId),
    enabled: Boolean(lookupId) })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const [format, setFormat, formatRestored] = useSessionDraft<'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'>('ConvertPage.format', 'csv')
  const [safeText, setSafeText, safeTextRestored] = useSessionDraft('ConvertPage.safeText', true)
  const [textOptions, setTextOptions, textOptionsRestored] = useSessionDraft<TextExportOptions>('ConvertPage.textOptions', { encoding: 'utf-8', delimiter: ',', quote: '"', newline: 'lf', bom: false })
  const [jsonOptions, setJsonOptions] = useSessionDraft<JsonExportOptions>('ConvertPage.jsonOptions', { emptyAsNull: false, types: {} })
  const [multiWorkbook, setMultiWorkbook] = useSessionDraft('ConvertPage.multiWorkbook', false)
  const [workbookIds, setWorkbookIds] = useSessionDraft<string[]>('ConvertPage.workbookIds', [])
  const workbookResources = useQueries({ queries: [...new Set(workbookIds.filter(Boolean))].map((id) => ({
    queryKey: ['resource', id], queryFn: () => api.resource(id),
  })) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), requestedResource.data,
    ...workbookResources.map((query) => query.data)].filter((item) => Boolean(item)).map((item) => [item!.id, item!] as const)).values()]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready')
  const [sheetNames, setSheetNames] = useSessionDraft<Record<string, string>>('ConvertPage.sheetNames', {})
  const [singleSheetName, setSingleSheetName] = useSessionDraft('ConvertPage.singleSheetName', '')
  const [splitWorkbook, setSplitWorkbook] = useSessionDraft('ConvertPage.splitWorkbook', false)
  const [rowsPerSheet, setRowsPerSheet] = useSessionDraft('ConvertPage.rowsPerSheet', '1000000')
  const [outputName, setOutputName] = useSessionDraft('ConvertPage.outputName', '')
  const [limitedScope, setLimitedScope] = useSessionDraft('ConvertPage.limitedScope', false)
  const [startRow, setStartRow] = useSessionDraft('ConvertPage.startRow', '')
  const [endRow, setEndRow] = useSessionDraft('ConvertPage.endRow', '')
  const [scopeColumnIds, setScopeColumnIds] = useSessionDraft<string[] | null>('ConvertPage.scopeColumnIds', null)
  const defaultsTouched = useRef(false)
  useEffect(() => {
    if (!defaultsTouched.current && settings.data) {
      if (!formatRestored) setFormat(settings.data.settings.outputFormat)
      if (!safeTextRestored) setSafeText(settings.data.settings.safeText)
      if (!textOptionsRestored && settings.data.settings.outputFormat === 'tsv') setTextOptions((current) => ({ ...current, delimiter: '\t' }))
      defaultsTouched.current = true
    }
  }, [settings.data])
  useEffect(() => { if (requestedSourceId) setSourceId(requestedSourceId) }, [requestedSourceId, setSourceId])
  const [key, setKey] = useState(() => `export_${crypto.randomUUID()}`)
  const defaultDatasetId = resources.data?.items.find((item) => item.kind === 'dataset' && item.status === 'ready')?.id
  const selectedSource = sourceId || (requestedSourceId && datasets.some((item) => item.id === requestedSourceId) ? requestedSourceId
    : defaultDatasetId || datasets[0]?.id) || ''
  const workbook: { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number } | undefined =
    format === 'xlsx' || format === 'ods' ? multiWorkbook ? {
    sourceIds: workbookIds,
    sheetNames: workbookIds.map((id, index) => sheetNames[id] ?? `Sheet${index + 1}`),
  } : singleSheetName || splitWorkbook ? { sourceIds: [selectedSource], sheetNames: [singleSheetName || 'Sheet1'],
    rowsPerSheet: splitWorkbook ? Number(rowsPerSheet) : undefined } : undefined : undefined
  const workbookValid = !workbook || (workbook.sourceIds.length >= (multiWorkbook ? 2 : 1) && workbook.sourceIds.length <= 20 &&
    new Set(workbook.sourceIds).size === workbook.sourceIds.length &&
    workbook.sourceIds.every((id) => datasets.some((item) => item.id === id)) &&
    workbook.sheetNames.every((name) => name.trim().length > 0 && name.length <= 31 && !/[\\/*\[\]:?\x00-\x1f]/.test(name) && !name.startsWith("'") && !name.endsWith("'")) &&
    (workbook.rowsPerSheet === undefined || Number.isSafeInteger(workbook.rowsPerSheet) &&
      workbook.rowsPerSheet >= 1 && workbook.rowsPerSheet <= 1_048_575) &&
    new Set(workbook.sheetNames.map((name) => name.toLocaleLowerCase())).size === workbook.sheetNames.length)
  const sourceValid = Boolean(workbook || (selectedSource && datasets.some((item) => item.id === selectedSource)))
  const schema = useQuery({ queryKey: ['schema', selectedSource], queryFn: () => api.schema(selectedSource), enabled: Boolean(selectedSource) })
  const scope: ExportScope | undefined = limitedScope && (!workbook || workbook.sourceIds.length === 1) ? {
    startRow: startRow ? Number(startRow) : 1,
    endRow: endRow ? Number(endRow) : schema.data?.rowCount ?? 0,
    columnIds: scopeColumnIds ?? schema.data?.columns.map((column) => column.id) ?? [],
  } : undefined
  const scopeValid = !scope || (Number.isSafeInteger(scope.startRow) && Number.isSafeInteger(scope.endRow) &&
    scope.startRow >= 1 && scope.endRow >= scope.startRow && scope.endRow <= (schema.data?.rowCount ?? 0) &&
    scope.columnIds.length > 0 && scope.columnIds.every((id) => schema.data?.columns.some((column) => column.id === id)))
  const outputNameValid = !outputName || Boolean(outputName.trim() && outputName.trim() !== '.' && outputName.trim() !== '..' &&
    outputName.length <= 120 && !/[\\/\x00-\x1f\x7f]/u.test(outputName))
  const preflightSignature = JSON.stringify({ selectedSource, format, safeText, textOptions, jsonOptions, workbook, scope, outputName,
    revisions: (workbook?.sourceIds ?? [selectedSource]).map((id) => datasets.find((item) => item.id === id)?.contentHash ?? null) })
  const preflight = useMutation({ mutationFn: async () => ({ signature: preflightSignature, result: await api.exportPreflight(
    workbook?.sourceIds[0] ?? selectedSource, format, safeText,
    format === 'csv' || format === 'tsv' ? textOptions : undefined,
    format === 'json' || format === 'jsonl' ? jsonOptions : undefined, workbook, scope) }) })
  const preflightReady = preflight.data?.signature === preflightSignature && preflight.data.result.ready
  const submit = useMutation({ mutationFn: () => api.export(workbook?.sourceIds[0] ?? selectedSource, format, safeText, key,
    format === 'csv' || format === 'tsv' ? textOptions : undefined,
    format === 'json' || format === 'jsonl' ? jsonOptions : undefined, workbook, scope, outputName.trim() || undefined), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const changeKey = () => setKey(`export_${crypto.randomUUID()}`)
  return <><PageTopBar title={t('格式转换与导出', 'Convert and export')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    <DraftInputWarning ids={[sourceId, ...workbookIds]} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || requestedResource.isLoading || workbookResources.some((query) => query.isLoading)} />
    <Banner tone="info">{t('选择固定的数据集版本和导出范围。结果会作为独立文件保存，并可从任务页或资源页下载。', 'Select a fixed dataset version and export scope. The result is saved as a separate file and can be downloaded from the job or resource page.')}</Banner>
    <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('创建导出任务', 'Create export job')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length === 0 ? <p className="text-cell text-ink-3">{t('请先导入至少一个数据集。', 'Import at least one dataset first.')}</p> : null}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (preflightReady) submit.mutate() }}>
        {!multiWorkbook || (format !== 'xlsx' && format !== 'ods') ? <label className="block space-y-1 text-meta text-ink-3">{t('数据集', 'Dataset')}<select value={selectedSource} onChange={(event) => { setSourceId(event.target.value); setScopeColumnIds(null); setStartRow(''); setEndRow(''); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail">{datasets.map((item) => <option key={item.id} value={item.id}>{item.name} · {t(`${formatNumber(item.rowCount)} 行`, `${formatNumber(item.rowCount)} rows`)}</option>)}</select></label> : null}
        <label className="block space-y-1 text-meta text-ink-3">{t('文件格式', 'File format')}<select value={format} onChange={(event) => { defaultsTouched.current = true; const next = event.target.value as typeof format; setFormat(next); if (next === 'tsv' || next === 'csv') setTextOptions((current) => ({ ...current, delimiter: next === 'tsv' ? '\t' : ',' })); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="csv">{t('CSV（逗号分隔）', 'CSV (comma separated)')}</option><option value="tsv">{t('TSV（制表符分隔）', 'TSV (tab separated)')}</option><option value="xlsx">{t('Excel 工作簿（XLSX）', 'Excel workbook (XLSX)')}</option><option value="ods">{t('OpenDocument 工作簿（ODS）', 'OpenDocument workbook (ODS)')}</option><option value="json">{t('JSON 对象数组', 'JSON object array')}</option><option value="jsonl">JSON Lines</option><option value="parquet">{t('Parquet（所有字段按文本）', 'Parquet (all fields as text)')}</option></select></label>
        <label className="block space-y-1 text-meta text-ink-3">{t('下载文件名（可选，不含扩展名）', 'Download filename (optional, without extension)')}<input value={outputName} maxLength={120} onChange={(event) => { setOutputName(event.target.value); changeKey() }} placeholder={t('留空时使用数据集名称', 'Use dataset name if blank')} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
        {!outputNameValid ? <Banner tone="warn">{t('文件名不能包含路径分隔符或控制字符。', 'Filename cannot contain path separators or control characters.')}</Banner> : null}
        {(format === 'xlsx' || format === 'ods') ? <><p className="text-meta text-ink-3">{t('工作簿中的单元格全部按文本写入，保留编号前导零及长整数。数据超过格式行列上限时会阻止提交。', 'Workbook cells are written as text to retain leading zeros and long integers. Export is blocked if data exceeds the format limits for rows or columns.')}</p>
          <label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={multiWorkbook} onChange={(event) => { setMultiWorkbook(event.target.checked); changeKey() }} />{t('一个工作簿包含多个数据集', 'Include multiple datasets in one workbook')}</label>
          {!multiWorkbook ? <label className="block space-y-1 text-meta text-ink-3">{t('工作表名称（可选）', 'Sheet name (optional)')}<input value={singleSheetName} maxLength={31} onChange={(event) => { setSingleSheetName(event.target.value); changeKey() }} placeholder={t('留空时使用默认名称', 'Use the default name if blank')} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label> : null}
          {!multiWorkbook ? <div className="space-y-2"><label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={splitWorkbook} onChange={(event) => { setSplitWorkbook(event.target.checked); changeKey() }} />{t('按行拆成多张工作表', 'Split rows across worksheets')}</label>{splitWorkbook ? <label className="block space-y-1 text-meta text-ink-3">{t('每张工作表最多的数据行数（最多 20 张）', 'Maximum data rows per worksheet (up to 20 sheets)')}<input type="number" min={1} max={1048575} value={rowsPerSheet} onChange={(event) => { setRowsPerSheet(event.target.value); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label> : null}</div> : null}
          {multiWorkbook ? <div className="space-y-2 rounded-control border border-line p-3"><p className="text-meta text-ink-3">{t('按勾选顺序创建工作表，最多 20 个。每个工作表名称需唯一且不超过 31 个字符。', 'Create sheets in selection order, up to 20. Each sheet name must be unique and at most 31 characters.')}</p>{datasets.map((item) => {
            const index = workbookIds.indexOf(item.id)
            return <div key={item.id} className="flex flex-wrap items-center gap-2"><label className="flex min-w-56 items-center gap-2 text-cell"><input type="checkbox" checked={index >= 0} onChange={(event) => { setWorkbookIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)); changeKey() }} />{item.name}</label>{index >= 0 ? <input aria-label={t(`${item.name} 工作表名称`, `${item.name} sheet name`)} value={sheetNames[item.id] ?? `Sheet${index + 1}`} onChange={(event) => { setSheetNames((current) => ({ ...current, [item.id]: event.target.value })); changeKey() }} className="h-9 min-w-40 rounded-control bg-surface px-2 text-cell" /> : null}</div>
          })}{!workbookValid ? <Banner tone="warn">{t('请选择 2 至 20 个数据集，并为工作表设置有效且不重复的名称。', 'Select 2 to 20 datasets and give each sheet a valid, unique name.')}</Banner> : null}</div> : null}</> : null}
        {!workbook || workbook.sourceIds.length === 1 ? <div className="space-y-3 rounded-control bg-surface-sunk p-3"><label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={limitedScope} onChange={(event) => { setLimitedScope(event.target.checked); changeKey() }} />{t('只导出指定行范围与字段', 'Export selected rows and fields only')}</label>{limitedScope ? <><div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('起始行（从 1 开始）', 'Start row (from 1)')}<input type="number" min={1} value={startRow} placeholder={t('第 1 行', 'Row 1')} onChange={(event) => { setStartRow(event.target.value); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label><label className="text-meta">{t('结束行（含该行）', 'End row (inclusive)')}<input type="number" min={1} value={endRow} placeholder={t(`最后一行 ${schema.data?.rowCount ?? ''}`, `Last row ${schema.data?.rowCount ?? ''}`)} onChange={(event) => { setEndRow(event.target.value); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label></div><p className="text-meta text-ink-3">{t('仅勾选需要输出的字段；顺序保持原数据顺序。范围指固定数据集版本的全局行号。', 'Select the fields to export. Their original order is preserved. Row numbers refer to the complete fixed dataset version.')}</p><div className="grid max-h-40 gap-1 overflow-auto sm:grid-cols-2">{schema.data?.columns.map((column) => <label key={column.id} className="flex items-center gap-2 text-cell"><input type="checkbox" checked={(scopeColumnIds ?? schema.data!.columns.map((item) => item.id)).includes(column.id)} onChange={(event) => { setScopeColumnIds((current) => { const base = current ?? schema.data!.columns.map((item) => item.id); return event.target.checked ? [...base, column.id] : base.filter((id) => id !== column.id) }); changeKey() }} />{column.name}</label>)}</div>{!scopeValid ? <Banner tone="warn">{t('请选择有效行范围和至少一个字段。', 'Select a valid row range and at least one field.')}</Banner> : null}</> : null}</div> : null}
        {(format === 'json' || format === 'jsonl') ? <><p className="text-meta text-ink-3">{t('默认全部按字符串写出以保留长编号。数值类型要求最多 15 位有效数字；解析失败会使任务失败，不会静默改值。', 'Fields are strings by default to preserve long IDs. Numeric values can have at most 15 significant digits; an invalid value fails the job instead of being changed silently.')}</p><label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={jsonOptions.emptyAsNull} onChange={(event) => { setJsonOptions((current) => ({ ...current, emptyAsNull: event.target.checked })); changeKey() }} />{t('将空文本写为 null', 'Write empty text as null')}</label><div className="grid gap-2 sm:grid-cols-2">{schema.data?.columns.map((column) => <label key={column.id} className="text-meta">{column.name}<select value={jsonOptions.types[column.id] ?? 'text'} onChange={(event) => { setJsonOptions((current) => ({ ...current, types: { ...current.types, [column.id]: event.target.value as JsonExportOptions['types'][string] } })); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="text">{t('文本', 'Text')}</option><option value="integer">{t('整数', 'Integer')}</option><option value="decimal">{t('小数', 'Decimal')}</option><option value="boolean">{t('布尔值', 'Boolean')}</option><option value="date">{t('日期文本', 'Date text')}</option></select></label>)}</div></> : null}
        {format === 'parquet' ? <div className="space-y-2 text-meta text-ink-3"><p>{t('所有字段按字符串写入 Parquet，以保留前导零和长整数；此导出不会自动推断数值或日期类型。下列是当前数据集已确认的类型，与输出文件类型可能不同：', 'All fields are written to Parquet as strings to preserve leading zeros and long integers. This export does not infer numeric or date types. The confirmed types below may differ from the output file types:')}</p><div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-auto">{schema.data?.columns.map((column) => <span key={column.id}>{column.name}{t('：', ': ')}{column.type}</span>)}</div></div> : null}
        {format === 'csv' || format === 'tsv' ? <><div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('编码', 'Encoding')}<select value={textOptions.encoding} onChange={(event) => { const encoding = event.target.value as TextExportOptions['encoding']; setTextOptions((current) => ({ ...current, encoding, bom: encoding === 'gb18030' ? false : current.bom })); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030</option></select></label><label className="text-meta">{t('分隔符', 'Delimiter')}<select value={textOptions.delimiter} onChange={(event) => { setTextOptions((current) => ({ ...current, delimiter: event.target.value as TextExportOptions['delimiter'] })); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value=",">{t('逗号', 'Comma')}</option><option value=";">{t('分号', 'Semicolon')}</option><option value={'\t'}>{t('制表符', 'Tab')}</option><option value="|">{t('竖线', 'Vertical bar')}</option></select></label><label className="text-meta">{t('引号', 'Quote')}<select value={textOptions.quote} onChange={(event) => { setTextOptions((current) => ({ ...current, quote: event.target.value as TextExportOptions['quote'] })); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value={'"'}>{t('双引号', 'Double quote')}</option><option value={"'"}>{t('单引号', 'Single quote')}</option></select></label><label className="text-meta">{t('换行', 'Newline')}<select value={textOptions.newline} onChange={(event) => { setTextOptions((current) => ({ ...current, newline: event.target.value as TextExportOptions['newline'] })); changeKey() }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="lf">LF</option><option value="crlf">CRLF</option></select></label></div><label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={textOptions.bom} disabled={textOptions.encoding === 'gb18030'} onChange={(event) => { setTextOptions((current) => ({ ...current, bom: event.target.checked })); changeKey() }} />{t('输出 BOM（GB18030 不适用）', 'Write BOM (not available for GB18030)')}</label><label className="flex items-start gap-2 text-cell text-ink-2"><input type="checkbox" checked={safeText} onChange={(event) => { defaultsTouched.current = true; setSafeText(event.target.checked); changeKey() }} /><span>{t('保护可能被电子表格软件当作公式的文本。启用后，这些值会以文本形式导出。', 'Protect text that spreadsheet software may interpret as a formula. When enabled, these values are exported as text.')}</span></label></> : null}
        {(format === 'csv' || format === 'tsv') && !safeText ? <Banner tone="warn">{t('关闭文本保护后，使用电子表格软件打开文件时，以 =、+、-、@ 开头的值可能被当作公式。', 'Without text protection, values starting with =, +, - or @ may be interpreted as formulas by spreadsheet software.')}</Banner> : null}
        <div className="space-y-2 rounded-control border border-line p-3"><p className="text-cell font-medium">{t('导出前检查', 'Check before export')}</p><p className="text-meta text-ink-3">{t('核对行列范围、字段类型和目标格式限制。文本、工作簿和 JSON 的所选内容会逐行检查；大文件可能需要较长时间。', 'Check row and column ranges, field types and format limits. Selected text, workbook and JSON content is checked row by row; large files may take longer.')}</p>
          <Button type="button" variant="secondary" disabled={!sourceValid || !workbookValid || !scopeValid || !outputNameValid || preflight.isPending} onClick={() => preflight.mutate()}>{preflight.isPending ? t('正在检查…', 'Checking…') : t('检查当前配置', 'Check current settings')}</Button>
          {preflight.error ? <Banner tone="danger" title={t('导出预检失败', 'Export check failed')}>{preflight.error.message}</Banner> : null}
          {preflight.data?.signature === preflightSignature ? preflight.data.result.ready ? <div className="space-y-1 text-meta text-ink-2"><p>{t(`范围：${preflight.data.result.sources.length} 个数据集，${formatNumber(preflight.data.result.rows)} 行，最多 ${preflight.data.result.columns} 列。`, `Scope: ${preflight.data.result.sources.length} datasets, ${formatNumber(preflight.data.result.rows)} rows, up to ${preflight.data.result.columns} columns.`)}</p>{preflight.data.result.notes.map((note) => <p key={note}>{localizedExportFinding(note)}</p>)}</div> : <Banner tone="warn">{localizedExportFinding(preflight.data.result.problem ?? '')}</Banner> : <p className="text-meta text-ink-3">{t('当前配置尚未检查。', 'Current settings have not been checked.')}</p>}
        </div>
        {submit.error ? <Banner tone="danger" title={t('导出未提交', 'Export was not submitted')}>{submit.error.message}</Banner> : null}
        <Button type="submit" variant="primary" disabled={!sourceValid || !workbookValid || !scopeValid || !outputNameValid || !preflightReady || submit.isPending}>{scope ? t('导出所选行和字段', 'Export selected rows and fields') : workbook && workbook.sourceIds.length > 1 ? t('导出多工作表', 'Export multiple sheets') : t('导出完整数据集', 'Export complete dataset')}</Button>
      </form>
    </Panel>
    <BatchExportPanel datasets={datasets} format={format} safeText={safeText} textOptions={textOptions} jsonOptions={jsonOptions} />
  </PageBody></>
}
