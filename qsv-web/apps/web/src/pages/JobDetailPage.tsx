import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Job } from '@/api/client'
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format'
import { Button } from '@/ui/Button'
import { KeyValueList } from '@/ui/Data'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { localizedCleanReason, localizedErrorMessage } from '@/lib/errors'
import { localizedStage } from '@/lib/stage'

const stateLabel: Record<Job['state'], string> = {
  draft: '草稿', queued: '排队中', running: '运行中', cancel_requested: '正在取消',
  cancelled: '已取消', succeeded: '完成', failed: '失败', interrupted: '已中断',
}

const stateLabelEn: Record<Job['state'], string> = {
  draft: 'Draft', queued: 'Queued', running: 'Running', cancel_requested: 'Cancelling',
  cancelled: 'Cancelled', succeeded: 'Completed', failed: 'Failed', interrupted: 'Interrupted',
}

const outputStatus: Record<string, [string, string]> = {
  staging: ['准备中', 'Preparing'], building: ['生成中', 'Building'], ready: ['可用', 'Ready'],
  failed: ['未完成', 'Failed'], trashed: ['已移入回收站', 'In trash'],
  missing: ['已永久删除或不可读取', 'Permanently removed or unavailable'],
}

const outputKind: Record<string, [string, string]> = {
  raw: ['原文件', 'Original file'], dataset: ['数据集', 'Dataset'],
  report: ['报告', 'Report'], export: ['导出文件', 'Export file'], view: ['视图', 'View'],
}

const recipeSourceKinds = new Set(['filter', 'clean', 'clean-plan', 'dedup', 'quality', 'analyze', 'export', 'split',
  'reshape', 'combine', 'relation', 'set', 'filter-plan', 'sql', 'compare'])

const ruleLabels: Record<string, string> = {
  operation: '操作', csv: 'CSV 解析', json: 'JSON 解析', columnTypes: '字段类型', sheetName: '工作表',
  columnId: '字段', columnIds: '字段列表', mode: '处理方式', value: '指定值', find: '查找内容',
  replacement: '替换内容', dateFormat: '日期格式', plan: '处理步骤与条件', format: '输出格式',
  safeText: '电子表格安全文本', textOptions: '文本文件选项', jsonOptions: 'JSON 选项',
  workbook: '工作簿与工作表', scope: '输出范围', outputName: '下载文件名', config: '处理规则',
  relationConfig: '关联规则', setConfig: '集合规则', reshapeConfig: '重组规则', sql: 'SQL 原文',
  parameters: 'SQL 参数', rules: '检查规则', outputMode: '输出模式', aggregate: '汇总规则',
  pivot: '透视规则', frequencyColumnId: '频率字段', recipeSpec: '模板固定版本',
  parameterValues: '本次参数', recipeVersion: '模板版本', patches: '单元格修正',
}

const ruleLabelsEn: Record<string, string> = {
  operation: 'Operation', csv: 'CSV parsing', json: 'JSON parsing', columnTypes: 'Field types', sheetName: 'Sheet',
  columnId: 'Field', columnIds: 'Fields', mode: 'Method', value: 'Value', find: 'Find', replacement: 'Replacement',
  dateFormat: 'Date format', plan: 'Steps and conditions', format: 'Output format', safeText: 'Spreadsheet-safe text',
  textOptions: 'Text file options', jsonOptions: 'JSON options', workbook: 'Workbook and sheets', scope: 'Output scope',
  outputName: 'Download filename', config: 'Processing rules', relationConfig: 'Join rules', setConfig: 'Set rules',
  reshapeConfig: 'Reshape rules', sql: 'SQL statement', parameters: 'SQL parameters', rules: 'Check rules',
  outputMode: 'Output mode', aggregate: 'Aggregation rules', pivot: 'Pivot rules', frequencyColumnId: 'Frequency field',
  recipeSpec: 'Saved template version', parameterValues: 'Run parameters', recipeVersion: 'Template version', patches: 'Cell changes',
}

