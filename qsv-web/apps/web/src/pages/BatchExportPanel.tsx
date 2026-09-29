import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { api, type ExportPreflight, type ExportScope, type JsonExportOptions, type Resource, type TextExportOptions } from '@/api/client'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { Button } from '@/ui/Button'
import { Banner } from '@/ui/Feedback'
import { SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { formatNumber } from '@/lib/format'
import { localizedExportFinding } from '@/lib/export-findings'

type Format = 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'
interface Override {
  outputName?: string
  format?: Format
  safeText?: boolean
  textOptions?: TextExportOptions
  jsonOptions?: JsonExportOptions
  limitedScope?: boolean
  startRow?: string
  endRow?: string
  columnIds?: string[]
}
const selectClass = 'block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail'

export function BatchExportPanel({ datasets, format, safeText, textOptions, jsonOptions }: {
  datasets: Resource[]; format: Format; safeText: boolean; textOptions: TextExportOptions; jsonOptions: JsonExportOptions
}) {
  const t = useT()
  const client = useQueryClient()
  const [selectedIds, setSelectedIds] = useSessionDraft<string[]>('BatchExportPanel.selectedIds', [])
  const [overrides, setOverrides] = useSessionDraft<Record<string, Override>>('BatchExportPanel.overrides', {})
  const selectedResources = useQueries({ queries: selectedIds.map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const available = [...new Map([...datasets, ...selectedResources.map((query) => query.data).filter((item) => Boolean(item))]
    .map((item) => [item!.id, item!] as const)).values()].filter((item) => item.kind === 'dataset' && item.status === 'ready')
  const schemas = useQueries({ queries: selectedIds.map((id) => ({ queryKey: ['schema', id], queryFn: () => api.schema(id) })) })
  const update = (id: string, patch: Partial<Override>) => setOverrides((current) => ({ ...current, [id]: { ...current[id], ...patch } }))
  const files = selectedIds.flatMap((id, index) => {
    const resource = available.find((item) => item.id === id)
    if (!resource) return []
    const schema = schemas[index]?.data
    const own = overrides[id] ?? {}
    const outputFormat = own.format ?? format
    const outputText = own.textOptions ?? (own.format && own.format !== format ? { ...textOptions,
      delimiter: own.format === 'tsv' ? '\t' as const : own.format === 'csv' ? ',' as const : textOptions.delimiter } : textOptions)
    const outputJson = own.jsonOptions ?? { ...jsonOptions, types: Object.fromEntries(Object.entries(jsonOptions.types)
      .filter(([columnId]) => Number(columnId.slice(2)) < (schema?.columns.length ?? 0))) }
    const scope: ExportScope | undefined = own.limitedScope ? {
      startRow: own.startRow ? Number(own.startRow) : 1,
      endRow: own.endRow ? Number(own.endRow) : schema?.rowCount ?? 0,
      columnIds: own.columnIds ?? schema?.columns.map((column) => column.id) ?? [],
    } : undefined
    const scopeValid = !scope || Number.isSafeInteger(scope.startRow) && Number.isSafeInteger(scope.endRow) &&
      scope.startRow >= 1 && scope.endRow >= scope.startRow && scope.endRow <= (schema?.rowCount ?? 0) &&
      scope.columnIds.length > 0 && new Set(scope.columnIds).size === scope.columnIds.length &&
      scope.columnIds.every((columnId) => schema?.columns.some((column) => column.id === columnId))
    return [{ resource, schema, own, format: outputFormat, safeText: own.safeText ?? safeText,
      textOptions: outputText, jsonOptions: outputJson, scope, scopeValid }]
  })
  const signature = JSON.stringify(files.map((file) => ({ id: file.resource.id, hash: file.resource.contentHash, format: file.format,
    safeText: file.safeText, textOptions: file.textOptions, jsonOptions: file.jsonOptions, scope: file.scope, outputName: file.own.outputName })))
  const batchKey = useMemo(() => `export_${crypto.randomUUID()}`, [signature])
  const valid = files.length >= 2 && files.length <= 20 && files.length === selectedIds.length && files.every((file) => file.schema &&
    file.scopeValid && (!file.own.outputName || Boolean(file.own.outputName.trim() && file.own.outputName.trim() !== '.' &&
      file.own.outputName.trim() !== '..' && file.own.outputName.length <= 120 &&
      !/[\\/\x00-\x1f\x7f]/u.test(file.own.outputName))))
  const preflight = useMutation({ mutationFn: async () => {
    const results: { name: string; result: ExportPreflight }[] = []
    for (const file of files) {
      try {
        const result = await api.exportPreflight(file.resource.id, file.format, file.safeText,
          file.format === 'csv' || file.format === 'tsv' ? file.textOptions : undefined,
          file.format === 'json' || file.format === 'jsonl' ? file.jsonOptions : undefined, undefined, file.scope)
        results.push({ name: file.resource.name, result })
      } catch (error) {
        throw new Error(`${file.resource.name}${t('：', ': ')}${error instanceof Error ? error.message : t('预检失败', 'Export check failed')}`)
      }
    }
    return { signature, results }
  } })
  const preflightReady = preflight.data?.signature === signature && preflight.data.results.every((entry) => entry.result.ready)
  const submit = useMutation({ mutationFn: async () => {
    const outcomes: { name: string; jobId?: string; error?: string }[] = []
    for (const [index, file] of files.entries()) {
      try {
        const result = await api.export(file.resource.id, file.format, file.safeText, `${batchKey}_${index}`,
          file.format === 'csv' || file.format === 'tsv' ? file.textOptions : undefined,
          file.format === 'json' || file.format === 'jsonl' ? file.jsonOptions : undefined, undefined, file.scope,
          file.own.outputName?.trim() || undefined)
        outcomes.push({ name: file.resource.name, jobId: result.job.id })
      } catch (error) {
        outcomes.push({ name: file.resource.name, error: error instanceof Error ? error.message : t('提交失败', 'Submission failed') })
      }
    }
    return { signature, outcomes }
  }, onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
  } })
  const toggle = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) :
    current.length < 20 ? [...current, id] : current)
  return <Panel className="max-w-4xl space-y-4"><SectionTitle title={t('多个数据集分别导出', 'Export datasets separately')} />
    <p className="text-cell text-ink-2">{t('每份数据集生成独立的导出任务。先设置上方的统一配置，再为需要不同格式、编码、类型或范围的文件调整各自选项。某份提交失败不会取消已经提交的任务。', 'Each dataset creates its own export job. Set shared options above, then adjust the format, encoding, types or range for individual files. A failed submission does not cancel jobs already submitted.')}</p>
    <DraftInputWarning ids={selectedIds} availableIds={available.map((item) => item.id)} loading={selectedResources.some((query) => query.isLoading)} />
    <div className="grid max-h-52 gap-1 overflow-auto sm:grid-cols-2">{available.map((item) => <label key={item.id} className="flex items-center gap-2 text-cell"><input type="checkbox" checked={selectedIds.includes(item.id)} disabled={!selectedIds.includes(item.id) && selectedIds.length >= 20} onChange={() => toggle(item.id)} /><span className="min-w-0 truncate">{item.name}</span></label>)}</div>
    {files.map((file) => <div key={file.resource.id} className="space-y-3 rounded-control border border-line p-3"><strong className="text-cell">{file.resource.name}</strong>
      <label className="block text-meta">{t('此文件的下载名称（可选，不含扩展名）', 'Filename for this export (optional, without extension)')}<input value={file.own.outputName ?? ''} maxLength={120} onChange={(event) => update(file.resource.id, { outputName: event.target.value })} placeholder={t('留空时使用数据集名称', 'Use dataset name if blank')} className={selectClass} /></label>
      {schemas[selectedIds.indexOf(file.resource.id)]?.error ? <Banner tone="danger">{t('字段信息读取失败', 'Could not load field information')}</Banner> : null}
      <div className="grid gap-2 sm:grid-cols-3"><label className="text-meta">{t('输出格式', 'Output format')}<select value={file.own.format ?? 'default'} onChange={(event) => update(file.resource.id, { format: event.target.value === 'default' ? undefined : event.target.value as Format })} className={selectClass}><option value="default">{t(`沿用统一配置（${format.toUpperCase()}）`, `Use shared settings (${format.toUpperCase()})`)}</option><option value="csv">CSV</option><option value="tsv">TSV</option><option value="xlsx">XLSX</option><option value="ods">ODS</option><option value="json">JSON</option><option value="jsonl">JSONL</option><option value="parquet">Parquet</option></select></label>
      {(file.format === 'csv' || file.format === 'tsv') ? <><label className="text-meta">{t('文本保护', 'Text protection')}<select value={file.own.safeText === undefined ? 'default' : String(file.own.safeText)} onChange={(event) => update(file.resource.id, { safeText: event.target.value === 'default' ? undefined : event.target.value === 'true' })} className={selectClass}><option value="default">{t(`沿用统一配置（${safeText ? '开启' : '关闭'}）`, `Use shared settings (${safeText ? 'on' : 'off'})`)}</option><option value="true">{t('开启', 'On')}</option><option value="false">{t('关闭', 'Off')}</option></select></label><label className="text-meta">{t('编码', 'Encoding')}<select value={file.textOptions.encoding} onChange={(event) => update(file.resource.id, { textOptions: { ...file.textOptions, encoding: event.target.value as TextExportOptions['encoding'], bom: event.target.value === 'gb18030' ? false : file.textOptions.bom } })} className={selectClass}><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030</option></select></label><label className="text-meta">{t('分隔符', 'Delimiter')}<select value={file.textOptions.delimiter} onChange={(event) => update(file.resource.id, { textOptions: { ...file.textOptions, delimiter: event.target.value as TextExportOptions['delimiter'] } })} className={selectClass}><option value=",">{t('逗号', 'Comma')}</option><option value=";">{t('分号', 'Semicolon')}</option><option value={'\t'}>{t('制表符', 'Tab')}</option><option value="|">{t('竖线', 'Vertical bar')}</option></select></label><label className="text-meta">{t('引号', 'Quote')}<select value={file.textOptions.quote} onChange={(event) => update(file.resource.id, { textOptions: { ...file.textOptions, quote: event.target.value as TextExportOptions['quote'] } })} className={selectClass}><option value={'"'}>{t('双引号', 'Double quote')}</option><option value={"'"}>{t('单引号', 'Single quote')}</option></select></label><label className="text-meta">{t('换行', 'Newline')}<select value={file.textOptions.newline} onChange={(event) => update(file.resource.id, { textOptions: { ...file.textOptions, newline: event.target.value as TextExportOptions['newline'] } })} className={selectClass}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label><label className="flex items-center gap-2 text-meta"><input type="checkbox" checked={file.textOptions.bom} disabled={file.textOptions.encoding === 'gb18030'} onChange={(event) => update(file.resource.id, { textOptions: { ...file.textOptions, bom: event.target.checked } })} />{t('输出 BOM', 'Write BOM')}</label></> : null}</div>
      {(file.format === 'json' || file.format === 'jsonl') ? <div className="space-y-2"><label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={file.jsonOptions.emptyAsNull} onChange={(event) => update(file.resource.id, { jsonOptions: { ...file.jsonOptions, emptyAsNull: event.target.checked } })} />{t('空文本写为 null', 'Write empty text as null')}</label><div className="grid gap-2 sm:grid-cols-2">{file.schema?.columns.map((column) => <label key={column.id} className="text-meta">{column.name}<select value={file.jsonOptions.types[column.id] ?? 'text'} onChange={(event) => update(file.resource.id, { jsonOptions: { ...file.jsonOptions, types: { ...file.jsonOptions.types, [column.id]: event.target.value as JsonExportOptions['types'][string] } } })} className={selectClass}><option value="text">{t('文本', 'Text')}</option><option value="integer">{t('整数', 'Integer')}</option><option value="decimal">{t('小数', 'Decimal')}</option><option value="boolean">{t('布尔值', 'Boolean')}</option><option value="date">{t('日期文本', 'Date text')}</option></select></label>)}</div></div> : null}
      <label className="flex items-center gap-2 text-cell"><input type="checkbox" checked={file.own.limitedScope ?? false} onChange={(event) => update(file.resource.id, { limitedScope: event.target.checked })} />{t('只导出此文件的指定范围', 'Export a selected range from this dataset only')}</label>
      {file.own.limitedScope ? <div className="space-y-2"><div className="grid gap-2 sm:grid-cols-2"><label className="text-meta">{t('起始行', 'Start row')}<input type="number" min={1} value={file.own.startRow ?? ''} placeholder="1" onChange={(event) => update(file.resource.id, { startRow: event.target.value })} className={selectClass} /></label><label className="text-meta">{t('结束行', 'End row')}<input type="number" min={1} value={file.own.endRow ?? ''} placeholder={String(file.schema?.rowCount ?? '')} onChange={(event) => update(file.resource.id, { endRow: event.target.value })} className={selectClass} /></label></div><div className="grid max-h-32 gap-1 overflow-auto sm:grid-cols-2">{file.schema?.columns.map((column) => <label key={column.id} className="flex items-center gap-2 text-cell"><input type="checkbox" checked={(file.own.columnIds ?? file.schema!.columns.map((item) => item.id)).includes(column.id)} onChange={(event) => { const current = file.own.columnIds ?? file.schema!.columns.map((item) => item.id); update(file.resource.id, { columnIds: event.target.checked ? [...current, column.id] : current.filter((id) => id !== column.id) }) }} />{column.name}</label>)}</div>{!file.scopeValid ? <Banner tone="warning">{t('此文件的行范围或字段选择无效。', 'Invalid row range or field selection for this dataset.')}</Banner> : null}</div> : null}
    </div>)}
    {preflight.error ? <Banner tone="danger" title={t('多文件预检失败', 'Batch export check failed')}>{preflight.error.message}</Banner> : null}
    {preflight.data?.signature === signature ? <div className="space-y-1 text-meta text-ink-2">{preflight.data.results.map((entry) => <p key={entry.name}>{entry.name}{t('：', ': ')}{entry.result.ready ? t(`可导出 ${formatNumber(entry.result.rows)} 行`, `${formatNumber(entry.result.rows)} rows ready for export`) : localizedExportFinding(entry.result.problem ?? '')}</p>)}</div> : null}
    {submit.data?.signature === signature ? <div className="space-y-1 text-cell">{submit.data.outcomes.map((outcome, index) => <p key={`${outcome.name}-${index}`}>{outcome.name}{t('：', ': ')}{outcome.jobId ? <Link to="/jobs/$jobId" params={{ jobId: outcome.jobId }} className="text-accent-ink hover:underline">{t('查看导出任务', 'View export job')}</Link> : t(`提交失败：${outcome.error}`, `Submission failed: ${outcome.error}`)}</p>)}</div> : null}
    <div className="flex flex-wrap gap-2"><Button disabled={!valid || preflight.isPending || submit.isPending} onClick={() => preflight.mutate()}>{t('逐文件预检', 'Check each export')}</Button><Button variant="primary" disabled={!valid || !preflightReady || submit.isPending} onClick={() => submit.mutate()}>{t(`分别创建 ${files.length} 个导出任务`, `Create ${files.length} separate export jobs`)}</Button></div>
  </Panel>
}
