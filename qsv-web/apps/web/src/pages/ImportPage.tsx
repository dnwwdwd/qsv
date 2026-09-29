import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload, defaultOptions, type PreviousUpload } from 'tus-js-client'
import { api, ApiError, type ColumnType, type CsvImportOptions, type CsvPreview, type JsonImportOptions, type Job, type Resource, type WorkbookSheet } from '@/api/client'
import { fileDigest } from '@/api/fileDigest'
import { Button } from '@/ui/Button'
import { Banner } from '@/ui/Feedback'
import { Panel } from '@/ui/Panel'
import { Fact, PageBody, PageTopBar } from '@/ui/Page'
import { useSessionDraft } from '@/ui/useSessionDraft'
import { useLocale, useT } from '@/ui/locale'
import { localizedErrorMessage } from '@/lib/errors'
import { localizedStage } from '@/lib/stage'

const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024
const MAX_WORKBOOK_BYTES = 256 * 1024 * 1024
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : value < 1073741824 ? `${(value / 1048576).toFixed(1)} MiB` : `${(value / 1073741824).toFixed(1)} GiB`

type ItemState = 'ready' | 'checking' | 'duplicate' | 'uploading' | 'paused' | 'committing' | 'previewing' | 'uploaded' | 'importing' | 'submitted' | 'done' | 'error' | 'cancelled'
interface QueueItem {
  id: string
  file: File
  key: string
  csv: CsvImportOptions
  json: JsonImportOptions
  state: ItemState
  progress: number
  digest?: { sha256: string; fingerprint: string }
  matches?: Resource[]
  ignoreDuplicate?: boolean
  error?: string
  raw?: Resource
  preview?: CsvPreview
  columnTypes?: Record<string, ColumnType>
  sheetColumnTypes?: Record<string, Record<string, ColumnType>>
  sheets?: WorkbookSheet[]
  sheetName?: string
  sheetNames?: string[]
  previewTarget?: string
  dataset?: Resource
  job?: Job
  importPreview?: CsvPreview
  importPreviewStage?: string
  importPreviewError?: string
}

const stateText: Record<ItemState, string> = {
  ready: '等待上传', checking: '校验文件', duplicate: '发现已有相同文件', uploading: '正在上传', paused: '已暂停',
  committing: '正在登记原文件', previewing: '正在读取有限样本', uploaded: '等待确认导入', importing: '正在提交导入', submitted: '导入任务运行中',
  done: '导入完成', error: '未完成', cancelled: '已取消',
}
const stateTextEn: Record<ItemState, string> = {
  ready: 'Waiting to upload', checking: 'Checking file', duplicate: 'Matching file found', uploading: 'Uploading', paused: 'Paused',
  committing: 'Registering original file', previewing: 'Reading limited sample', uploaded: 'Awaiting import confirmation', importing: 'Submitting import', submitted: 'Import job running',
  done: 'Import complete', error: 'Not completed', cancelled: 'Cancelled',
}

const previewReasonsEn: Record<string, string> = {
  '字段数或单元格大小超出限制': 'Column count or cell size exceeds the limit',
  '记录无效': 'Invalid record',
  '新字段已按配置忽略': 'New field ignored as configured',
  '缺字段已补为空文本': 'Missing field replaced with empty text',
  '显式 null 已转为空文本': 'Explicit null converted to empty text',
  '展开后的字段超过 4096 列': 'Flattened record exceeds 4,096 columns',
  '指定的数组展开路径不存在或不是数组': 'The selected array expansion path is missing or is not an array',
  '单条记录的数组展开超过 10000 行': 'Array expansion exceeds 10,000 rows for one record',
  'JSON 嵌套层数超过 32 层': 'JSON nesting exceeds 32 levels',
  'JSON 记录没有可导入的字段': 'JSON record has no importable fields',
}

function localizedPreviewReason(reason: string, english: boolean) {
  if (!english) return reason
  if (previewReasonsEn[reason]) return previewReasonsEn[reason]
  let match = /^字段数 (\d+)，预期 (\d+)$/u.exec(reason)
  if (match) return `${match[1]} columns; expected ${match[2]}`
  match = /^第 (\d+) 条记录出现新字段：(.+)；当前采用首条记录的字段结构$/u.exec(reason)
  if (match) return `Record ${match[1]} has a new field (${match[2]}); using the first record's field structure`
  match = /^第 (\d+) 条记录缺少字段：(.+)$/u.exec(reason)
  if (match) return `Record ${match[1]} is missing field ${match[2]}`
  match = /^第 (\d+) 条记录的 (.+) 是 null$/u.exec(reason)
  if (match) return `Field ${match[2]} is null in record ${match[1]}`
  match = /^字段 (.+) 类型从 (.+) 变为 (.+)$/u.exec(reason)
  if (match) return `Field ${match[1]} changes type from ${match[2]} to ${match[3]}`
  match = /^字段 (.+) 超过 1 MiB 单元格限制$/u.exec(reason)
  if (match) return `Field ${match[1]} exceeds the 1 MiB cell limit`
  match = /^字段路径重复：(.+)$/u.exec(reason)
  if (match) return `Duplicate field path: ${match[1]}`
  match = /^嵌套对象 (.+) 需要选择展开或字符串化$/u.exec(reason)
  if (match) return `Nested object ${match[1]} requires flattening or string conversion`
  match = /^数组 (.+) 需要选择处理方式$/u.exec(reason)
  if (match) return `Array ${match[1]} requires a handling option`
  return /[\p{Script=Han}]/u.test(reason) ? 'This record could not be parsed. Check its source and import settings.' : reason
}

function suggestedColumnType(header: string, values: string[]): ColumnType {
  const filled = values.filter((value) => value !== '' && !value.endsWith('…'))
  if (!filled.length || /编号|代码|证件|电话|手机|邮编|账号|id|code|phone|zip/iu.test(header)) return 'string'
  if (filled.every((value) => value === 'true' || value === 'false')) return 'boolean'
  if (filled.every((value) => /^\d{4}-\d{2}-\d{2}$/u.test(value))) return 'date'
  if (filled.every((value) => /^[+-]?\d+$/u.test(value) && !/^[+-]?0\d/u.test(value) && value.replace(/\D/gu, '').length <= 15)) return 'integer'
  if (filled.every((value) => /^[+-]?\d+(?:\.\d+)?$/u.test(value) && value.replace(/\D/gu, '').length <= 15)) return 'decimal'
  return 'string'
}

function previewColumnTypes(preview: CsvPreview) {
  return Object.fromEntries(preview.headers.map((name, index) => [`c_${index}`,
    suggestedColumnType(name, preview.rows.map((row) => row[index] ?? ''))])) as Record<string, ColumnType>
}

function matchingUpload(previous: PreviousUpload[], file: File, sha256: string, fingerprint: string, workspaceId: string) {
  return previous.find((candidate) => candidate.size === file.size && candidate.metadata?.filename === file.name &&
    candidate.metadata?.sha256 === sha256 && candidate.metadata?.fingerprint === fingerprint &&
    candidate.metadata?.workspaceId === workspaceId &&
    /^[A-Za-z0-9_-]{16,128}$/.test(candidate.metadata?.uploadKey ?? ''))
}