function RuleField({ name, value }: { name: string; value: unknown }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return <div className="border-t border-hairline-soft py-2 text-cell"><button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-left text-accent-ink hover:underline">{t(ruleLabels[name] ?? name, ruleLabelsEn[name] ?? name)} {open ? t('收起', 'Hide') : t('查看', 'View')}</button>
    {open ? <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface-sunk p-3 text-meta text-ink-2">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre> : null}
  </div>
}

function RuleSnapshot({ job }: { job: Job }) {
  const t = useT()
  const excluded = new Set(['sourceId', 'sourceIds', 'sourceHash', 'sourceHashes', 'leftId', 'rightId', 'leftHash', 'rightHash', 'preflightJobId', 'recipeId'])
  const entries = Object.entries(job.spec).filter(([name]) => !excluded.has(name))
  return <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('提交时的固定规则', 'Rules saved at submission')} /><p className="text-meta text-ink-3">{t('这里显示任务提交时保存的配置。后续修改工具页或模板，不会改变这份记录。输入资源编号与引擎版本见上方执行记录。', 'These settings were saved when the job was submitted. Later edits to tools or templates do not change this record. Input resource IDs and the engine version appear above.')}</p>
    <p className="figure break-all text-meta text-ink-3">{t('规则摘要：', 'Rules hash: ')}{job.specHash}</p>
    {entries.length ? entries.map(([name, value]) => <RuleField key={name} name={name} value={value} />) : <p className="text-cell text-ink-3">{t('此任务没有额外处理选项。', 'This job has no additional processing options.')}</p>}
  </Panel>
}

