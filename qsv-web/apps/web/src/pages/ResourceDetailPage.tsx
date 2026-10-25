import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Resource } from '@/api/client'
import { formatBytes, formatDateTime, formatNumber, FORMAT_LABEL, kindLabel } from '@/lib/format'
import { Button } from '@/ui/Button'
import { KeyValueList } from '@/ui/Data'
import { Banner, Spinner } from '@/ui/Feedback'
import { Field, Input, Textarea } from '@/ui/Field'
import { PageBody, PageTopBar, SectionTitle } from '@/ui/Page'
import { Panel } from '@/ui/Panel'
import { useT } from '@/ui/locale'
import { localizedStage } from '@/lib/stage'

const statusLabel: Record<string, string> = {
  staging: '接收中', building: '处理中', ready: '可用', failed: '失败', trashed: '已删除',
}

function ResourceEditor({ item, onClose }: { item: Resource; onClose: () => void }) {
  const t = useT()
  const client = useQueryClient()
  const [name, setName] = useState(item.name)
  const [description, setDescription] = useState(typeof item.metadata.description === 'string' ? item.metadata.description : '')
  const mutation = useMutation({ mutationFn: () => api.updateResource(item.id, name, description, item.updatedAt), onSuccess: (updated) => {
    client.setQueryData(['resource', item.id], updated)
    void client.invalidateQueries({ queryKey: ['resources'] })
    void client.invalidateQueries({ queryKey: ['overview'] })
    onClose()
  } })
  return <form className="space-y-4 border-t border-hairline-soft pt-4" onSubmit={(event) => { event.preventDefault(); mutation.mutate() }}>
    <Field label={t('显示名称', 'Display name')} htmlFor="resource-display-name" required><Input id="resource-display-name" value={name} maxLength={255} required onChange={(event) => setName(event.target.value)} /></Field>
    <Field label={t('说明', 'Description')} htmlFor="resource-description" hint={t('最多 1000 个字符；原文件和资源 ID 不会改变。', 'Up to 1,000 characters. The original file and resource ID will not change.')}><Textarea id="resource-description" value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} /></Field>
    {mutation.error ? <Banner tone="danger" title={t('未保存修改', 'Changes not saved')}>{mutation.error.message}</Banner> : null}
    <div className="flex gap-2"><Button type="submit" variant="primary" disabled={mutation.isPending || !name.trim()}>{t('保存', 'Save')}</Button><Button onClick={onClose} disabled={mutation.isPending}>{t('取消', 'Cancel')}</Button></div>
  </form>
}