export function ImportPage() {
  const locale = useLocale()
  const t = useT()
  const previewAgain = t('配置已改变，请重新预览', 'Settings changed; preview again')
  const client = useQueryClient()
  const storage = useQuery({ queryKey: ['storage', 'details'], queryFn: api.storageDetails })
  const navigate = useNavigate()
  const [items, setItems] = useState<QueueItem[]>([])
  const [exampleBusy, setExampleBusy] = useState(false)
  const [exampleError, setExampleError] = useState<string | null>(null)
  const [parseConfigError, setParseConfigError] = useState<string | null>(null)
  const [pendingNames, setPendingNames] = useState<string[]>([])
  const [csvOptions, setCsvOptions, csvRestored] = useSessionDraft<CsvImportOptions>('ImportPage.csvOptions', { encoding: 'utf-8', delimiter: ',', header: 'first-row', quote: '"', headerRow: 1, dataStartRow: 2, dataEndRow: null, skipEmptyLines: false })
  const [jsonOptions, setJsonOptions] = useSessionDraft<JsonImportOptions>('ImportPage.jsonOptions', { nulls: 'reject', missing: 'reject', newFields: 'reject' })
  const encodingTouched = useRef(false)
  const itemsRef = useRef(items)
  const controllers = useRef(new Map<string, { upload: Upload; reject: (error: Error) => void }>())
  const hashing = useRef(new Map<string, AbortController>())
  const cancelled = useRef(new Set<string>())
  itemsRef.current = items

  useEffect(() => {
    let active = true
    void client.fetchQuery({ queryKey: ['settings'], queryFn: api.settings }).then((result) => {
      if (active && !csvRestored && !encodingTouched.current && itemsRef.current.length === 0) {
        setCsvOptions((current) => ({ ...current, encoding: result.settings.defaultEncoding }))
      }
    }).catch(() => { /* 设置不可用时沿用安全的 UTF-8 默认值。 */ })
    return () => { active = false }
  }, [client, csvRestored])

  const patch = (id: string, changes: Partial<QueueItem>) => {
    setItems((current) => {
      const next = current.map((item) => item.id === id ? { ...item, ...changes } : item)
      itemsRef.current = next
      return next
    })
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const session = await client.fetchQuery({ queryKey: ['session'], queryFn: api.session })
        const previous = await defaultOptions.urlStorage.findAllUploads()
        const candidates = previous.filter((entry) => entry.uploadUrl &&
          new URL(entry.uploadUrl, location.origin).pathname.startsWith('/api/v1/tus/') &&
          entry.metadata?.workspaceId === session.user.workspaceId && entry.metadata?.filename && entry.metadata?.uploadKey)
        const unresolved = await Promise.all(candidates.map(async (entry) => {
          try { await api.uploadByKey(entry.metadata.uploadKey); return null }
          catch (error) { return error instanceof ApiError && error.status === 404 ? entry.metadata.filename : null }
        }))
        if (active) setPendingNames([...new Set(unresolved.filter((name): name is string => Boolean(name)))])
      } catch { /* 浏览器可能不允许保存续传 URL；本次上传仍可继续。 */ }
    })()
    return () => { active = false }
  }, [])

  const enqueueFiles = (chosen: File[]) => {
    setItems((current) => [...current, ...chosen.map((file) => {
      const key = crypto.randomUUID()
      return { id: crypto.randomUUID(), file, key, csv: { ...csvOptions, delimiter: file.name.toLowerCase().endsWith('.tsv') ? '\t' as const : csvOptions.delimiter },
        json: { ...jsonOptions, dataPath: /\.json$/i.test(file.name) ? jsonOptions.dataPath : undefined }, state: 'ready' as const, progress: 0 }
    })])
  }
  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    enqueueFiles(Array.from(event.target.files ?? []))
    event.target.value = ''
  }

  const prepareRaw = async (id: string, item: QueueItem, raw: Resource) => {
    patch(id, { raw, state: 'previewing', progress: item.file.size, error: undefined, matches: undefined })
    void client.invalidateQueries({ queryKey: ['resources'] })
    if (raw.format === 'csv' || raw.format === 'tsv') {
      const preview = await api.previewRawCsv(raw.id, item.csv)
      if (!cancelled.current.has(id)) patch(id, { raw, preview, columnTypes: previewColumnTypes(preview), state: 'uploaded' })
    } else if (['json', 'jsonl', 'ndjson'].includes(raw.format)) {
      const preview = await api.previewRawJson(raw.id, item.json)
      if (!cancelled.current.has(id)) patch(id, { raw, preview, columnTypes: previewColumnTypes(preview), state: 'uploaded' })
    } else if (raw.format === 'parquet') {
      const preview = await api.previewRawParquet(raw.id)
      if (!cancelled.current.has(id)) patch(id, { raw, preview, columnTypes: previewColumnTypes(preview), state: 'uploaded' })
    } else {
      const sheets = await api.workbookSheets(raw.id)
      if (!cancelled.current.has(id)) patch(id, { raw, sheets, sheetNames: item.sheetNames ?? (sheets[0] ? [sheets[0].name] : []), previewTarget: item.previewTarget ?? sheets[0]?.name, state: 'uploaded' })
    }
  }

  const reuseExisting = async (id: string, raw: Resource) => {
    const item = itemsRef.current.find((value) => value.id === id)
    if (!item || item.state !== 'duplicate' || !item.matches?.some((match) => match.id === raw.id)) return
    try { await prepareRaw(id, item, raw) }
    catch (error) { if (!cancelled.current.has(id)) patch(id, { state: 'error', error: error instanceof Error ? error.message : t('已有文件预览失败', 'Could not preview existing file') }) }
  }

  const begin = async (id: string, forceNew = false) => {
    const item = itemsRef.current.find((value) => value.id === id)
    if (!item || !(['ready', 'error'].includes(item.state) || forceNew && item.state === 'duplicate')) return
    cancelled.current.delete(id)
    if (item.raw) {
      try { await prepareRaw(id, item, item.raw) }
      catch (error) { if (!cancelled.current.has(id)) patch(id, { state: 'error', error: error instanceof Error ? error.message : t('预览失败', 'Preview failed') }) }
      return
    }
    const workbook = /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(item.file.name)
    const maxBytes = workbook ? storage.data?.limits.workbookBytes ?? MAX_WORKBOOK_BYTES : storage.data?.limits.fileBytes ?? MAX_FILE_BYTES
    if (!/\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods|json|jsonl|ndjson|parquet)$/i.test(item.file.name) || item.file.size < 1 || item.file.size > maxBytes) {
      patch(id, { state: 'error', error: t(`文件格式不支持、文件为空，或超过当前 ${bytes(maxBytes)} 上限`, `Unsupported file format, empty file, or larger than the current ${bytes(maxBytes)} limit`) })
      return
    }
    const abort = new AbortController()
    hashing.current.set(id, abort)
    patch(id, { state: 'checking', progress: 0, error: undefined })
    try {
      const digest = item.digest ?? await fileDigest(item.file, (read) => patch(id, { progress: read }), abort.signal)
      hashing.current.delete(id)
      if (cancelled.current.has(id)) return
      patch(id, { digest })
      if (!forceNew && !item.ignoreDuplicate) {
        try {
          const matches = await api.matchingRawUploads(digest.sha256, item.file.size, item.file.name.toLowerCase().split('.').at(-1) ?? '')
          if (cancelled.current.has(id)) return
          if (matches.length) { patch(id, { matches, state: 'duplicate', progress: item.file.size }); return }
        } catch { /* 重复文件提示不可用时，仍按正常上传流程继续。 */ }
      }
      if (cancelled.current.has(id)) return
      if (forceNew) patch(id, { ignoreDuplicate: true, matches: undefined })
      const session = await client.fetchQuery({ queryKey: ['session'], queryFn: api.session })
      if (cancelled.current.has(id)) return
      let key = item.key
      let raw: Resource | null = null
      const upload = new Upload(item.file, {
        endpoint: '/api/v1/tus',
        chunkSize: 8 * 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000],
        headers: { 'x-qsv-request': '1' },
        fingerprint: async () => digest.fingerprint,
        metadata: { filename: item.file.name, uploadKey: key, fingerprint: digest.fingerprint, sha256: digest.sha256, workspaceId: session.user.workspaceId },
        onProgress: (sent) => patch(id, { state: 'uploading', progress: sent }),
      })
      const previous = matchingUpload(await upload.findPreviousUploads(), item.file, digest.sha256, digest.fingerprint, session.user.workspaceId)
      if (previous) {
        key = previous.metadata.uploadKey
        patch(id, { key })
        try { raw = await api.uploadByKey(key) }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error }
        if (!raw) {
          upload.options.metadata = { filename: item.file.name, uploadKey: key, fingerprint: digest.fingerprint, sha256: digest.sha256, workspaceId: session.user.workspaceId }
          upload.resumeFromPreviousUpload(previous)
        }
      }
      if (!raw) {
        patch(id, { state: 'uploading', progress: 0 })
        raw = await new Promise<Resource>((resolve, reject) => {
          controllers.current.set(id, { upload, reject })
          upload.options.onError = (error) => reject(error)
          upload.options.onSuccess = () => {
            const path = upload.url ? new URL(upload.url, location.origin).pathname : ''
            const match = /^\/api\/v1\/tus\/([0-9a-f]{32})$/.exec(path)
            if (!match) { reject(new Error(t('服务未返回有效的上传地址', 'The service did not return a valid upload URL'))); return }
            patch(id, { state: 'committing', progress: item.file.size })
            void api.commitTus(match[1], key).then(resolve, reject)
          }
          upload.start()
        })
        controllers.current.delete(id)
      }
      if (cancelled.current.has(id)) return
      await prepareRaw(id, item, raw)
    } catch (error) {
      if (!cancelled.current.has(id)) patch(id, { state: 'error', error: error instanceof Error ? error.message : t('上传失败', 'Upload failed') })
    } finally {
      hashing.current.delete(id)
      controllers.current.delete(id)
    }
  }

  const submit = async (id: string) => {
    const item = itemsRef.current.find((value) => value.id === id)
    if (!item?.raw || item.state !== 'uploaded') return
    const selected = item.sheets ? item.sheets.filter((sheet) => item.sheetNames?.includes(sheet.name)) : []
    if (item.sheets && selected.length === 0) { patch(id, { error: t('请至少选择一张工作表', 'Select at least one sheet') }); return }
    patch(id, { state: 'importing', error: undefined })
    const choices: { name?: string; key: string }[] = item.sheets
      ? selected.map((sheet) => ({ name: sheet.name, key: `import_${item.id}_${sheet.index}` }))
      : [{ key: `import_${item.id}_csv` }]
    const results = await Promise.allSettled(choices.map((choice) => api.import(item.raw!.id, choice.key, item.csv, choice.name, item.json,
      choice.name ? item.sheetColumnTypes?.[choice.name] : item.columnTypes)))
    if (cancelled.current.has(id)) {
      for (const result of results) if (result.status === 'fulfilled') await api.cancel(result.value.job.id)
    }
    const cards = results.map((result, index): QueueItem => {
      const choice = choices[index]!
      return { ...item, id: index === 0 ? item.id : crypto.randomUUID(), sheetName: choice.name, sheetNames: choice.name ? [choice.name] : undefined,
        state: result.status === 'fulfilled' ? 'submitted' : 'error',
        job: result.status === 'fulfilled' ? result.value.job : undefined,
        dataset: result.status === 'fulfilled' ? result.value.resource : undefined,
        error: result.status === 'rejected' ? result.reason instanceof Error ? result.reason.message : t('导入提交失败', 'Could not submit import') : undefined }
    })
    setItems((current) => {
      const next = current.flatMap((entry) => entry.id === id ? cards : [entry])
      itemsRef.current = next
      return next
    })
    void client.invalidateQueries({ queryKey: ['jobs'] })
  }

  const previewSheet = async (id: string) => {
    const item = itemsRef.current.find((value) => value.id === id)
    if (!item?.raw || !item.previewTarget || item.state !== 'uploaded') return
    patch(id, { state: 'previewing', error: undefined })
    try {
      const preview = await api.previewWorkbookSheet(item.raw.id, item.previewTarget, item.csv)
      if (!cancelled.current.has(id)) patch(id, { preview, sheetColumnTypes: { ...item.sheetColumnTypes,
        [item.previewTarget]: previewColumnTypes(preview) }, state: 'uploaded' })
    } catch (error) { if (!cancelled.current.has(id)) patch(id, { state: 'uploaded', error: error instanceof Error ? error.message : t('工作表预览失败', 'Sheet preview failed') }) }
  }

  const pause = async (id: string) => {
    const controller = controllers.current.get(id)
    if (!controller) return
    await controller.upload.abort()
    patch(id, { state: 'paused' })
  }

  const resume = (id: string) => {
    const controller = controllers.current.get(id)
    if (!controller) { patch(id, { state: 'error', error: t('请重新选择文件后继续', 'Reselect the file to continue') }); return }
    patch(id, { state: 'uploading' })
    controller.upload.start()
  }

  const cancel = async (id: string) => {
    const item = itemsRef.current.find((value) => value.id === id)
    if (!item) return
    if (item.job && ['queued', 'running'].includes(item.job.state)) {
      try { patch(id, { job: await api.cancel(item.job.id), state: 'submitted' }) }
      catch (error) { patch(id, { error: error instanceof Error ? error.message : t('取消任务失败', 'Could not cancel job') }) }
      return
    }
    cancelled.current.add(id)
    hashing.current.get(id)?.abort()
    const controller = controllers.current.get(id)
    if (controller) {
      try { await controller.upload.abort(true) } catch { /* 上传已经结束时无需终止。 */ }
      controller.reject(new Error(t('上传已取消', 'Upload cancelled')))
    }
    patch(id, { state: 'cancelled' })
  }

  const retryJob = async (item: QueueItem) => {
    if (!item.job || item.job.error?.retryable === false) return
    const retryKey = `retry_${item.job.id}`
    patch(item.id, { state: 'importing', error: undefined })
    try {
      const result = await api.retry(item.job.id, retryKey)
      patch(item.id, { dataset: result.resource, job: result.job, state: 'submitted' })
      void client.invalidateQueries({ queryKey: ['jobs'] })
    } catch (error) { patch(item.id, { state: 'error', error: error instanceof Error ? error.message : t('重试任务失败', 'Could not retry job') }) }
  }

  const previewImportResult = async (item: QueueItem) => {
    if (!item.dataset) return
    patch(item.id, { importPreviewError: undefined })
    try {
      const result = await api.previewImportResult(item.dataset.id)
      patch(item.id, { importPreview: result.available ? result.preview : undefined, importPreviewStage: result.stage })
    } catch (error) {
      patch(item.id, { importPreviewError: error instanceof Error ? error.message : t('结果样本读取失败', 'Could not read result sample') })
    }
  }

  const pollingIds = items.filter((item) => item.state === 'submitted' && item.job).map((item) => item.id).join(',')
  useEffect(() => {
    if (!pollingIds) return
    const timer = window.setInterval(() => {
      for (const id of pollingIds.split(',')) {
        const jobId = itemsRef.current.find((item) => item.id === id)?.job?.id
        if (!jobId) continue
        void api.job(jobId).then((job) => {
          patch(id, { job, state: job.state === 'succeeded' ? 'done' : ['failed', 'cancelled', 'interrupted'].includes(job.state) ? 'error' : 'submitted',
            error: job.error ? localizedErrorMessage(job.error.code, job.error.message) : undefined })
        }).catch(() => { /* 连接恢复后下次轮询。 */ })
      }
    }, 1500)
    return () => window.clearInterval(timer)
  }, [pollingIds])

  const busy = items.some((item) => ['checking', 'uploading', 'committing'].includes(item.state))
  const importExample = async () => {
    setExampleBusy(true)
    setExampleError(null)
    try {
      const result = await api.importOrdersExample()
      void client.invalidateQueries({ queryKey: ['resources'] })
      void client.invalidateQueries({ queryKey: ['jobs'] })
      void client.invalidateQueries({ queryKey: ['overview'] })
      void navigate({ to: '/jobs/$jobId', params: { jobId: result.job.id } })
    } catch (error) { setExampleError(error instanceof Error ? error.message : t('示例导入失败', 'Example import failed')) }
    finally { setExampleBusy(false) }
  }
  const saveParseConfig = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, csv: csvOptions, json: jsonOptions }, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'qsv-import-config.json'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const loadParseConfig = async (file: File | undefined) => {
    if (!file) return
    setParseConfigError(null)
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('配置文件格式无效', 'Invalid configuration file format'))
      const document = parsed as { version?: unknown; csv?: unknown; json?: unknown }
      if (document.version !== 1 || !document.csv || typeof document.csv !== 'object' || Array.isArray(document.csv) ||
        !document.json || typeof document.json !== 'object' || Array.isArray(document.json)) throw new Error(t('配置文件版本或内容无效', 'Invalid configuration file version or content'))
      const csv = document.csv as Record<string, unknown>, json = document.json as Record<string, unknown>
      if (Object.keys(csv).some((key) => !['encoding', 'delimiter', 'header', 'quote', 'headerRow', 'dataStartRow', 'dataEndRow', 'skipEmptyLines', 'invalidRows', 'headerRowCount', 'headerJoin', 'headerFill'].includes(key)) ||
        !['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(String(csv.encoding)) || ![',', ';', '\t', '|'].includes(String(csv.delimiter)) ||
        !['first-row', 'none'].includes(String(csv.header)) || !['"', "'"].includes(String(csv.quote)) ||
        !Number.isSafeInteger(csv.headerRow) || Number(csv.headerRow) < 1 || Number(csv.headerRow) > 1_000_000 ||
        csv.headerRowCount !== undefined && (!Number.isSafeInteger(csv.headerRowCount) || Number(csv.headerRowCount) < 1 || Number(csv.headerRowCount) > 5) ||
        csv.header === 'none' && Number(csv.headerRowCount ?? 1) !== 1 ||
        Number(csv.headerRowCount ?? 1) > 1 && !['space', 'slash', 'underscore'].includes(String(csv.headerJoin)) ||
        csv.headerJoin !== undefined && !['space', 'slash', 'underscore'].includes(String(csv.headerJoin)) ||
        csv.headerFill !== undefined && typeof csv.headerFill !== 'boolean' ||
        !Number.isSafeInteger(csv.dataStartRow) || Number(csv.dataStartRow) < (csv.header === 'first-row' ? Number(csv.headerRow) + Number(csv.headerRowCount ?? 1) : 1) || Number(csv.dataStartRow) > 1_000_000_000 ||
        csv.dataEndRow !== null && (!Number.isSafeInteger(csv.dataEndRow) || Number(csv.dataEndRow) < Number(csv.dataStartRow) || Number(csv.dataEndRow) > 1_000_000_000) ||
        typeof csv.skipEmptyLines !== 'boolean' || csv.invalidRows !== undefined && !['reject', 'isolate'].includes(String(csv.invalidRows)) ||
        Object.keys(json).some((key) => !['nulls', 'missing', 'newFields', 'projection', 'nested', 'arrays', 'explodePath', 'dataPath', 'typeConflict', 'invalidRecords'].includes(key)) ||
        !['reject', 'empty'].includes(String(json.nulls)) || !['reject', 'empty'].includes(String(json.missing)) ||
        json.newFields !== undefined && !['reject', 'ignore', 'include'].includes(String(json.newFields)) ||
        json.nested !== undefined && !['reject', 'flatten', 'stringify'].includes(String(json.nested)) ||
        json.arrays !== undefined && !['reject', 'stringify', 'explode'].includes(String(json.arrays)) ||
        json.typeConflict !== undefined && !['text', 'reject'].includes(String(json.typeConflict)) ||
        json.invalidRecords !== undefined && !['reject', 'isolate'].includes(String(json.invalidRecords)) ||
        (json.arrays === 'explode') !== (typeof json.explodePath === 'string' && json.explodePath.startsWith('/') && json.explodePath.length > 1 && json.explodePath.length <= 1024) ||
        json.dataPath !== undefined && (typeof json.dataPath !== 'string' || !json.dataPath.startsWith('/') || json.dataPath.length < 2 || json.dataPath.length > 1024) ||
        json.projection !== undefined && (!Array.isArray(json.projection) || json.projection.length < 1 || json.projection.length > 4096 ||
          json.projection.some((value: unknown) => typeof value !== 'string' || !value || value.length > 1024) ||
          new Set(json.projection).size !== json.projection.length)) {
        throw new Error(t('解析配置含有无效选项', 'Parsing configuration contains invalid options'))
      }
      encodingTouched.current = true
      setCsvOptions(csv as unknown as CsvImportOptions)
      setJsonOptions(json as unknown as JsonImportOptions)
    } catch (error) { setParseConfigError(error instanceof Error ? error.message : t('无法读取解析配置', 'Could not read parsing configuration')) }
  }
  return <><PageTopBar title={t('导入与解析', 'Import and parse')} facts={<Fact label={t('当前格式', 'Supported formats')}>CSV / TSV / Excel / ODS / JSON / Parquet</Fact>} /><PageBody className="space-y-5">
    <Banner tone="info" title={t('文件会传到当前用户的服务端空间', 'Files are uploaded to your server workspace')}>{t(`可一次选择多份文件。每份文件先计算完整摘要，再分块上传；暂停、断线或刷新后，重新选择同一文件即可核对并继续。工作簿上限 ${bytes(storage.data?.limits.workbookBytes ?? MAX_WORKBOOK_BYTES)}，其余支持的格式上限 ${bytes(storage.data?.limits.fileBytes ?? MAX_FILE_BYTES)}。`, `Select multiple files at once. Each file is fully hashed before chunked upload. After a pause, disconnection or refresh, reselect the same file to verify and resume. Workbook limit: ${bytes(storage.data?.limits.workbookBytes ?? MAX_WORKBOOK_BYTES)}; other supported formats: ${bytes(storage.data?.limits.fileBytes ?? MAX_FILE_BYTES)}.`)}</Banner>
    {pendingNames.length ? <Banner tone="warn" title={t('发现尚未完成的上传', 'Unfinished uploads found')}>{t(`重新选择这些文件以继续：${pendingNames.join('、')}。浏览器刷新后需要再次授予本地文件读取权限。`, `Reselect these files to continue: ${pendingNames.join(', ')}. After refreshing, grant browser access to the local files again.`)}</Banner> : null}
    <Panel className="max-w-4xl"><label htmlFor="import-files" className="text-title font-semibold text-ink">{t('选择文件', 'Select files')}</label>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-meta text-ink-2">{t('文本编码', 'Text encoding')}<select aria-label={t('CSV 文本编码', 'CSV text encoding')} value={csvOptions.encoding} onChange={(event) => { encodingTouched.current = true; setCsvOptions((current) => ({ ...current, encoding: event.target.value as CsvImportOptions['encoding'] })) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="utf-8">UTF-8</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030</option></select></label>
        <label className="space-y-1 text-meta text-ink-2">{t('分隔符', 'Delimiter')}<select aria-label={t('CSV 分隔符', 'CSV delimiter')} value={csvOptions.delimiter} onChange={(event) => setCsvOptions((current) => ({ ...current, delimiter: event.target.value as CsvImportOptions['delimiter'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value=",">{t('逗号', 'Comma')}</option><option value=";">{t('分号', 'Semicolon')}</option><option value="\t">{t('制表符', 'Tab')}</option><option value="|">{t('竖线', 'Pipe')}</option></select></label>
        <label className="space-y-1 text-meta text-ink-2">{t('表头', 'Header')}<select aria-label={t('CSV 表头方式', 'CSV header mode')} value={csvOptions.header} onChange={(event) => setCsvOptions((current) => ({ ...current, header: event.target.value as CsvImportOptions['header'], headerRowCount: event.target.value === 'none' ? 1 : current.headerRowCount, dataStartRow: event.target.value === 'first-row' ? current.headerRow + (current.headerRowCount ?? 1) : 1 }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="first-row">{t('指定行是表头', 'Selected row is header')}</option><option value="none">{t('没有表头，自动生成字段名', 'No header; generate field names')}</option></select></label>
        <label className="space-y-1 text-meta text-ink-2">{t('引号字符', 'Quote character')}<select aria-label={t('CSV 引号字符', 'CSV quote character')} value={csvOptions.quote} onChange={(event) => setCsvOptions((current) => ({ ...current, quote: event.target.value as CsvImportOptions['quote'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value={'"'}>{t('双引号 "', 'Double quote "')}</option><option value={"'"}>{t("单引号 '", "Single quote '")}</option></select></label>
        {csvOptions.header === 'first-row' ? <label className="space-y-1 text-meta text-ink-2">{t('表头记录序号', 'Header record number')}<input aria-label={t('CSV 表头记录序号', 'CSV header record number')} type="number" min="1" max="1000000" value={csvOptions.headerRow} onChange={(event) => setCsvOptions((current) => { const headerRow = Number(event.target.value); return { ...current, headerRow, dataStartRow: Math.max(current.dataStartRow, headerRow + (current.headerRowCount ?? 1)) } })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label> : null}
        <label className="space-y-1 text-meta text-ink-2">{t('数据开始记录', 'First data record')}<input aria-label={t('CSV 数据开始记录', 'CSV first data record')} type="number" min={csvOptions.header === 'first-row' ? csvOptions.headerRow + (csvOptions.headerRowCount ?? 1) : 1} value={csvOptions.dataStartRow} onChange={(event) => setCsvOptions((current) => ({ ...current, dataStartRow: Number(event.target.value) }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
        <label className="space-y-1 text-meta text-ink-2">{t('数据结束记录（留空为文件末尾）', 'Last data record (blank means end of file)')}<input aria-label={t('CSV 数据结束记录', 'CSV last data record')} type="number" min={csvOptions.dataStartRow} value={csvOptions.dataEndRow ?? ''} onChange={(event) => setCsvOptions((current) => ({ ...current, dataEndRow: event.target.value ? Number(event.target.value) : null }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail" /></label>
        {csvOptions.header === 'first-row' ? <label className="space-y-1 text-meta text-ink-2">{t('表头记录数', 'Header record count')}<select value={csvOptions.headerRowCount ?? 1} onChange={(event) => setCsvOptions((current) => { const headerRowCount = Number(event.target.value); return { ...current, headerRowCount, headerJoin: headerRowCount > 1 ? current.headerJoin ?? 'space' : current.headerJoin, dataStartRow: current.dataStartRow === current.headerRow + (current.headerRowCount ?? 1) ? current.headerRow + headerRowCount : Math.max(current.dataStartRow, current.headerRow + headerRowCount) } })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell">{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{t(`${count} 行`, `${count} rows`)}</option>)}</select></label> : null}
        <label className="flex items-center gap-2 text-meta text-ink-2"><input type="checkbox" checked={csvOptions.skipEmptyLines} onChange={(event) => setCsvOptions((current) => ({ ...current, skipEmptyLines: event.target.checked }))} />{t('跳过空记录', 'Skip empty records')}</label>
      </div>
      {csvOptions.header === 'first-row' && (csvOptions.headerRowCount ?? 1) > 1 ? <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-meta text-ink-2">{t('多行表头连接方式', 'Multirow header join')}<select value={csvOptions.headerJoin ?? 'space'} onChange={(event) => setCsvOptions((current) => ({ ...current, headerJoin: event.target.value as CsvImportOptions['headerJoin'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="space">{t('空格', 'Space')}</option><option value="slash">{t('斜线 /', 'Slash /')}</option><option value="underscore">{t('下划线 _', 'Underscore _')}</option></select></label><label className="flex items-center gap-2 text-meta text-ink-2"><input type="checkbox" checked={csvOptions.headerFill ?? false} onChange={(event) => setCsvOptions((current) => ({ ...current, headerFill: event.target.checked }))} />{t('空表头单元格沿本行向右填充（适用于合并单元格）', 'Fill empty header cells to the right within each row (for merged cells)')}</label></div> : null}
      <label className="mt-3 block max-w-md space-y-1 text-meta text-ink-2">{t('CSV / 工作表异常记录', 'CSV / sheet invalid records')}<select value={csvOptions.invalidRows ?? 'reject'} onChange={(event) => setCsvOptions((current) => ({ ...current, invalidRows: event.target.value as CsvImportOptions['invalidRows'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('遇到时停止导入', 'Stop import on error')}</option><option value="isolate">{t('跳过并生成错误清单', 'Skip and create error report')}</option></select><span>{t('可隔离字段数或单元格大小异常的完整记录；引号、编码等无法确定记录边界的错误仍会停止导入。', 'Complete records with a wrong field count or oversized cells can be isolated. Quote or encoding errors that prevent record boundary detection still stop the import.')}</span></label>
      <div className="mt-4 grid gap-3 border-t border-hairline-soft pt-4 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-2">{t('JSON 中的 null', 'JSON null values')}<select value={jsonOptions.nulls} onChange={(event) => setJsonOptions((current) => ({ ...current, nulls: event.target.value as JsonImportOptions['nulls'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="reject">{t('遇到时拒绝导入', 'Reject import when found')}</option><option value="empty">{t('明确转为空文本', 'Convert explicitly to empty text')}</option></select></label><label className="space-y-1 text-meta text-ink-2">{t('JSON 缺少字段', 'JSON missing fields')}<select value={jsonOptions.missing} onChange={(event) => setJsonOptions((current) => ({ ...current, missing: event.target.value as JsonImportOptions['missing'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="reject">{t('遇到时拒绝导入', 'Reject import when found')}</option><option value="empty">{t('明确补为空文本', 'Fill explicitly with empty text')}</option></select></label></div>
      <label className="mt-3 block max-w-md space-y-1 text-meta text-ink-2">{t('JSON 后续出现新字段', 'New fields later in JSON')}<select value={jsonOptions.newFields ?? 'reject'} onChange={(event) => setJsonOptions((current) => ({ ...current, newFields: event.target.value as JsonImportOptions['newFields'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('拒绝并指出记录', 'Reject and identify record')}</option><option value="ignore">{t('忽略后续新字段', 'Ignore later fields')}</option><option value="include">{t('扫描全文件并加入新字段', 'Scan full file and include new fields')}</option></select></label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-2">{t('JSON 嵌套对象', 'Nested JSON objects')}<select value={jsonOptions.nested ?? 'reject'} onChange={(event) => setJsonOptions((current) => ({ ...current, nested: event.target.value as JsonImportOptions['nested'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('遇到时拒绝', 'Reject when found')}</option><option value="flatten">{t('按字段路径展开', 'Flatten by field path')}</option><option value="stringify">{t('保留为 JSON 文本', 'Keep as JSON text')}</option></select></label><label className="space-y-1 text-meta text-ink-2">{t('JSON 数组', 'JSON arrays')}<select value={jsonOptions.arrays ?? 'reject'} onChange={(event) => setJsonOptions((current) => ({ ...current, arrays: event.target.value as JsonImportOptions['arrays'], explodePath: event.target.value === 'explode' ? current.explodePath ?? '/items' : undefined }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('遇到时拒绝', 'Reject when found')}</option><option value="stringify">{t('保留为 JSON 文本', 'Keep as JSON text')}</option><option value="explode">{t('指定一条路径展开为多行', 'Expand one selected path into rows')}</option></select></label></div>
      {jsonOptions.arrays === 'explode' ? <label className="mt-3 block max-w-md space-y-1 text-meta text-ink-2">{t('要展开的数组路径', 'Array path to expand')}<input value={jsonOptions.explodePath ?? ''} onChange={(event) => setJsonOptions((current) => ({ ...current, explodePath: event.target.value }))} placeholder="/items" className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /><span>{t('使用 /字段/子字段 形式；每条原记录最多展开 10000 行，其余数组保留为 JSON 文本。', 'Use /field/subfield syntax. Each source record may expand to at most 10,000 rows; other arrays remain JSON text.')}</span></label> : null}
      <label className="mt-3 block max-w-md space-y-1 text-meta text-ink-2">{t('JSON 对象中的数据数组路径', 'Data array path in JSON object')}<input value={jsonOptions.dataPath ?? ''} onChange={(event) => setJsonOptions((current) => ({ ...current, dataPath: event.target.value || undefined }))} placeholder={t('留空表示顶层数组；例如 /data/items', 'Blank means top-level array; e.g. /data/items')} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /><span>{t('仅用于 .json 文件；JSONL 每行直接是一条记录。', 'For .json files only; each JSONL line is a record.')}</span></label>
      <label className="mt-3 block max-w-md space-y-1 text-meta text-ink-2">{t('JSON 字段类型变化', 'JSON field type changes')}<select value={jsonOptions.typeConflict ?? 'text'} onChange={(event) => setJsonOptions((current) => ({ ...current, typeConflict: event.target.value as JsonImportOptions['typeConflict'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="text">{t('按原文保存为文本', 'Keep original text')}</option><option value="reject">{t('指出记录并拒绝导入', 'Identify record and reject import')}</option></select></label>
      <label className="mt-3 block max-w-md space-y-1 text-meta text-ink-2">{t('JSON 异常记录', 'Invalid JSON records')}<select value={jsonOptions.invalidRecords ?? 'reject'} onChange={(event) => setJsonOptions((current) => ({ ...current, invalidRecords: event.target.value as JsonImportOptions['invalidRecords'] }))} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('遇到时停止导入', 'Stop import on error')}</option><option value="isolate">{t('跳过并生成错误清单', 'Skip and create error report')}</option></select><span>{t('只隔离可定位到单条记录的内容错误；JSON 语法错误仍会停止导入。', 'Only content errors attributable to one record can be isolated. JSON syntax errors still stop import.')}</span></label>
      <div className="mt-4 rounded-control border border-dashed border-line bg-surface-sunk p-4" onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={(event) => { event.preventDefault(); enqueueFiles(Array.from(event.dataTransfer.files)) }}><p className="text-cell text-ink-2">{t('将本地文件拖到这里，或使用下方文件选择器。两种方式进入同一个上传队列。', 'Drop local files here or use the file picker below. Both add files to the same upload queue.')}</p><input id="import-files" type="file" multiple accept=".csv,.tsv,.xlsx,.xls,.xlsm,.xlsb,.ods,.json,.jsonl,.ndjson,.parquet,text/csv,text/tab-separated-values,application/json" onChange={onFiles} className="mt-3 block w-full text-cell text-ink file:mr-4 file:rounded-control file:border-0 file:bg-surface file:px-3 file:py-2 file:text-cell file:text-ink" /></div>
      <p className="mt-2 text-meta text-ink-3">{t('CSV/TSV 使用上方文本配置；JSON/JSONL 的嵌套字段可使用路径展开。路径模式的字段名采用 /字段/子字段，数字按原文保留。工作簿上传后选择工作表。原文件保持不变，解析结果保存为 UTF-8 数据集。', 'CSV/TSV uses the text settings above. Nested JSON/JSONL fields can be flattened by path, using /field/subfield names; numbers keep their original text. Select sheets after uploading a workbook. The original file remains unchanged and parsed results are saved as UTF-8 datasets.')}</p>
      <div className="mt-4 space-y-2 border-t border-hairline-soft pt-4"><p className="text-cell font-medium">{t('复用解析配置', 'Reuse parsing settings')}</p><p className="text-meta text-ink-3">{t('保存或载入当前 CSV 与 JSON 选项。载入后只影响新选择的文件；新文件仍需逐份预览，工作表名称和字段结构不会自动沿用。', 'Save or load the current CSV and JSON settings. Loaded settings affect only files selected afterward. Preview each new file; sheet names and field structures are not reused automatically.')}</p><div className="flex flex-wrap items-center gap-2"><Button size="sm" onClick={saveParseConfig}>{t('保存配置文件', 'Save settings file')}</Button><input aria-label={t('载入解析配置', 'Load parsing settings')} type="file" accept=".json,application/json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void loadParseConfig(file) }} className="max-w-full text-meta" /></div>{parseConfigError ? <Banner tone="danger">{parseConfigError}</Banner> : null}</div>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-hairline-soft pt-4"><Button size="sm" variant="secondary" disabled={exampleBusy} onClick={() => void importExample()}>{exampleBusy ? t('正在创建示例任务', 'Creating example job') : t('使用内置示例', 'Use built-in example')}</Button><p className="text-meta text-ink-3">{t('非真实订单；点击后通过同一导入流程创建标有“内置示例”的资源和任务。', 'These are fictional orders. This creates resources and jobs labelled as a built-in example through the same import flow.')}</p></div>
      {exampleError ? <p role="alert" className="mt-2 text-meta text-danger-ink">{exampleError}</p> : null}
    </Panel>
    {items.length === 0 ? <p className="text-cell text-ink-3">{t('还没有待上传文件。', 'No files are waiting to upload.')}</p> : <div className="max-w-4xl space-y-3" aria-live="polite">{items.map((item) => <Panel key={item.id} className="space-y-3">
      <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><p className="truncate text-cell font-semibold text-ink" title={item.file.name}>{item.file.name}</p><p className="mt-1 text-meta text-ink-3">{bytes(item.file.size)} · {locale === 'en-US' ? stateTextEn[item.state] : stateText[item.state]}{item.job?.progress.stage ? ` · ${localizedStage(item.job.progress.stage)}` : ''}</p>{/\.(csv|tsv)$/i.test(item.file.name) ? <p className="mt-1 text-meta text-ink-3">{item.csv.encoding.toUpperCase()} · {item.csv.delimiter === '\t' ? t('制表符', 'Tab') : item.csv.delimiter === ',' ? t('逗号', 'Comma') : item.csv.delimiter === ';' ? t('分号', 'Semicolon') : t('竖线', 'Pipe')} · {item.csv.header === 'first-row' ? t('首行表头', 'First-row header') : t('无表头', 'No header')}</p> : null}</div><span className="figure text-meta text-ink-2">{['checking', 'uploading', 'paused', 'committing'].includes(item.state) ? `${Math.min(100, Math.round(item.progress / Math.max(1, item.file.size) * 100))}%` : ''}</span></div>
      {['checking', 'uploading', 'paused', 'committing'].includes(item.state) ? <progress aria-label={`${item.file.name} ${locale === 'en-US' ? stateTextEn[item.state] : stateText[item.state]}`} value={item.progress} max={item.file.size} className="h-2 w-full accent-accent" /> : null}
      {item.error ? <p role="alert" className="text-meta text-danger-ink">{item.error}</p> : null}
      {item.state === 'duplicate' && item.matches?.length ? <Banner tone="info" title={t('当前空间已有内容相同的原文件', 'Identical original file found in this workspace')}><div className="space-y-2"><p>{t('可复用已有原文件并重新确认解析配置；也可单独上传，创建新的原文件资源。两种选择都不会自动合并已有导入任务。', 'Reuse the existing original file and confirm parsing settings again, or upload a separate new original file. Neither choice merges existing import jobs automatically.')}</p>{item.matches.map((match) => <div key={match.id} className="flex flex-wrap items-center gap-2"><Link to="/resources/$resourceId" params={{ resourceId: match.id }} className="min-w-0 flex-1 truncate text-accent-ink hover:underline">{match.name}</Link><Button size="sm" onClick={() => void reuseExisting(item.id, match)}>{t('复用此原文件', 'Reuse this original file')}</Button></div>)}</div></Banner> : null}
      {/\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$/i.test(item.file.name) && item.raw && !item.job ? <label className="block max-w-md text-meta text-ink-2">{t('该文件的异常记录', 'Invalid records for this file')}<select value={item.csv.invalidRows ?? 'reject'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { csv: { ...item.csv, invalidRows: event.target.value as CsvImportOptions['invalidRows'] }, preview: undefined, sheetColumnTypes: undefined, state: 'error', error: previewAgain })} className="mt-1 block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('遇到时停止导入', 'Stop import on error')}</option><option value="isolate">{t('跳过并生成错误清单', 'Skip and create error report')}</option></select></label> : null}
      {/\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods)$/i.test(item.file.name) && item.raw && !item.job && item.csv.header === 'first-row' ? <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-meta text-ink-2">{t('该文件的表头记录数', 'Header records for this file')}<select value={item.csv.headerRowCount ?? 1} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => { const headerRowCount = Number(event.target.value); patch(item.id, { csv: { ...item.csv, headerRowCount, headerJoin: headerRowCount > 1 ? item.csv.headerJoin ?? 'space' : item.csv.headerJoin, dataStartRow: item.csv.dataStartRow === item.csv.headerRow + (item.csv.headerRowCount ?? 1) ? item.csv.headerRow + headerRowCount : Math.max(item.csv.dataStartRow, item.csv.headerRow + headerRowCount) }, preview: undefined, sheetColumnTypes: undefined, state: 'error', error: previewAgain }) }} className="block h-9 w-full rounded-control bg-surface px-2 text-cell">{[1, 2, 3, 4, 5].map((count) => <option key={count} value={count}>{t(`${count} 行`, `${count} rows`)}</option>)}</select></label>
        {(item.csv.headerRowCount ?? 1) > 1 ? <>
          <label className="text-meta text-ink-2">{t('连接方式', 'Join method')}<select value={item.csv.headerJoin ?? 'space'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { csv: { ...item.csv, headerJoin: event.target.value as CsvImportOptions['headerJoin'] }, preview: undefined, sheetColumnTypes: undefined, state: 'error', error: previewAgain })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="space">{t('空格', 'Space')}</option><option value="slash">{t('斜线 /', 'Slash /')}</option><option value="underscore">{t('下划线 _', 'Underscore _')}</option></select></label>
          <label className="flex items-center gap-2 text-meta text-ink-2"><input type="checkbox" checked={item.csv.headerFill ?? false} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { csv: { ...item.csv, headerFill: event.target.checked }, preview: undefined, sheetColumnTypes: undefined, state: 'error', error: previewAgain })} />{t('沿本行向右填充空表头单元格', 'Fill empty header cells to the right')}</label>
        </> : null}
      </div> : null}
      {/\.(json|jsonl|ndjson)$/i.test(item.file.name) && item.raw && !item.job ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-meta text-ink-2">{t('该文件的 null 策略', 'Null policy for this file')}<select value={item.json.nulls} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, nulls: event.target.value as JsonImportOptions['nulls'] }, preview: undefined, state: 'error', error: previewAgain })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="reject">{t('拒绝导入', 'Reject import')}</option><option value="empty">{t('转为空文本', 'Convert to empty text')}</option></select></label><label className="space-y-1 text-meta text-ink-2">{t('该文件的缺字段策略', 'Missing field policy for this file')}<select value={item.json.missing} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, missing: event.target.value as JsonImportOptions['missing'] }, preview: undefined, state: 'error', error: previewAgain })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell text-ink shadow-rail"><option value="reject">{t('拒绝导入', 'Reject import')}</option><option value="empty">{t('补为空文本', 'Fill with empty text')}</option></select></label></div> : null}
      {/\.(json|jsonl|ndjson)$/i.test(item.file.name) && item.raw && !item.job ? <div className="grid gap-3 sm:grid-cols-2"><label className="text-meta text-ink-2">{t('该文件的新字段策略', 'New field policy for this file')}<select value={item.json.newFields ?? 'reject'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, newFields: event.target.value as JsonImportOptions['newFields'] }, preview: undefined, state: 'error', error: previewAgain })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('拒绝', 'Reject')}</option><option value="ignore">{t('忽略', 'Ignore')}</option><option value="include">{t('全文件纳入', 'Include from full file')}</option></select></label><label className="text-meta text-ink-2">{t('只导入指定字段（每行一个；留空表示所有字段）', 'Import only selected fields (one per line; blank means all fields)')}<textarea rows={3} value={item.json.projection?.join('\n') ?? ''} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, projection: event.target.value.trim() ? event.target.value.split(/\r?\n/u).map((name) => name.trim()).filter(Boolean) : undefined }, preview: undefined, state: 'error', error: previewAgain })} className="block w-full rounded-control bg-surface px-2 py-1 text-cell" /></label></div> : null}
      {/\.(json|jsonl|ndjson)$/i.test(item.file.name) && item.raw && !item.job ? <div className="grid gap-3 sm:grid-cols-2"><label className="text-meta text-ink-2">{t('该文件的嵌套对象', 'Nested objects for this file')}<select value={item.json.nested ?? 'reject'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, nested: event.target.value as JsonImportOptions['nested'] }, preview: undefined, state: 'error', error: previewAgain })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('拒绝', 'Reject')}</option><option value="flatten">{t('按路径展开', 'Flatten by path')}</option><option value="stringify">{t('JSON 文本', 'JSON text')}</option></select></label><label className="text-meta text-ink-2">{t('该文件的数组', 'Arrays for this file')}<select value={item.json.arrays ?? 'reject'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, arrays: event.target.value as JsonImportOptions['arrays'], explodePath: event.target.value === 'explode' ? item.json.explodePath ?? '/items' : undefined }, preview: undefined, state: 'error', error: previewAgain })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('拒绝', 'Reject')}</option><option value="stringify">{t('JSON 文本', 'JSON text')}</option><option value="explode">{t('指定路径展开为多行', 'Expand selected path into rows')}</option></select></label>{item.json.arrays === 'explode' ? <label className="text-meta text-ink-2 sm:col-span-2">{t('数组路径', 'Array path')}<input value={item.json.explodePath ?? ''} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, explodePath: event.target.value }, preview: undefined, state: 'error', error: previewAgain })} placeholder="/items" className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label> : null}</div> : null}
      {/\.json$/i.test(item.file.name) && item.raw && !item.job ? <label className="block text-meta text-ink-2">{t('该文件的数据数组路径', 'Data array path for this file')}<input value={item.json.dataPath ?? ''} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, dataPath: event.target.value || undefined }, preview: undefined, state: 'error', error: previewAgain })} placeholder={t('留空表示顶层数组；例如 /data/items', 'Blank means top-level array; e.g. /data/items')} className="mt-1 block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label> : null}
      {/\.(json|jsonl|ndjson)$/i.test(item.file.name) && item.raw && !item.job ? <label className="block max-w-md text-meta text-ink-2">{t('该文件的字段类型变化', 'Field type changes for this file')}<select value={item.json.typeConflict ?? 'text'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, typeConflict: event.target.value as JsonImportOptions['typeConflict'] }, preview: undefined, state: 'error', error: previewAgain })} className="mt-1 block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="text">{t('按原文保存为文本', 'Keep original text')}</option><option value="reject">{t('指出记录并拒绝导入', 'Identify record and reject import')}</option></select></label> : null}
      {/\.(json|jsonl|ndjson)$/i.test(item.file.name) && item.raw && !item.job ? <label className="block max-w-md text-meta text-ink-2">{t('该文件的异常记录', 'Invalid records for this file')}<select value={item.json.invalidRecords ?? 'reject'} disabled={!['uploaded', 'error'].includes(item.state)} onChange={(event) => patch(item.id, { json: { ...item.json, invalidRecords: event.target.value as JsonImportOptions['invalidRecords'] }, preview: undefined, state: 'error', error: previewAgain })} className="mt-1 block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="reject">{t('遇到时停止导入', 'Stop import on error')}</option><option value="isolate">{t('跳过并生成错误清单', 'Skip and create error report')}</option></select></label> : null}
      {item.sheets ? <div className="space-y-2 text-cell"><p className="text-meta text-ink-3">{t('选择工作表；每张工作表会产生独立任务和数据集。以下行范围应用于本文件选择的所有工作表。', 'Select sheets. Each creates a separate job and dataset. The row range below applies to all selected sheets in this file.')}</p>
        <div className="max-h-48 space-y-1 overflow-auto rounded-control bg-surface-sunk p-2">{item.sheets.map((sheet) => <label key={sheet.index} className="flex items-center gap-2 text-cell text-ink-2"><input type="checkbox" checked={item.sheetName ? item.sheetName === sheet.name : (item.sheetNames ?? []).includes(sheet.name)} disabled={item.state !== 'uploaded'} onChange={(event) => patch(item.id, { sheetNames: event.target.checked ? [...(item.sheetNames ?? []), sheet.name] : (item.sheetNames ?? []).filter((name) => name !== sheet.name) })} /><span>{sheet.name} · {locale === 'en-US' ? sheet.visible === 'true' ? 'Visible' : sheet.visible === 'false' ? 'Hidden' : sheet.visible : sheet.visible} · {t(`${sheet.rowCount ?? '未知'} 行 / ${sheet.columnCount ?? '未知'} 列`, `${sheet.rowCount ?? 'Unknown'} rows / ${sheet.columnCount ?? 'Unknown'} columns`)}</span></label>)}</div>
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="text-meta">{t('表头', 'Header')}<select value={item.csv.header} onChange={(event) => patch(item.id, { csv: { ...item.csv, header: event.target.value as CsvImportOptions['header'], headerRowCount: event.target.value === 'none' ? 1 : item.csv.headerRowCount, dataStartRow: event.target.value === 'first-row' ? Math.max(item.csv.dataStartRow, item.csv.headerRow + (item.csv.headerRowCount ?? 1)) : item.csv.dataStartRow }, preview: undefined, sheetColumnTypes: undefined })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="first-row">{t('指定行作表头', 'Selected row is header')}</option><option value="none">{t('没有表头', 'No header')}</option></select></label>
          <label className="text-meta">{t('表头行号', 'Header row')}<input type="number" min={1} value={item.csv.headerRow} disabled={item.csv.header === 'none'} onChange={(event) => patch(item.id, { csv: { ...item.csv, headerRow: Number(event.target.value), dataStartRow: Math.max(item.csv.dataStartRow, Number(event.target.value) + (item.csv.headerRowCount ?? 1)) }, preview: undefined, sheetColumnTypes: undefined })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label>
          <label className="text-meta">{t('数据开始行', 'First data row')}<input type="number" min={1} value={item.csv.dataStartRow} onChange={(event) => patch(item.id, { csv: { ...item.csv, dataStartRow: Number(event.target.value) }, preview: undefined, sheetColumnTypes: undefined })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label>
          <label className="text-meta">{t('数据结束行', 'Last data row')}<input type="number" min={1} value={item.csv.dataEndRow ?? ''} placeholder={t('全部', 'All')} onChange={(event) => patch(item.id, { csv: { ...item.csv, dataEndRow: event.target.value ? Number(event.target.value) : null }, preview: undefined, sheetColumnTypes: undefined })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell" /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2"><select aria-label={t('预览工作表', 'Preview sheet')} value={item.previewTarget ?? ''} disabled={item.state !== 'uploaded'} onChange={(event) => patch(item.id, { previewTarget: event.target.value, preview: undefined })} className="h-8 max-w-full rounded-control bg-surface px-2 text-meta text-ink shadow-rail">{item.sheets.map((sheet) => <option key={sheet.index} value={sheet.name}>{sheet.name}</option>)}</select><Button size="sm" disabled={item.state !== 'uploaded'} onClick={() => void previewSheet(item.id)}>{t('预览所选范围样本', 'Preview selected range sample')}</Button></div>
        <p className="text-meta text-ink-3">{t('名称和行列数来自服务端元信息。完整内容在任务中解析；工作表不存在时不会改读第一张。', 'Names and dimensions come from server metadata. Complete content is parsed in the job. A missing sheet will never silently fall back to the first sheet.')}</p>
      </div> : null}
      {item.preview ? <div className="space-y-2"><p className="text-meta text-ink-3">{item.preview.sheetName ? `${item.preview.sheetName} · ${item.preview.sampleRange} · ` : ''}{t(`以下只显示 ${item.preview.sampleRows} 条样本记录、最多 30 列和每格 256 字；不是全表校验结果。确认后才会提交完整导入任务。`, `Only ${item.preview.sampleRows} sample records, up to 30 columns and 256 characters per cell are shown. This is not a full-table check. Confirm to submit the complete import job.`)}</p><div className="max-h-72 overflow-auto rounded-control bg-surface-sunk"><table className="min-w-full text-left text-meta"><thead><tr>{item.preview.headers.map((name, index) => <th key={index} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={name}>{name}</th>)}</tr></thead><tbody>{item.preview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={cell}>{cell}</td>)}</tr>)}</tbody></table></div>{item.preview.columnsTruncated ? <p className="text-meta text-ink-3">{t(`表格还有 ${item.preview.columnCount - item.preview.headers.length} 列未在样本中显示。`, `${item.preview.columnCount - item.preview.headers.length} more columns are hidden in the sample.`)}</p> : null}{item.preview.sampleErrors?.length ? <div className="rounded-control bg-surface-sunk p-2 text-meta text-ink-2"><p>{t(`样本中显示前 ${item.preview.sampleErrors.length} 条被隔离记录；完整任务会生成错误清单。`, `The sample shows ${item.preview.sampleErrors.length} isolated records. The complete job will produce an error report.`)}</p>{item.preview.sampleErrors.map((error) => <p key={error.record}>{t(`源记录 ${error.record}：`, `Source record ${error.record}: `)}{localizedPreviewReason(error.reason, locale === 'en-US')}</p>)}</div> : null}</div> : null}
      {item.preview?.sampleConversions?.length ? <div className="rounded-control bg-surface-sunk p-2 text-meta text-ink-2"><p>{t('样本中发现值转换或忽略字段；完整导入后可下载逐项清单。', 'The sample contains converted values or ignored fields. Download the itemized report after the complete import.')}</p>{item.preview.sampleConversions.map((change, index) => <p key={`${change.record}-${change.field}-${index}`}>{t(`源记录 ${change.record} · ${change.field}：`, `Source record ${change.record} · ${change.field}: `)}{localizedPreviewReason(change.reason, locale === 'en-US')}</p>)}</div> : null}
      {item.preview?.parquetColumns ? <div className="space-y-1 rounded-control bg-surface-sunk p-2 text-meta text-ink-2"><p>{t('Parquet 文件字段类型（最多显示 30 列）：本次导入会将可处理的单层字段写为 CSV 文本，空值会转为空文本；原文件保留。嵌套、重复或未确认转换方式的二进制字段在预览与正式导入时都会拒绝。', 'Parquet field types (up to 30 columns): supported top-level fields are written as CSV text and nulls become empty text. The original file remains. Nested, repeated or unconfirmed binary conversions are rejected during preview and import.')}</p><div className="flex max-h-36 flex-wrap gap-x-4 gap-y-1 overflow-auto">{item.preview.parquetColumns.map((field, index) => <span key={index}>{field.name}{t('：', ': ')}{field.logical ?? field.physical}{field.nullable ? t(' · 可为空', ' · nullable') : ''}</span>)}</div></div> : null}
      {item.preview && !item.job ? <div className="space-y-2 rounded-control bg-surface-sunk p-3"><p className="text-cell font-medium">{t('字段类型确认', 'Confirm field types')}</p><p className="text-meta text-ink-3">{t('下列类型仅根据可见样本建议；编号和超过 15 位的整数默认保留为文本。类型选择不会改写原值，完整导入会检查所有非空记录，不符合时任务失败。', 'The types below are suggested from the visible sample only. IDs and integers longer than 15 digits remain text by default. A type choice does not change original values; the full import checks every nonempty record and fails if a value does not conform.')}</p>{item.sheets ? <p className="text-meta text-ink-3">{t('本次类型只用于当前预览的工作表；其他工作表需分别预览，未预览的工作表按文本保存。', 'These types apply only to the currently previewed sheet. Preview other sheets separately; unpreviewed sheets are saved as text.')}</p> : null}<div className="grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">{item.preview.headers.map((name, index) => <label key={index} className="text-meta text-ink-2">{name || t(`第 ${index + 1} 列（空表头）`, `Column ${index + 1} (empty header)`)}<select value={(item.sheets && item.previewTarget ? item.sheetColumnTypes?.[item.previewTarget]?.[`c_${index}`] : item.columnTypes?.[`c_${index}`]) ?? 'string'} onChange={(event) => item.sheets && item.previewTarget ? patch(item.id, { sheetColumnTypes: { ...item.sheetColumnTypes, [item.previewTarget]: { ...item.sheetColumnTypes?.[item.previewTarget], [`c_${index}`]: event.target.value as ColumnType } } }) : patch(item.id, { columnTypes: { ...item.columnTypes, [`c_${index}`]: event.target.value as ColumnType } })} className="block h-9 w-full rounded-control bg-surface px-2 text-cell"><option value="string">{t('文本', 'Text')}</option><option value="integer">{t('整数文本', 'Integer text')}</option><option value="decimal">{t('十进制文本', 'Decimal text')}</option><option value="boolean">true / false</option><option value="date">{t('YYYY-MM-DD 日期', 'YYYY-MM-DD date')}</option></select></label>)}</div>{item.preview.columnsTruncated ? <p className="text-meta text-ink-3">{t('未显示的字段按文本保存。', 'Hidden fields are saved as text.')}</p> : null}</div> : null}
      <div className="flex flex-wrap gap-2">
        {['ready', 'error'].includes(item.state) && !item.job ? <Button size="sm" variant="primary" disabled={busy} onClick={() => void begin(item.id)}>{item.raw ? t('重试预览', 'Retry preview') : item.state === 'error' ? t('重试上传', 'Retry upload') : t('开始上传', 'Start upload')}</Button> : null}
        {item.state === 'duplicate' ? <Button size="sm" variant="primary" disabled={busy} onClick={() => void begin(item.id, true)}>{t('仍然上传新原文件', 'Upload a new original file anyway')}</Button> : null}
        {item.state === 'uploaded' ? <Button size="sm" variant="primary" onClick={() => void submit(item.id)}>{item.sheets ? t('确认并导入所选工作表', 'Confirm and import selected sheets') : t('确认并导入完整文件', 'Confirm and import complete file')}</Button> : null}
        {item.state === 'error' && item.job?.error?.retryable !== false ? <Button size="sm" variant="primary" onClick={() => void retryJob(item)}>{t('重试导入', 'Retry import')}</Button> : null}
        {item.state === 'uploading' ? <Button size="sm" onClick={() => void pause(item.id)}>{t('暂停', 'Pause')}</Button> : null}
        {item.state === 'paused' ? <Button size="sm" variant="primary" onClick={() => resume(item.id)}>{t('继续', 'Resume')}</Button> : null}
        {(['ready', 'checking', 'duplicate', 'uploading', 'paused', 'previewing', 'uploaded', 'submitted'].includes(item.state) || (item.state === 'error' && !item.job)) ? <Button size="sm" variant="quiet" onClick={() => void cancel(item.id)}>{t('取消', 'Cancel')}</Button> : null}
        {item.state === 'done' && item.dataset ? <Link className="press inline-flex h-7 items-center rounded-control bg-accent px-2.5 text-meta font-medium text-ink-inverse" to="/datasets/$resourceId" params={{ resourceId: item.dataset.id }}>{t('打开数据集', 'Open dataset')}</Link> : null}
        {item.dataset && ['submitted', 'done'].includes(item.state) ? <Button size="sm" variant="quiet" onClick={() => void previewImportResult(item)}>{t('查看已解析的首批数据', 'View first parsed rows')}</Button> : null}
        {item.job ? <Link className="press inline-flex h-7 items-center px-1 text-meta text-accent-ink hover:underline" to="/jobs">{t('查看任务', 'View jobs')}</Link> : null}
      </div>
      {item.importPreviewStage ? <p className="text-meta text-ink-3">{localizedStage(item.importPreviewStage)}{t('。', '. ')}{item.importPreview ? t('此处只显示开头样本，完整行数和字段类型仍以任务完成后的结果为准。', 'Only the beginning is shown here. The completed job determines full row counts and field types.') : t('稍后可再次读取。', 'Try reading it again later.')}</p> : null}
      {item.importPreviewError ? <Banner tone="danger">{item.importPreviewError}</Banner> : null}
      {item.importPreview ? <div className="max-h-72 overflow-auto rounded-control bg-surface-sunk"><table className="min-w-full text-left text-meta"><thead><tr>{item.importPreview.headers.map((name, index) => <th key={index} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={name}>{name}</th>)}</tr></thead><tbody>{item.importPreview.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-44 truncate border-b border-hairline-soft px-2 py-1" title={cell}>{cell}</td>)}</tr>)}</tbody></table>{item.importPreview.columnsTruncated ? <p className="p-2 text-meta text-ink-3">{t(`还有 ${item.importPreview.columnCount - item.importPreview.headers.length} 列未在样本中显示。`, `${item.importPreview.columnCount - item.importPreview.headers.length} more columns are hidden in the sample.`)}</p> : null}</div> : null}
    </Panel>)}</div>}
  </PageBody></>
}