export function JobDetailPage() {
  const t = useT()
  const jobState = (state: Job['state']) => t(stateLabel[state], stateLabelEn[state])
  const { jobId } = useParams({ from: '/jobs/$jobId' })
  const navigate = useNavigate()
  const client = useQueryClient()
  const job = useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId), refetchInterval: (query) => ['queued', 'running', 'cancel_requested'].includes(query.state.data?.state ?? '') ? 1500 : false })
  const cancel = useMutation({ mutationFn: () => api.cancel(jobId), onSuccess: () => { void client.invalidateQueries({ queryKey: ['job', jobId] }); void client.invalidateQueries({ queryKey: ['jobs'] }); void client.invalidateQueries({ queryKey: ['overview'] }) } })
  const retry = useMutation({ mutationFn: () => api.retry(jobId, `retry_${jobId}`), onSuccess: (result) => { void client.invalidateQueries({ queryKey: ['jobs'] }); void client.invalidateQueries({ queryKey: ['overview'] }); void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } }) } })
  const item = job.data
  const outputResource = useQuery({ queryKey: ['resource', item?.summary.outputId],
    queryFn: () => api.resource(item!.summary.outputId!), enabled: item?.state === 'succeeded' && Boolean(item.summary.outputId) })
  const primaryOutputId = item?.summary.outputId
  const primaryOutputReady = Boolean(primaryOutputId && item?.outputs?.some((output) =>
    output.id === primaryOutputId && output.status === 'ready'))
  const cleanResult = item?.kind === 'clean' ? outputResource.data?.metadata.cleanResult as {
    steps?: { step: number; type: string; rowsIn: number; rowsOut: number; changed: number; errors: number;
      sampleErrors: { row: number; value: string; reason?: string }[]; duplicateGroups?: number; duplicateMembers?: number; emptyRows?: number }[]
    reports?: { step: number; kind: 'errors' | 'duplicates' | 'empty-rows'; file: string; rows: number; bytes: number; sha256: string }[]
  } | undefined : undefined
  const relationReports = item?.kind === 'combine' ? outputResource.data?.metadata.relationReports as
    { side: 'left' | 'right'; file: string; rows: number; bytes: number; sha256: string }[] | undefined : undefined
  const relationSummary = item?.kind === 'combine' ? outputResource.data?.metadata.relationSummary as {
    leftRows: number; rightRows: number; matchedPairs: number; matchedLeftRows: number; matchedRightRows: number;
    unmatchedLeftRows: number; unmatchedRightRows: number; outputRows: number
  } | undefined : undefined
  const jsonImportReport = item?.kind === 'import' ? outputResource.data?.metadata.jsonImportReport as
    { file: string; rows: number; bytes: number; sha256: string } | undefined : undefined
  const jsonConversionReport = item?.kind === 'import' ? outputResource.data?.metadata.jsonConversionReport as
    { file: string; rows: number; bytes: number; sha256: string } | undefined : undefined
  const csvImportReport = item?.kind === 'import' ? outputResource.data?.metadata.csvImportReport as
    { file: string; rows: number; bytes: number; sha256: string } | undefined : undefined
  const diagnostic = item ? {
    taskId: item.id, kind: item.kind, state: item.state, stage: item.progress.stage ?? '未知',
    createdAt: item.createdAt, startedAt: item.startedAt, finishedAt: item.finishedAt,
    inputIds: item.inputIds, outputId: item.summary.outputId ?? null,
    rowsIn: item.summary.rowsIn ?? null, rowsOut: item.summary.rowsOut ?? null,
    error: item.error ? { code: item.error.code, retryable: item.error.retryable } : null,
    engineVersion: item.engineVersion,
    events: item.progress.events ?? [], eventsTruncated: item.progress.eventsTruncated ?? false,
  } : null
  const downloadDiagnostic = () => {
    if (!diagnostic) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `${item!.id}-summary.json`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <><PageTopBar title={item?.name ?? t('任务详情', 'Job details')} facts={item ? <span className="text-meta text-ink-2">{jobState(item.state)}</span> : undefined} actions={<Link to="/jobs" className="press text-cell text-accent-ink hover:underline">{t('返回任务列表', 'Back to jobs')}</Link>} />
    <PageBody className="space-y-4">
      {job.isLoading ? <Spinner /> : null}
      {job.error ? <Banner tone="danger" title={t('任务读取失败', 'Could not load job')}>{job.error instanceof Error ? job.error.message : t('请稍后重试', 'Please try again later')}</Banner> : null}
      {item ? <>
        {item.error ? <Banner tone="danger" title={localizedErrorMessage(item.error.code, item.error.message)}><span className="figure">{t('错误代码：', 'Error code: ')}{item.error.code}</span>{item.error.retryable === false ? t(' · 原输入或规则需要修正', ' · Input or rules need correction') : null}</Banner> : null}
        {cancel.error || retry.error ? <Banner tone="danger" title={t('操作未完成', 'Operation not completed')}>{(cancel.error ?? retry.error) instanceof Error ? (cancel.error ?? retry.error)!.message : t('请稍后重试', 'Please try again later')}</Banner> : null}
        <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('执行记录', 'Execution record')} /><KeyValueList items={[
          { label: t('状态', 'Status'), value: jobState(item.state) },
          { label: t('当前阶段', 'Current stage'), value: localizedStage(item.progress.stage) },
          { label: t('进度', 'Progress'), value: item.progress.percent === null || item.progress.percent === undefined
            ? t('百分比未知；按阶段显示', 'Percentage unknown; showing stage')
            : `${Math.max(0, Math.min(100, item.progress.percent)).toFixed(1)}%` },
          { label: t('输入资源', 'Input resources'), value: item.inputIds.join(', ') || t('无', 'None'), mono: true },
          { label: t('输入行数', 'Input rows'), value: formatNumber(item.summary.rowsIn) },
          { label: t('输出行数', 'Output rows'), value: formatNumber(item.summary.rowsOut) },
          ...(item.kind === 'dedup' && item.summary.rowsIn !== null && item.summary.rowsIn !== undefined && item.summary.rowsOut !== null && item.summary.rowsOut !== undefined
            ? [{ label: t('移除重复行', 'Duplicate rows removed'), value: formatNumber(item.summary.rowsIn - item.summary.rowsOut) }] : []),
          { label: t('创建时间', 'Created'), value: formatDateTime(item.createdAt) },
          { label: t('开始时间', 'Started'), value: formatDateTime(item.startedAt) },
          { label: t('结束时间', 'Finished'), value: formatDateTime(item.finishedAt) },
          { label: t('运行耗时', 'Run time'), value: item.startedAt
            ? formatDuration(Math.max(0, (item.finishedAt ?? Date.now()) - item.startedAt))
            : t('尚未开始', 'Not started') },
          { label: t('引擎版本', 'Engine version'), value: item.engineVersion },
          { label: t('任务 ID', 'Job ID'), value: item.id, mono: true },
        ]} />
          {item.retryOf ? <Link to="/jobs/$jobId" params={{ jobId: item.retryOf }} className="text-cell text-accent-ink hover:underline">{t('查看原任务', 'View original job')}</Link> : null}
          {item.parentJobId ? <Link to="/recipes/batches/$batchId" params={{ batchId: item.parentJobId }} className="text-cell text-accent-ink hover:underline">{t('查看所属批量运行', 'View parent batch')}</Link> : null}
          <div className="flex flex-wrap gap-2 border-t border-hairline-soft pt-4">
            {item.kind === 'batch' ? <Link to="/recipes/batches/$batchId" params={{ batchId: item.id }} className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse">{t('查看各组结果', 'View group results')}</Link> : null}
            {primaryOutputReady && item.summary.outputId ? item.kind === 'export' ? <a href={api.downloadUrl(item.summary.outputId)} className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse">{t('下载导出文件', 'Download export')}</a> : item.kind === 'split' ? <Link to="/split" search={{ resourceId: item.summary.outputId }} className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse">{t('查看拆分文件', 'View split files')}</Link> : item.kind === 'compare' ? <Link to="/compare/result" search={{ resourceId: item.summary.outputId }} className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse">{t('查看核对结果', 'View comparison')}</Link> : <Link to="/datasets/$resourceId" params={{ resourceId: item.summary.outputId }} className="press inline-flex h-8.5 items-center rounded-control bg-accent px-3 text-cell font-medium text-ink-inverse">{t('打开结果', 'Open result')}</Link> : null}
            {item.kind === 'filter' && primaryOutputReady && item.summary.outputId ? <Link to="/convert" search={{ sourceId: item.summary.outputId }} className="press inline-flex h-8.5 items-center rounded-control bg-surface px-3 text-cell font-medium text-ink shadow-rail hover:bg-surface-hover">{t('导出此筛选结果', 'Export this filtered result')}</Link> : null}
            {item.kind !== 'batch' && ['queued', 'running'].includes(item.state) ? <Button size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>{t('取消任务', 'Cancel job')}</Button> : null}
            {item.kind !== 'batch' && ['failed', 'interrupted', 'cancelled'].includes(item.state) && item.error?.retryable !== false ? <Button size="sm" variant="secondary" disabled={retry.isPending} onClick={() => retry.mutate()}>{t('重试任务', 'Retry job')}</Button> : null}
            {recipeSourceKinds.has(item.kind) && ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(item.state) ? <Link to="/recipes" search={{ sourceJobId: item.id }} className="press inline-flex h-8.5 items-center rounded-control bg-surface px-3 text-cell font-medium text-ink shadow-rail hover:bg-surface-hover">{t('按此任务保存或修改规则', 'Save or edit these rules')}</Link> : null}
          </div>
        </Panel>
        {item.inputs?.length ? <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('固定输入资源', 'Fixed input resources')} />
          <p className="text-meta text-ink-3">{t('这里显示任务提交时固定的资源编号及其当前状态。原输入后来被删除，不会自动替换为同名文件。', 'These are the resource IDs fixed at submission and their current states. A removed input is never replaced by a file with the same name.')}</p>
          <div className="space-y-2">{item.inputs.map((input, index) => <div key={`${input.id}-${index}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-hairline-soft pt-2 text-cell">
            <span className="text-ink-3">{t(`输入 ${index + 1}`, `Input ${index + 1}`)}</span>
            <div className="min-w-0 flex-1">{input.status === 'ready' ? <Link to="/resources/$resourceId" params={{ resourceId: input.id }} className="text-accent-ink hover:underline">{input.name}</Link> : <span>{input.name ?? t('原资源已不存在', 'Original resource no longer exists')}</span>}
              <span className="figure block break-all text-meta text-ink-3">{input.id}</span></div>
            <span className="text-meta text-ink-3">{t(outputStatus[input.status]?.[0] ?? input.status, outputStatus[input.status]?.[1] ?? input.status)}{input.kind === 'dataset' && input.version !== null ? t(` · 第 ${input.version} 版`, ` · version ${input.version}`) : ''}</span>
          </div>)}</div>
        </Panel> : null}
        <RuleSnapshot job={item} />
        {item.outputs?.length ? <Panel className="space-y-3"><SectionTitle title={t('全部输出资源', 'All output resources')} />
          <div className="overflow-x-auto"><table className="w-full text-left text-cell"><thead><tr>
            <th className="py-2 pr-4">{t('名称与类型', 'Name and type')}</th><th className="py-2 pr-4">{t('状态', 'Status')}</th>
            <th className="py-2 pr-4">{t('记录数', 'Records')}</th><th className="py-2 pr-4">{t('文件字节数', 'File bytes')}</th>
            <th className="py-2 pr-4">SHA-256</th><th className="py-2">{t('操作', 'Actions')}</th>
          </tr></thead><tbody>{item.outputs.map((output) => <tr key={output.id} className="border-t border-hairline-soft align-top">
            <td className="py-3 pr-4"><span className="font-medium">{output.name}</span><span className="block text-meta text-ink-3">{t(outputKind[output.kind]?.[0] ?? output.kind, outputKind[output.kind]?.[1] ?? output.kind)} · {output.format}</span><span className="figure block text-meta text-ink-3">{output.id}</span></td>
            <td className="py-3 pr-4">{t(outputStatus[output.status]?.[0] ?? output.status, outputStatus[output.status]?.[1] ?? output.status)}</td>
            <td className="py-3 pr-4">{formatNumber(output.rowCount)}</td><td className="py-3 pr-4">{formatNumber(output.byteSize)}</td>
            <td className="figure max-w-48 break-all py-3 pr-4 text-meta">{output.contentHash ?? '—'}</td>
            <td className="py-3"><div className="flex flex-wrap gap-3"><Link to="/resources/$resourceId" params={{ resourceId: output.id }} className="text-accent-ink hover:underline">{t('详情', 'Details')}</Link>{output.status === 'ready' && ['raw', 'dataset', 'export'].includes(output.kind) ? <a href={api.downloadUrl(output.id)} className="text-accent-ink hover:underline">{t('下载', 'Download')}</a> : null}</div></td>
          </tr>)}</tbody></table></div>
        </Panel> : null}
        <Panel className="max-w-3xl space-y-3"><SectionTitle title={t('任务诊断摘要', 'Job diagnostic summary')} /><p className="text-meta text-ink-3">{t('只包含任务状态、时间、资源编号、行数和错误代码；不包含数据内容、SQL 参数或密钥。', 'Contains only job status, timestamps, resource IDs, row counts and error codes. It excludes data content, SQL parameters and secrets.')}</p>
          <div className="space-y-1 rounded-control bg-surface-sunk p-3 font-mono text-meta text-ink-2"><p>{formatDateTime(item.createdAt)} · {t('任务创建', 'Job created')}</p>{item.startedAt ? <p>{formatDateTime(item.startedAt)} · {t('开始运行', 'Started')}</p> : null}<p>{formatDateTime(item.updatedAt)} · {item.progress.stage ? localizedStage(item.progress.stage) : jobState(item.state)}</p>{item.finishedAt ? <p>{formatDateTime(item.finishedAt)} · {jobState(item.state)}{item.error ? ` · ${item.error.code}` : ''}</p> : null}</div>
          {item.progress.events?.length ? <div className="space-y-2"><strong className="text-cell text-ink">{t('阶段记录', 'Stage log')}</strong><ol className="max-h-64 space-y-1 overflow-auto rounded-control bg-surface-sunk p-3 text-meta text-ink-2">{item.progress.events.map((event, index) => <li key={`${event.at}-${index}`}>{formatDateTime(event.at)} · {jobState(event.state)} · {localizedStage(event.stage)}{event.errorCode ? ` · ${event.errorCode}` : ''}</li>)}</ol>{item.progress.eventsTruncated ? <p className="text-meta text-ink-3">{t('较早的阶段记录已按数量上限省略。', 'Older stage events were omitted after the log reached its limit.')}</p> : null}</div> : <p className="text-meta text-ink-3">{t('这项旧任务没有保存阶段记录；上方仍显示当前状态与时间。', 'This older job has no saved stage log. Its current state and times appear above.')}</p>}
          <Button size="sm" onClick={downloadDiagnostic}>{t('下载诊断摘要', 'Download diagnostic summary')}</Button></Panel>
        {cleanResult?.steps ? <Panel className="space-y-3"><SectionTitle title={t('各步骤结果', 'Results by step')} /><div className="overflow-x-auto"><table className="w-full text-left text-cell"><thead><tr><th>{t('步骤', 'Step')}</th><th>{t('输入行数', 'Input rows')}</th><th>{t('输出行数', 'Output rows')}</th><th>{t('修改或移除', 'Changed or removed')}</th><th>{t('解析错误', 'Parse errors')}</th><th>{t('空行', 'Empty rows')}</th><th>{t('重复组 / 成员', 'Duplicate groups / members')}</th></tr></thead><tbody>{cleanResult.steps.map((step) => <tr key={step.step}><td>{step.step}. {step.type}</td><td>{formatNumber(step.rowsIn)}</td><td>{formatNumber(step.rowsOut)}</td><td>{formatNumber(step.changed)}</td><td>{formatNumber(step.errors)}</td><td>{step.emptyRows === undefined ? '—' : formatNumber(step.emptyRows)}</td><td>{step.duplicateGroups === undefined ? '—' : `${formatNumber(step.duplicateGroups)} / ${formatNumber(step.duplicateMembers)}`}</td></tr>)}</tbody></table></div>{cleanResult.reports?.length ? <div className="space-y-1"><p className="text-cell font-medium">{t('完整报告', 'Full reports')}</p>{cleanResult.reports.map((report) => <p key={report.file} className="text-meta"><a className="text-accent-ink hover:underline" href={api.cleanReportUrl(item.summary.outputId!, report.step, report.kind)}>{t(`下载步骤 ${report.step} 的${report.kind === 'duplicates' ? '重复组成员' : report.kind === 'empty-rows' ? '空行记录' : '解析错误与隔离记录'}清单`, `Download step ${report.step} ${report.kind === 'duplicates' ? 'duplicate members' : report.kind === 'empty-rows' ? 'empty rows' : 'parse errors and isolated rows'} report`)}</a>{t(`（${formatNumber(report.rows)} 行）`, ` (${formatNumber(report.rows)} rows)`)}</p>)}</div> : null}{cleanResult.steps.some((step) => step.sampleErrors.length) ? <details><summary className="cursor-pointer text-cell text-accent-ink">{t('查看解析错误样本', 'View parse error samples')}</summary><div className="mt-2 space-y-1">{cleanResult.steps.flatMap((step) => step.sampleErrors.map((error) => <p key={`${step.step}-${error.row}`} className="text-meta">{t(`步骤 ${step.step} · 输入第 ${error.row} 行：`, `Step ${step.step} · input row ${error.row}: `)}{error.value}{error.reason ? ` · ${localizedCleanReason(error.reason)}` : ''}</p>))}</div></details> : null}</Panel> : null}
        {relationSummary ? <Panel className="space-y-3"><SectionTitle title={t('关联运行统计', 'Join run statistics')} />
          <div className="grid gap-3 text-cell sm:grid-cols-2 lg:grid-cols-4">{[
            [t('左侧输入', 'Left input'), relationSummary.leftRows],
            [t('右侧输入', 'Right input'), relationSummary.rightRows],
            [t('匹配组合', 'Matched pairs'), relationSummary.matchedPairs],
            [t('结果记录', 'Output rows'), relationSummary.outputRows],
            [t('左侧已匹配', 'Matched left rows'), relationSummary.matchedLeftRows],
            [t('右侧已匹配', 'Matched right rows'), relationSummary.matchedRightRows],
            [t('左侧未匹配', 'Unmatched left rows'), relationSummary.unmatchedLeftRows],
            [t('右侧未匹配', 'Unmatched right rows'), relationSummary.unmatchedRightRows],
          ].map(([label, value]) => <div key={String(label)} className="rounded-control bg-surface-sunk p-3"><span className="block text-meta text-ink-3">{label}</span><strong className="figure text-ink">{formatNumber(value as number)}</strong></div>)}</div>
          <p className="text-meta text-ink-3">{t('匹配组合可能多于已匹配记录数：重复键会展开为多对多组合。不同关联方式保留的结果行数也不同。', 'Matched pairs can exceed matched input rows when duplicate keys expand into multiple combinations. Output rows depend on the join type.')}</p>
        </Panel> : null}
        {relationReports?.length ? <Panel className="space-y-2"><SectionTitle title={t('关联未匹配清单', 'Unmatched join records')} /><p className="text-meta text-ink-3">{t('清单包含来源行号、未匹配原因、匹配键及输入记录；不改变关联结果。', 'Reports include source row, reason, key and input record. They do not change the join result.')}</p>{relationReports.map((report) => <p key={report.side} className="text-cell"><a className="text-accent-ink hover:underline" href={api.relationReportUrl(item.summary.outputId!, report.side)}>{t(`下载${report.side === 'left' ? '左表' : '右表'}未匹配记录`, `Download unmatched ${report.side} records`)}</a>{t(`（${formatNumber(report.rows)} 行）`, ` (${formatNumber(report.rows)} rows)`)}</p>)}</Panel> : null}
        {jsonImportReport ? <Panel className="space-y-2"><SectionTitle title={t('JSON 异常记录', 'JSON rejected records')} /><p className="text-meta text-ink-3">{t(`共有 ${formatNumber(jsonImportReport.rows)} 条记录按导入配置隔离；清单列出源记录号与原因。`, `${formatNumber(jsonImportReport.rows)} records were isolated by the import settings. The report lists source record numbers and reasons.`)}</p><a className="text-cell text-accent-ink hover:underline" href={api.jsonImportReportUrl(item.summary.outputId!)}>{t('下载异常记录清单', 'Download rejected records')}</a></Panel> : null}
        {jsonConversionReport ? <Panel className="space-y-2"><SectionTitle title={t('JSON 值转换清单', 'JSON value conversions')} /><p className="text-meta text-ink-3">{t(`共有 ${formatNumber(jsonConversionReport.rows)} 处值按明确选择的策略转换或忽略。原始 JSON 文件未修改；清单列出源记录号、字段与转换原因。`, `${formatNumber(jsonConversionReport.rows)} values were converted or ignored by the selected policy. The original JSON file was not changed. The report lists source record numbers, fields and reasons.`)}</p><a className="text-cell text-accent-ink hover:underline" href={api.jsonConversionReportUrl(item.summary.outputId!)}>{t('下载转换清单', 'Download conversion report')}</a></Panel> : null}
        {csvImportReport ? <Panel className="space-y-2"><SectionTitle title={t('CSV / 工作表异常记录', 'CSV / sheet rejected records')} /><p className="text-meta text-ink-3">{t(`共有 ${formatNumber(csvImportReport.rows)} 条记录按导入配置隔离；清单列出源记录号、原因和已解析字段。`, `${formatNumber(csvImportReport.rows)} records were isolated by the import settings. The report lists source record numbers, reasons and parsed fields.`)}</p><a className="text-cell text-accent-ink hover:underline" href={api.csvImportReportUrl(item.summary.outputId!)}>{t('下载异常记录清单', 'Download rejected records')}</a></Panel> : null}
      </> : null}
    </PageBody></>
}