export function ResourceDetailPage() {
  const t = useT()
  const resourceStatus = (status: string) => t(statusLabel[status] ?? status, ({ staging: 'Receiving', building: 'Processing', ready: 'Ready', failed: 'Failed', trashed: 'In trash' } as Record<string, string>)[status] ?? status)
  const { resourceId } = useParams({ from: '/resources/$resourceId' })
  const navigate = useNavigate()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [showTrash, setShowTrash] = useState(false)
  const [showImportPreview, setShowImportPreview] = useState(false)
  const query = useQuery({ queryKey: ['resource', resourceId], queryFn: () => api.resource(resourceId), refetchInterval: (state) => ['staging', 'building'].includes(state.state.data?.status ?? '') ? 2000 : false })
  const sources = useQueries({ queries: (query.data?.sourceIds ?? []).map((id) => ({
    queryKey: ['resource', id], queryFn: () => api.resource(id), retry: false,
  })) })
  const versions = useQuery({ queryKey: ['resource', resourceId, 'versions'], queryFn: () => api.resourceVersions(resourceId), enabled: query.data?.kind === 'dataset' })
  const producerJob = useQuery({ queryKey: ['job', query.data?.producerJobId], queryFn: () => api.job(query.data!.producerJobId!), enabled: Boolean(query.data?.producerJobId) })
  const importPreview = useQuery({
    queryKey: ['import-preview', resourceId], queryFn: () => api.previewImportResult(resourceId), enabled: showImportPreview,
    refetchInterval: (state) => state.state.data?.available === false && query.data?.status === 'building' ? 2000 : false,
  })
  const dependencies = useQuery({ queryKey: ['resource-dependencies', resourceId], queryFn: () => api.resourceDependencies(resourceId), enabled: showTrash })
  const trash = useMutation({ mutationFn: () => api.trashResource(resourceId, query.data!.updatedAt), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['resources'] })
    void client.invalidateQueries({ queryKey: ['trash'] })
    void client.invalidateQueries({ queryKey: ['overview'] })
    void client.invalidateQueries({ queryKey: ['storage'] })
    void navigate({ to: '/resources' })
  } })
  const item = query.data
  return <><PageTopBar title={item?.name ?? t('资源详情', 'Resource details')} facts={item ? <span className="text-meta text-ink-2">{kindLabel(item.kind)} · {resourceStatus(item.status)}</span> : undefined} actions={<Link to="/resources" className="press text-cell text-accent-ink hover:underline">{t('返回资源列表', 'Back to resources')}</Link>} />
    <PageBody className="space-y-4">
      {query.isLoading ? <Spinner /> : null}
      {query.error ? <Banner tone="danger" title={t('资源读取失败', 'Could not load resource')}>{query.error instanceof Error ? query.error.message : t('请稍后重试', 'Please try again later')}</Banner> : null}
      {item ? <Panel className="max-w-3xl space-y-4"><SectionTitle title={t('资源记录', 'Resource record')} actions={item.kind !== 'view' && (item.status === 'ready' || item.status === 'failed') ? <Button size="sm" onClick={() => setEditing(!editing)}>{editing ? t('收起编辑', 'Close editor') : t('编辑名称与说明', 'Edit name and description')}</Button> : undefined} /><KeyValueList items={[
        { label: t('类型', 'Type'), value: kindLabel(item.kind) },
        { label: t('状态', 'Status'), value: resourceStatus(item.status) },
        { label: t('格式', 'Format'), value: FORMAT_LABEL[item.format] ?? item.format.toUpperCase() },
        ...(item.kind === 'dataset' ? [{ label: t('版本', 'Version'), value: t(`第 ${item.version} 版`, `Version ${item.version}`) }] : []),
        { label: t('说明', 'Description'), value: typeof item.metadata.description === 'string' && item.metadata.description ? item.metadata.description : t('未填写', 'Not provided') },
        ...(item.metadata.parquetConversion ? [{ label: t('Parquet 导入转换', 'Parquet import conversion'), value: t('单层字段写为文本；空值转为空文本；嵌套字段已拒绝', 'Top-level fields were written as text; nulls became empty text; nested fields were rejected') }] : []),
        ...(typeof item.metadata.cellStateLineageUnavailable === 'string'
          ? [{ label: t('空值来源', 'Missing value origin'), value: t(item.metadata.cellStateLineageUnavailable,
            'Combining rows by key merges several records into one cell, so original missing-value origins cannot be traced per cell') }] : []),
        { label: t('原文件名', 'Original filename'), value: typeof item.metadata.originalName === 'string' ? item.metadata.originalName : t('未知', 'Unknown') },
        { label: t('行数', 'Rows'), value: formatNumber(item.rowCount) },
        { label: t('字段数', 'Fields'), value: formatNumber(item.columnCount) },
        { label: t('文件大小', 'File size'), value: formatBytes(item.byteSize) },
        { label: t('创建时间', 'Created'), value: formatDateTime(item.createdAt) },
        { label: t('更新时间', 'Updated'), value: formatDateTime(item.updatedAt) },
        { label: t('内容摘要', 'Content hash'), value: item.contentHash ?? t('尚未生成', 'Not generated'), mono: true },
        { label: t('资源 ID', 'Resource ID'), value: item.id, mono: true },
      ]} />
        {editing ? <ResourceEditor item={item} onClose={() => setEditing(false)} /> : null}
        {item.kind !== 'view' && (item.status === 'ready' || item.status === 'failed') ? <div className="space-y-3 border-t border-hairline-soft pt-4">
          <Button size="sm" variant="quiet" onClick={() => setShowTrash(!showTrash)}>{showTrash ? t('收起删除说明', 'Hide removal details') : t('移至回收站', 'Move to trash')}</Button>
          {showTrash ? <div className="space-y-2 rounded-control bg-surface-sunk p-3 text-cell text-ink-2">
            <p>{t('原文件与数据集会保留在服务端回收站，可以恢复；移入回收站后暂时无法下载或用作新任务输入。', 'Original files and datasets remain recoverable in the server trash. While there, they cannot be downloaded or used as new task inputs.')}</p>
            <p>{t('模板按输入槽位和字段名保存，不固定占用这份资源；再次运行时仍需选择可用输入并检查字段。', 'Templates store input slots and field names, not a fixed reference to this resource. Select an available input and check its fields when running again.')}</p>
            {dependencies.isLoading ? <Spinner /> : null}
            {dependencies.error ? <Banner tone="danger" title={t('依赖检查失败', 'Dependency check failed')}>{dependencies.error.message}</Banner> : null}
            {dependencies.data?.activeJobs.length ? <p>{t('正在使用的任务：', 'Jobs using this resource: ')}{dependencies.data.activeJobs.map((job) => job.name).join(', ')}{t('。这些任务完成前不能删除。', '. This resource cannot be removed until they finish.')}</p> : null}
            {dependencies.data?.derivedResources.length ? <p>{t('仍引用此资源的结果（最多显示 50 项）：', 'Results still referring to this resource (up to 50): ')}{dependencies.data.derivedResources.map((related) => related.name).join(', ')}{t('。删除后，这些结果的来源链接可能暂时不可用。', '. Their source links may be unavailable while this resource is in trash.')}</p> : null}
            {trash.error ? <Banner tone="danger" title={t('删除失败', 'Could not move to trash')}>{trash.error.message}</Banner> : null}
            <Button size="sm" disabled={!dependencies.data || dependencies.data.activeJobs.length > 0 || trash.isPending} onClick={() => trash.mutate()}>{t('确认移至回收站', 'Confirm move to trash')}</Button>
          </div> : null}
        </div> : null}
        <div className="flex flex-wrap gap-4 border-t border-hairline-soft pt-4 text-cell">
          {item.status === 'ready' && item.kind === 'dataset' ? <Link to="/datasets/$resourceId" params={{ resourceId }} className="text-accent-ink hover:underline">{t('浏览数据', 'Browse data')}</Link> : null}
          {item.status === 'ready' && (item.kind === 'raw' || item.kind === 'dataset' || item.kind === 'export') ? <button type="button" onClick={() => { void api.downloadResource(resourceId, item.name) }} className="cursor-pointer text-accent-ink hover:underline">{t('下载完整文件', 'Download complete file')}</button> : null}
          {item.producerJobId ? <Link to="/jobs/$jobId" params={{ jobId: item.producerJobId }} className="text-accent-ink hover:underline">{t('查看生成任务', 'View producing job')}</Link> : null}
        </div>
        {item.kind === 'dataset' ? <div className="space-y-2 border-t border-hairline-soft pt-4 text-cell"><p className="font-medium text-ink">{t('版本与生成记录', 'Versions and creation history')}</p>
          {versions.error ? <Banner tone="danger">{t('版本记录读取失败：', 'Could not load versions: ')}{versions.error.message}</Banner> : null}
          {versions.data ? <div className="space-y-2">{versions.data.map((version) => <div key={version.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link to="/resources/$resourceId" params={{ resourceId: version.id }} className="text-accent-ink hover:underline">{t(`第 ${version.version} 版`, `Version ${version.version}`)}{version.id === item.id ? t('（当前）', ' (current)') : ''} · {resourceStatus(version.status)}</Link>
            {item.status === 'ready' && version.status === 'ready' && version.id !== item.id ? <Link to="/compare" search={{ leftId: version.id, rightId: item.id }} className="text-meta text-accent-ink hover:underline">{t('与当前版本核对', 'Compare with current version')}</Link> : null}
          </div>)}</div> : null}
          {producerJob.data ? <p className="text-meta text-ink-2">{t(`本次处理：输入 ${formatNumber(producerJob.data.summary.rowsIn)} 行，输出 ${formatNumber(producerJob.data.summary.rowsOut)} 行。`, `This operation: ${formatNumber(producerJob.data.summary.rowsIn)} input rows and ${formatNumber(producerJob.data.summary.rowsOut)} output rows. `)}<Link to="/jobs/$jobId" params={{ jobId: producerJob.data.id }} className="text-accent-ink hover:underline">{t('查看提交时的规则', 'View submitted rules')}</Link></p> : null}
        </div> : null}
        {item.status === 'ready' && item.kind === 'dataset' ? <details className="border-t border-hairline-soft pt-4 text-cell"><summary className="cursor-pointer text-accent-ink">{t('用此数据集继续处理', 'Continue with this dataset')}</summary><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
          <Link to="/clean" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('清洗', 'Clean')}</Link>
          <Link to="/convert" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('导出', 'Export')}</Link>
          <Link to="/join" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('合并与关联', 'Combine and join')}</Link>
          <Link to="/split" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('拆分与重组', 'Split and reshape')}</Link>
          <Link to="/compare" search={{ leftId: resourceId }} className="text-accent-ink hover:underline">{t('双表核对', 'Compare two tables')}</Link>
          <Link to="/quality" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('质量检查', 'Quality checks')}</Link>
          <Link to="/analyze" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('统计', 'Analyze')}</Link>
          <Link to="/sql" search={{ sourceId: resourceId }} className="text-accent-ink hover:underline">{t('SQL 查询', 'SQL query')}</Link>
        </div><p className="mt-2 text-meta text-ink-3">{t('这些入口会固定当前数据集版本；各工具仍会检查字段和操作限制。', 'These links keep the current dataset version. Each tool still checks fields and operation limits.')}</p></details> : null}
        {item.kind === 'dataset' && ['building', 'ready'].includes(item.status) && 'parseConfig' in item.metadata ? <div className="space-y-2 border-t border-hairline-soft pt-4">
          <div className="flex items-center gap-2"><Button size="sm" onClick={() => showImportPreview ? void importPreview.refetch() : setShowImportPreview(true)} disabled={importPreview.isFetching}>{showImportPreview ? t('刷新首批数据', 'Refresh first rows') : t('查看已解析的首批数据', 'View first parsed rows')}</Button>{importPreview.isFetching ? <Spinner /> : null}</div>
          {importPreview.error ? <Banner tone="danger" title={t('样本读取失败', 'Could not load sample')}>{importPreview.error.message}</Banner> : null}
          {importPreview.data ? <p className="text-meta text-ink-3">{localizedStage(importPreview.data.stage)}{t('。', '. ')}{importPreview.data.available ? t('这里只显示已解析文件的开头样本；完整行数以任务完成后的数据集为准。', 'Only the beginning of the parsed file is shown here. The completed dataset determines the full row count.') : t('文件写入完成后会自动刷新。', 'This view will refresh when the file is ready.')}</p> : null}
          {importPreview.data?.available ? <div className="max-h-72 overflow-auto rounded-control bg-surface-sunk"><table className="min-w-full text-left text-meta"><thead><tr>{importPreview.data.preview.headers.map((name, index) => <th key={index} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={name}>{name}</th>)}</tr></thead><tbody>{importPreview.data.preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={cell}>{cell}</td>)}</tr>)}</tbody></table>{importPreview.data.preview.columnsTruncated ? <p className="p-2 text-meta text-ink-3">{t(`另有 ${importPreview.data.preview.columnCount - importPreview.data.preview.headers.length} 列未显示。`, `${importPreview.data.preview.columnCount - importPreview.data.preview.headers.length} more columns are hidden.`)}</p> : null}</div> : null}
        </div> : null}
        {item.sourceIds.length ? <div className="space-y-2 border-t border-hairline-soft pt-4"><p className="text-meta text-ink-3">{t('来源资源', 'Source resources')}</p>{item.sourceIds.map((id, index) => {
          const source = sources[index]
          return source?.data?.status === 'ready'
            ? <Link key={id} to="/resources/$resourceId" params={{ resourceId: id }} className="figure block break-all text-cell text-accent-ink hover:underline">{source.data.name} · {id}</Link>
            : <p key={id} className="figure break-all text-cell text-ink-3">{id} · {source?.isPending ? t('正在核对来源', 'Checking source') : source?.data?.status === 'trashed' ? t('来源在回收站', 'Source is in trash') : t('来源不可读取', 'Source unavailable')}</p>
        })}</div> : null}
      </Panel> : null}
    </PageBody></>
}
