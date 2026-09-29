import { useEffect, useState } from 'react'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { DraftInputWarning } from '@/ui/DraftInputWarning'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Resource, type SqlParameters } from '@/api/client'
import { Button } from '@/ui/Button'
import { Banner, Spinner } from '@/ui/Feedback'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { useDatasetSearch } from '@/ui/useDatasetSearch'

function BoundTable({ item, alias }: { item: Resource; alias: string }) {
  const t = useT()
  const schema = useQuery({ queryKey: ['schema', item.id], queryFn: () => api.schema(item.id) })
  return <div className="rounded-control bg-surface-sunk p-3 text-cell"><p className="font-medium text-ink">{alias} · {item.name}</p><p className="mt-1 text-meta text-ink-3">{schema.isLoading ? t('读取字段中…', 'Loading fields…') : schema.error ? schema.error.message : schema.data?.columns.map((column) => column.name).join(', ')}</p></div>
}

export function SqlPage() {
  const t = useT()
  const navigate = useNavigate()
  const { sourceId: requestedSourceId } = useSearch({ from: '/sql' })
  const client = useQueryClient()
  const resources = useQuery({ queryKey: ['sql', 'resources'], queryFn: () => api.resourcePage(0, 200) })
  const datasetSearch = useDatasetSearch('sql')
  const [sourceIds, setSourceIds] = useSessionDraft<string[]>('SqlPage.sourceIds', [])
  const lookupIds = [...new Set([requestedSourceId, ...sourceIds].filter((id): id is string => Boolean(id)))].slice(0, 5)
  const lookedUp = useQueries({ queries: lookupIds.map((id) => ({ queryKey: ['resource', id], queryFn: () => api.resource(id) })) })
  const datasets = [...new Map([...datasetSearch.items, ...(resources.data?.items ?? []), ...lookedUp.flatMap((item) => item.data ? [item.data] : [])]
    .filter((item) => item.kind === 'dataset' && item.status === 'ready').map((item) => [item.id, item] as const)).values()]
  useEffect(() => { if (requestedSourceId) setSourceIds([requestedSourceId]) }, [requestedSourceId, setSourceIds])
  const [sql, setSql] = useSessionDraft('SqlPage.sql', 'SELECT * FROM t1 LIMIT 200')
  const [parameterInputs, setParameterInputs] = useSessionDraft<Record<string, { type: SqlParameters['definitions'][number]['type']; value: string }>>('SqlPage.parameterInputs', {})
  const parameterNames = [...new Set([...sql.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/gu)].map((match) => match[1]!))]
  const parameters: SqlParameters | undefined = parameterNames.length ? { definitions: parameterNames.map((name) => ({ name, type: parameterInputs[name]?.type ?? 'text' })),
    values: Object.fromEntries(parameterNames.map((name) => [name, parameterInputs[name]?.value ?? ''])) } : undefined
  const [key, setKey] = useState(() => `sql_${crypto.randomUUID()}`)
  const preview = useMutation({ mutationFn: () => api.previewSql(sourceIds, sql, parameters) })
  const submit = useMutation({ mutationFn: () => api.sql(sourceIds, sql, key, parameters), onSuccess: (result) => {
    void client.invalidateQueries({ queryKey: ['jobs'] })
    void client.invalidateQueries({ queryKey: ['resources'] })
    void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
  } })
  const toggle = (id: string) => { setSourceIds((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]); setKey(`sql_${crypto.randomUUID()}`); preview.reset() }
  return <><PageTopBar title={t('SQL 查询', 'SQL query')} /><PageBody className="space-y-4">
    {datasetSearch.controls}
    <DraftInputWarning ids={sourceIds} availableIds={datasets.map((item) => item.id)} loading={resources.isLoading || lookedUp.some((item) => item.isLoading)} />
    <Banner tone="info">{t('绑定 1 至 4 份固定数据集，按选择顺序命名为 t1、t2、t3、t4。服务端只接受一条 SELECT 查询，并检查表和函数。结果保存为新的可浏览数据集。', 'Bind 1 to 4 fixed datasets, named t1 through t4 in selection order. The server accepts one SELECT query and checks its tables and functions. The result becomes a new browsable dataset.')}</Banner>
    <Panel className="max-w-5xl space-y-4"><SectionTitle title={t('输入表', 'Input tables')} />
      {resources.isLoading ? <Spinner /> : null}
      {resources.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resources')}>{resources.error.message}</Banner> : null}
      {!resources.isLoading && datasets.length === 0 ? <p className="text-cell text-ink-3">{t('请先导入至少一个数据集。', 'Import at least one dataset first.')}</p> : null}
      <div className="max-h-64 space-y-1 overflow-y-auto rounded-control border border-hairline p-2">{datasets.map((item) => <label key={item.id} className="flex gap-2 rounded-control px-2 py-1 text-cell text-ink-2 hover:bg-surface-hover"><input type="checkbox" checked={sourceIds.includes(item.id)} disabled={!sourceIds.includes(item.id) && sourceIds.length >= 4} onChange={() => toggle(item.id)} /><span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>{sourceIds.includes(item.id) ? <span className="figure text-accent-ink">t{sourceIds.indexOf(item.id) + 1}</span> : null}</label>)}</div>
      <div className="grid gap-2 sm:grid-cols-2">{sourceIds.map((id, index) => { const item = datasets.find((resource) => resource.id === id); return item ? <BoundTable key={id} item={item} alias={`t${index + 1}`} /> : null })}</div>
    </Panel>
    <Panel className="max-w-5xl space-y-4"><SectionTitle title={t('查询语句', 'Query statement')} /><p className="text-meta text-ink-3">{t('支持 SELECT、CTE、关联、筛选与聚合的受限语法；函数限 COUNT、SUM、MIN、MAX、AVG、ROUND、COALESCE、ABS、LOWER、UPPER、TRIM。无法解析或引用其他表的语句会被拒绝。', 'A limited syntax supports SELECT, CTEs, joins, filters and aggregation. Allowed functions are COUNT, SUM, MIN, MAX, AVG, ROUND, COALESCE, ABS, LOWER, UPPER and TRIM. Unparseable statements or references to other tables are rejected.')}</p>
      <label className="block space-y-1 text-meta text-ink-3">SQL<textarea value={sql} maxLength={8192} rows={12} spellCheck={false} onChange={(event) => { setSql(event.target.value); setKey(`sql_${crypto.randomUUID()}`); preview.reset() }} className="figure block w-full resize-y rounded-control bg-surface px-3 py-2 font-mono text-cell text-ink shadow-rail" /></label>
      <p className="text-meta text-ink-3">{t('可在 SQL 中写 ', 'Use ')}<code>{t('{{参数名}}', '{{parameter_name}}')}</code>{t('。参数只会作为指定类型的值进入查询，不能用来替换字段名、表名或 SQL 片段。', ' in SQL. Parameters enter the query only as typed values; they cannot replace field names, table names or SQL fragments.')}</p>
      {parameterNames.length ? <div className="space-y-2 rounded-control bg-surface-sunk p-3"><strong className="text-cell">{t('查询参数', 'Query parameters')}</strong>{parameterNames.map((name) => <div key={name} className="grid gap-2 sm:grid-cols-3"><span className="figure self-center text-cell">{name}</span><select aria-label={t(`${name} 类型`, `${name} type`)} value={parameterInputs[name]?.type ?? 'text'} onChange={(event) => { setParameterInputs((current) => ({ ...current, [name]: { type: event.target.value as SqlParameters['definitions'][number]['type'], value: current[name]?.value ?? '' } })); setKey(`sql_${crypto.randomUUID()}`); preview.reset() }} className="h-9 rounded-control bg-surface px-2 text-cell"><option value="text">{t('文本', 'Text')}</option><option value="integer">{t('整数', 'Integer')}</option><option value="decimal">{t('小数', 'Decimal')}</option><option value="date">{t('日期 YYYY-MM-DD', 'Date YYYY-MM-DD')}</option></select><input aria-label={t(`${name} 的值`, `${name} value`)} value={parameterInputs[name]?.value ?? ''} maxLength={1024} onChange={(event) => { setParameterInputs((current) => ({ ...current, [name]: { type: current[name]?.type ?? 'text', value: event.target.value } })); setKey(`sql_${crypto.randomUUID()}`); preview.reset() }} className="h-9 rounded-control bg-surface px-2 text-cell" /></div>)}</div> : null}
      <p className="text-meta text-ink-3">{t('所有输入字段先按文本读取，以保留前导零与长整数。查询中需要数值运算时请显式转换，并核对输出精度。执行和取消由后台任务负责。', 'All input fields are initially read as text to preserve leading zeros and long integers. Convert explicitly for numeric calculations and check the output precision. Background jobs handle execution and cancellation.')}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={sourceIds.length === 0 || !sql.trim() || preview.isPending} onClick={() => preview.mutate()}>{t('预览输入样本查询', 'Preview query on input samples')}</Button>
        <Button variant="primary" disabled={sourceIds.length === 0 || !sql.trim() || submit.isPending} onClick={() => submit.mutate()}>{t('运行完整查询', 'Run full query')}</Button></div>
      {preview.isPending ? <Spinner label={t('正在对有限样本运行 SQL', 'Running SQL on limited samples')} /> : null}
      {preview.error ? <Banner tone="danger" title={t('SQL 样本预览失败', 'SQL sample preview failed')}>{preview.error.message}</Banner> : null}
      {preview.data ? <div className="space-y-2"><p className="text-cell text-ink-2">{t(`样本范围：${preview.data.scope}；各输入实际取 ${preview.data.sampledRows.join('、')} 行。结果只显示前 ${preview.data.resultLimit} 行，不能代表完整数据的计数或排序。`, `Sample scope: ${preview.data.scope}. Each input contributed ${preview.data.sampledRows.join(', ')} rows. Only the first ${preview.data.resultLimit} result rows are shown; this does not represent full-data counts or ordering.`)}</p>
        <div className="max-h-80 overflow-auto rounded-control bg-surface-sunk"><table className="min-w-full text-left text-meta"><thead><tr>{preview.data.headers.map((name, index) => <th key={index} className="whitespace-nowrap border-b border-hairline-soft px-2 py-1">{name}</th>)}</tr></thead><tbody>{preview.data.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-48 truncate border-b border-hairline-soft px-2 py-1" title={cell}>{cell}</td>)}</tr>)}</tbody></table></div>
        {preview.data.columnsTruncated ? <p className="text-meta text-ink-3">{t(`还有 ${preview.data.columnCount - preview.data.headers.length} 列未在预览中显示。`, `${preview.data.columnCount - preview.data.headers.length} columns are hidden in the preview.`)}</p> : null}
      </div> : null}
      {submit.error ? <Banner tone="danger" title={t('SQL 未提交', 'SQL was not submitted')}>{submit.error.message}</Banner> : null}
    </Panel>
  </PageBody></>
}
