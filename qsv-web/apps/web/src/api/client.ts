import { localizedErrorMessage } from '@/lib/errors'

export interface Resource {
  id: string
  kind: 'raw' | 'dataset' | 'view' | 'report' | 'export'
  status: 'staging' | 'building' | 'ready' | 'failed' | 'trashed'
  name: string
  format: string
  groupId: string
  version: number
  sourceIds: string[]
  producerJobId: string | null
  contentHash: string | null
  byteSize: number | null
  rowCount: number | null
  columnCount: number | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  metadata: Record<string, unknown>
}

export interface Job {
  id: string
  kind: string
  name: string
  state: 'draft' | 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'succeeded' | 'failed' | 'interrupted'
  retryOf: string | null
  parentJobId?: string | null
  inputIds: string[]
  inputs?: { id: string; name: string | null; kind: Resource['kind'] | null;
    status: Resource['status'] | 'missing'; version: number | null }[]
  spec: Record<string, unknown>
  specHash: string
  engineVersion: string
  progress: { mode: string; percent: number | null; stage?: string;
    events?: { at: number; state: Job['state']; stage: string; errorCode: string | null }[]; eventsTruncated?: boolean }
  summary: { outputId?: string | null; rowsIn?: number | null; rowsOut?: number | null; scope?: string;
    preflight?: ComparePreflightResult }
  outputs?: Resource[]
  error: { code: string; message: string; retryable?: boolean } | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  updatedAt: number
}

export interface Recipe {
  id: string
  familyId: string
  version: number
  kind: 'pipeline' | 'compare' | 'validate' | 'sql' | 'transform'
  name: string
  description: string
  spec: { version: number; operation: string; [key: string]: unknown }
  compatibility: { inputCount?: number; engineVersion?: string; sourceJobId?: string }
  isCurrent: boolean
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
export interface RecipeBatch { batch: Job; recipeId: string; recipeVersion: number; parameterValues: Record<string, string>;
  groups: { index: number; sourceIds: string[]; submissionError: string | null;
  stepIndex: number; stepCount: number; outputs: Record<string, string>;
  selectedOutputs: { stepId: string; resourceId: string }[]; job: Job | null; history: Job[] }[] }
export interface RecipePreflight { ready: boolean; problems: string[]; checkedSteps: number; deferredSteps: number;
  sources: { id: string; hash: string | null; name: string | null }[]; recipeVersion: number; engineVersion: string }
export interface RecipeTrial { ready: boolean; recipeVersion: number; engineVersion: string; sampledRows: number[]; scope: string;
  sources: { id: string; hash: string | null; name: string | null }[];
  steps: { id: string; operation: string; state: string; rowsIn: number | null; rowsOut: number | null;
    outputKind: string | null; error: string | null }[]; preview: CsvPreview | null; error: string | null }

export interface Schema {
  resourceId: string
  revision: string
  rowCount: number
  indexState: string
  columns: { id: string; name: string; originalName: string; type: string }[]
}

export interface RowBlock {
  viewId: string
  revision: string
  offset: number
  limit: number
  nextOffset: number
  columns: string[]
  rowIds: string[]
  sourceRowNumbers: number[]
  rows: (string | null)[][]
  totalRows: number
  totalKnown: boolean
  hasMore: boolean
  truncatedCells: { rowId: string; columnId: string; originalBytes: number }[]
}

export interface CellResult { viewId: string; revision: string; rowId: string; rowNumber: number; columnId: string; value: string; bytes: number }
export interface CellPatch { rowId: string; columnId: string; expectedOldValue: string; newValue: string }

export interface CsvImportOptions {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'
  delimiter: ',' | ';' | '\t' | '|'
  header: 'first-row' | 'none'
  quote: '"' | "'"
  headerRow: number
  dataStartRow: number
  dataEndRow: number | null
  skipEmptyLines: boolean
  invalidRows?: 'reject' | 'isolate'
  headerRowCount?: number
  headerJoin?: 'space' | 'slash' | 'underscore'
  headerFill?: boolean
}
export type ColumnType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date'
export type CleanStep =
  | { type: 'text'; columnId: string; mode: 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'nfc' | 'nfkc' | 'replace' | 'pattern'; find?: string; replacement?: string; enabled?: boolean }
  | { type: 'fill'; columnId: string; mode: 'fixed' | 'forward' | 'backward'; value?: string;
    scope?: 'all' | 'empty-text' | 'missing' | 'explicit-null'; enabled?: boolean }
  | { type: 'number'; columnId: string; decimals: number; rounding: 'half-up' | 'half-even' | 'truncate'; prefix?: string; suffix?: string; thousands?: boolean; invalid: 'keep' | 'isolate' | 'fail'; enabled?: boolean }
  | { type: 'date'; columnId: string; format: 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'iso-time' | 'iso-local-time'; outputOffset?: string;
    inputZone?: string; outputZone?: string;
    invalid: 'keep' | 'isolate' | 'fail'; enabled?: boolean }
  | { type: 'rename'; columnId: string; name: string; enabled?: boolean }
  | { type: 'columns'; columnIds: string[]; enabled?: boolean }
  | { type: 'add'; name: string; mode: 'constant' | 'sequence' | 'concat' | 'arithmetic'; value?: string; columnIds?: string[]; separator?: string; operator?: 'add' | 'subtract' | 'multiply'; enabled?: boolean }
  | { type: 'empty-row'; mode: 'report' | 'remove'; whitespace: 'literal' | 'trim'; enabled?: boolean }
  | { type: 'filter'; columnId: string; operator: 'equals' | 'not-equals' | 'contains' | 'is-empty' | 'not-empty'; value?: string; action: 'keep' | 'exclude'; enabled?: boolean }
  | { type: 'dedupe'; columnIds: string[]; keep: 'first' | 'last' | 'priority'; priorityColumnId?: string;
    priorityOrder?: 'asc' | 'desc'; priorityType?: 'text' | 'decimal'; emptyPriority?: 'first' | 'last'; enabled?: boolean }
export interface CleanPlan { steps: CleanStep[] }
export interface CleanPreview extends CsvPreview { scope: string; sampledRows: number; sourceRows: number | null;
  steps: { step: number; type: string; rowsIn: number; rowsOut: number; changed: number; errors: number;
    sampleErrors: { row: number; value: string; reason?: string }[]; duplicateGroups?: number; duplicateMembers?: number; emptyRows?: number }[] }
export interface SqlParameters { definitions: { name: string; type: 'text' | 'integer' | 'decimal' | 'date' }[];
  values: Record<string, string> }
export interface TextExportOptions { encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'; delimiter: ',' | ';' | '\t' | '|';
  quote: '"' | "'"; newline: 'lf' | 'crlf'; bom: boolean }
export interface JsonExportOptions { emptyAsNull: boolean; types: Record<string, 'text' | 'integer' | 'decimal' | 'boolean' | 'date'> }
export interface ExportScope { startRow: number; endRow: number; columnIds: string[] }
export interface ExportPreflight { ready: boolean; problem: string | null; rows: number; columns: number; scannedRows: number;
  sources: { id: string; name: string; hash: string; rows: number; columns: number }[]; notes: string[] }
export interface JsonImportOptions { nulls: 'reject' | 'empty'; missing: 'reject' | 'empty'; newFields?: 'reject' | 'ignore' | 'include'; projection?: string[];
  nested?: 'reject' | 'flatten' | 'stringify'; arrays?: 'reject' | 'stringify' | 'explode'; explodePath?: string; dataPath?: string;
  typeConflict?: 'text' | 'reject'; invalidRecords?: 'reject' | 'isolate' }
export interface CsvPreview { headers: string[]; rows: string[][]; sampleRows: number; totalKnown: false; columnCount: number; columnsTruncated: boolean; sampleRange?: string; sheetName?: string;
  sampleErrors?: { record: number; reason: string }[]
  sampleConversions?: { record: number; field: string; reason: string }[]
  parquetColumns?: { name: string; physical: string; logical: string | null; nullable: boolean }[] }
export interface SqlPreview extends CsvPreview { scope: string; sampledRows: number[]; sourceRows: (number | null)[]; resultLimit: number }
export interface WorkbookSheet { index: number; name: string; type: string; visible: string; rowCount: number | null; columnCount: number | null }
export interface CompareField { leftColumnId: string; rightColumnId: string; mode: 'text' | 'decimal' | 'calendar-date' | 'instant';
  tolerance?: string; relativeTolerance?: string; textTrim?: boolean; textIgnoreCase?: boolean; unicode?: 'none' | 'NFC' | 'NFKC';
  dayTolerance?: number; timeToleranceSeconds?: number; leftTimeZone?: string; rightTimeZone?: string }
export interface CompareConfig { leftKeyIds: string[]; rightKeyIds: string[]; fields: CompareField[]; trimKeys: boolean; ignoreKeyCase: boolean;
  leftLabel?: string; rightLabel?: string; duplicatePolicy?: 'isolate' | 'abort' | 'aggregate'; aggregateMethods?: ('sum' | 'count')[];
  emptyValuePolicy?: 'mode-default' | 'match-both' | 'error'; parseFailurePolicy?: 'isolate' | 'abort';
  contextLeftIds?: string[]; contextRightIds?: string[] }
export interface CompareSummary {
  leftRows: number; rightRows: number; equalPairs: number; differentPairs: number; pairErrors: number
  leftOnly: number; rightOnly: number; leftInvalid: number; rightInvalid: number
  leftConflict: number; rightConflict: number; conflictGroups: number; differentFields: number; detailRows: number
  leftAggregatedExtra?: number; rightAggregatedExtra?: number
}
export interface ComparePreflightResult {
  leftId: string; rightId: string; leftHash: string; rightHash: string; configHash: string; completedAt: number;
  leftKeys: CompareKeyInspection; rightKeys: CompareKeyInspection; summary: CompareSummary; wouldAbort: boolean;
  sample: { detailRow: number; category: string; key: string; field: string;
    leftValue: string; rightValue: string; reason: string }[]
}
export interface CompareKeyInspection { rows: number; emptyKeys: number; duplicateGroups: number; duplicateRows: number;
  normalizedCollisionGroups: number; samples: { key: string; rows: number[]; rawKeys: string[] }[] }
export interface UserSettings { defaultEncoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'; timezone: string;
  outputFormat: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'; safeText: boolean }
export interface AppLimits { fileBytes: number; workbookBytes: number; ownerQuotaBytes: number; globalQuotaBytes: number;
  minFreeBytes: number; maxActiveOwnerJobs: number; maxActiveGlobalJobs: number; maxOwnerUploads: number; maxGlobalUploads: number;
  maxOwnerResources: number; maxGlobalResources: number; taskTimeoutMinutes: number }
export interface StorageDetails { usedBytes: number; quotaBytes: number; globalQuotaBytes: number;
  categories: { kind: string; status: string; count: number; bytes: number }[];
  uploads: { bytes: number; complete: boolean }; temporaryJobs: { bytes: number; complete: boolean };
  previewCacheBytes: number; limits: AppLimits }
export interface CleanupItem { id: string; name: string; kind: string; updatedAt: number; estimatedBytes: number;
  estimateComplete: boolean; activeJobs: number; dependentResources: number; canPurge: boolean }
export interface CompareFilters { category?: string; key?: string; field?: string; fieldState?: string;
  value?: string; differenceMin?: string; differenceMax?: string; sourceRow?: number; annotationStatus?: string }
export interface CompareAnnotation { detailRow: number; status: 'pending' | 'verified' | 'ignored'; note: string; updatedAt: number }
export interface CompareDetail { detailRow: number; cells: string[]; annotation: CompareAnnotation | null }
export type QualityRule = { kind: 'required'; columnId: string } | { kind: 'length'; columnId: string; min: number; max: number } |
  { kind: 'enum'; columnId: string; values: string[] } | { kind: 'type'; columnId: string; dataType: 'integer' | 'decimal' | 'date' } |
  { kind: 'range'; columnId: string; min: string; max: string } | { kind: 'date-order'; columnId: string; otherColumnId: string } |
  { kind: 'pattern'; columnId: string; pattern: string } |
  { kind: 'arithmetic'; columnId: string; leftColumnId: string; rightColumnId: string; tolerance: string } |
  { kind: 'reference'; columnId: string; referenceId: string; referenceColumnId: string } |
  { kind: 'unique'; columnIds: string[] }
export interface QualitySummary { checkedRows: number; failedRows: number; violations: number; outputRows: number;
  ruleFailures: number[]; ruleSkipped: number[] }
export type SplitConfig = ({ mode: 'rows'; size: number } | { mode: 'value'; columnId: string }) & { includeHeader?: boolean }
export interface SplitManifest { version: 1; mode: 'rows' | 'value'; includeHeader?: boolean; sourceRows: number;
  files: { name: string; value: string | null; rows: number; bytes: number; sha256: string }[] }
export interface ViewCondition {
  columnId: string; operator: 'equals' | 'not-equals' | 'contains' | 'starts' | 'ends' | 'is-empty' | 'not-empty' | 'between' | 'in' | 'pattern';
  value?: string; other?: string; values?: string[] }
export interface ViewPlan { combine: 'and' | 'or'; conditions: ViewCondition[];
  sorts: { columnId: string; direction: 'asc' | 'desc'; empty: 'first' | 'last' }[];
  groups?: { combine: 'and' | 'or'; conditions: ViewCondition[] }[] }
export interface AggregateConfig { groupColumnIds: string[]; measures: { operation: 'count' | 'sum' | 'min' | 'max' | 'avg';
  columnId?: string; name: string; precision?: number }[] }
export interface PivotConfig { rowColumnId: string; pivotColumnId: string; measure: AggregateConfig['measures'][number] }
export interface RelationConfig { kind: 'inner' | 'left' | 'right' | 'full' | 'left-semi' | 'left-anti';
  leftKeyIds: string[]; rightKeyIds: string[]; cardinality: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
  keyType?: 'text' | 'decimal'; matchEmptyKeys?: boolean; trimKeys?: boolean; ignoreCase?: boolean; unicodeNormalization?: 'none' | 'nfc' | 'nfkc';
  output?: { columns: { side: 'left' | 'right'; id: string }[]; leftSuffix: string; rightSuffix: string; includeSourceRows: boolean } }
export interface SetConfig { kind: 'intersection' | 'left-difference' | 'right-difference' | 'union';
  leftKeyIds: string[]; rightKeyIds: string[] }
export type ReshapeConfig =
  | { kind: 'split-column'; columnId: string; delimiter: string; direction: 'columns' | 'rows'; maxParts: number;
      keepEmpty: boolean; overflow: 'error' | 'join-last' }
  | { kind: 'group-join'; keyIds: string[]; valueId: string; separator: string }
  | { kind: 'transpose' }

export interface Page<T> { items: T[]; total: number }
export interface CursorPage<T> extends Page<T> { nextCursor: string | null }
export interface ResourceDependencies {
  activeJobs: { id: string; name: string; state: string }[]
  derivedResources: { id: string; name: string; kind: string; status: string }[]
}
export interface ResourceFilters { name?: string; format?: string; kind?: string; status?: string; from?: number; to?: number }
export interface JobFilters { name?: string; kind?: string; state?: string; inputId?: string; from?: number; to?: number }

function filterUrl(path: string, filters: object, offset: number, limit: number) {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value))
  return `${path}?${params}`
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(localizedErrorMessage(code, message))
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.method && init.method !== 'GET') headers.set('x-qsv-request', '1')
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const result = await response.json() as T & { error?: { code: string; message: string } }
  if (!response.ok) throw new ApiError(result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? '请求失败', response.status)
  return result
}

function attachmentFilename(disposition: string | null): string | undefined {
  if (!disposition) return undefined
  const extended = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)
  if (extended) {
    try { return decodeURIComponent(extended[1].replace(/^"|"$/g, '')) || undefined } catch { return undefined }
  }
  return /filename="?([^";]+)"?/.exec(disposition)?.[1] || undefined
}

async function downloadFromUrl(url: string, fallbackName: string) {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new ApiError('REQUEST_FAILED', '下载失败', response.status)
  const blob = await response.blob()
  const blobUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = attachmentFilename(response.headers.get('content-disposition')) ?? fallbackName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000)
}

export const api = {
  session: async () => (await call<{ user: { name: string; workspaceId: string; role: 'admin' | 'normal' }; source: string }>('/api/v1/session')),
  logout: async () => call<{ signedOut: boolean }>('/api/v1/logout', { method: 'POST' }),
  overview: async () => call<{ resources: number; jobs: number; running: number; queued: number; needsAttention: number; attentionJobs: Job[] }>('/api/v1/overview'),
  storage: async () => call<{ usedBytes: number; quotaBytes: number }>('/api/v1/storage'),
  storageDetails: async () => call<StorageDetails>('/api/v1/storage/details'),
  clearPreviewCache: async () => call<{ freedBytes: number; resourceFilesDeleted: number }>('/api/v1/storage/clear-cache', { method: 'POST' }),
  cleanupPreview: async () => call<{ items: CleanupItem[]; total: number; note: string }>('/api/v1/storage/cleanup-preview'),
  purgeTrashedResource: async (id: string, expectedUpdatedAt: number) => call<{ id: string; freedBytes: number;
    pendingFileCleanup: boolean; resourceFilesDeleted: number }>(`/api/v1/storage/trash/${encodeURIComponent(id)}/permanent`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt }),
    }),
  settings: async () => call<{ settings: UserSettings; updatedAt: number | null }>('/api/v1/settings'),
  appLimits: async () => call<{ limits: AppLimits; updatedAt: number | null; canEdit: boolean }>('/api/v1/admin/limits'),
  saveAppLimits: async (limits: AppLimits, expectedUpdatedAt: number | null) => call<{ limits: AppLimits; updatedAt: number | null; canEdit: boolean }>('/api/v1/admin/limits', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limits, expectedUpdatedAt }),
  }),
  saveSettings: async (settings: UserSettings, expectedUpdatedAt: number | null) =>
    call<{ settings: UserSettings; updatedAt: number }>('/api/v1/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings, expectedUpdatedAt }),
    }),
  capabilities: async () => (await call<{ app: { version: string; license: string; mode: 'local' | 'lazycat'; importFormats: string[]; exportFormats: string[] };
    engine: { version: string | null; sha256: string | null; platform: string | null; verified: boolean; reason: string | null };
    operations: Record<string, unknown> }>('/api/v1/capabilities')),
  search: async (query: string) => call<{ resources: Resource[]; jobs: Job[] }>(`/api/v1/search?q=${encodeURIComponent(query)}`),
  importOrdersExample: async () => call<{ job: Job; resource: Resource }>('/api/v1/examples/orders/import', { method: 'POST' }),
  resources: async () => (await call<Page<Resource>>('/api/v1/resources')).items,
  resourcePage: async (offset = 0, limit = 50) => call<Page<Resource>>(`/api/v1/resources?offset=${offset}&limit=${limit}`),
  matchingRawUploads: async (sha256: string, bytes: number, format: string) => (await call<{ items: Resource[] }>(`/api/v1/uploads/matches?sha256=${encodeURIComponent(sha256)}&bytes=${bytes}&format=${encodeURIComponent(format)}`)).items,
  findResources: async (filters: ResourceFilters, offset = 0, limit = 50) =>
    call<Page<Resource>>(filterUrl('/api/v1/resources/find', filters, offset, limit)),
  resourceCursorPage: async (cursor = '', limit = 50) => call<CursorPage<Resource>>(`/api/v1/resources?cursor=${encodeURIComponent(cursor)}&limit=${limit}`),
  resource: async (id: string) => (await call<{ resource: Resource }>(`/api/v1/resources/${encodeURIComponent(id)}`)).resource,
  resourceVersions: async (id: string) => (await call<{ versions: Resource[] }>(`/api/v1/resources/${encodeURIComponent(id)}/versions`)).versions,
  editCells: async (id: string, expectedRevision: string, patches: CellPatch[], key: string) =>
    call<{ job: Job; resource: Resource }>(`/api/v1/resources/${encodeURIComponent(id)}/edits`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ expectedRevision, patches }),
    }),
  trash: async (offset = 0, limit = 50) => call<Page<Resource>>(`/api/v1/trash?offset=${offset}&limit=${limit}`),
  resourceDependencies: async (id: string) => call<ResourceDependencies>(`/api/v1/resources/${encodeURIComponent(id)}/dependencies`),
  trashResource: async (id: string, expectedUpdatedAt: number) =>
    (await call<{ resource: Resource }>(`/api/v1/resources/${encodeURIComponent(id)}/trash`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt }),
    })).resource,
  restoreResource: async (id: string, expectedUpdatedAt: number) =>
    (await call<{ resource: Resource }>(`/api/v1/resources/${encodeURIComponent(id)}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt }),
    })).resource,
  updateResource: async (id: string, name: string, description: string, expectedUpdatedAt: number) =>
    (await call<{ resource: Resource }>(`/api/v1/resources/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, description, expectedUpdatedAt }),
    })).resource,
  schema: async (id: string) => (await call<{ schema: Schema }>(`/api/v1/resources/${encodeURIComponent(id)}/schema`)).schema,
  previewRawCsv: async (id: string, csv: CsvImportOptions) => (await call<{ preview: CsvPreview }>(`/api/v1/resources/${encodeURIComponent(id)}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv }),
  })).preview,
  previewRawJson: async (id: string, json: JsonImportOptions) => (await call<{ preview: CsvPreview }>(`/api/v1/resources/${encodeURIComponent(id)}/json-preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json }),
  })).preview,
  previewRawParquet: async (id: string) => (await call<{ preview: CsvPreview }>(`/api/v1/resources/${encodeURIComponent(id)}/parquet-preview`)).preview,
  previewImportResult: async (id: string) => (await call<{ result: { available: false; stage: string } | { available: true; stage: string; preview: CsvPreview } }>(
    `/api/v1/resources/${encodeURIComponent(id)}/import-preview`)).result,
  workbookSheets: async (id: string) => (await call<{ sheets: WorkbookSheet[] }>(`/api/v1/resources/${encodeURIComponent(id)}/sheets`)).sheets,
  previewWorkbookSheet: async (id: string, sheetName: string, csv?: CsvImportOptions) => (await call<{ preview: CsvPreview }>(`/api/v1/resources/${encodeURIComponent(id)}/sheets/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sheetName, csv }),
  })).preview,
  jobs: async () => (await call<Page<Job>>('/api/v1/jobs')).items,
  jobPage: async (offset = 0, limit = 50) => call<Page<Job>>(`/api/v1/jobs?offset=${offset}&limit=${limit}`),
  findJobs: async (filters: JobFilters, offset = 0, limit = 50) =>
    call<Page<Job>>(filterUrl('/api/v1/jobs/find', filters, offset, limit)),
  jobCursorPage: async (cursor = '', limit = 50) => call<CursorPage<Job>>(`/api/v1/jobs?cursor=${encodeURIComponent(cursor)}&limit=${limit}`),
  job: async (id: string) => (await call<{ job: Job }>(`/api/v1/jobs/${encodeURIComponent(id)}`)).job,
  upload: async (file: File, key: string) => (await call<{ resource: Resource }>('/api/v1/uploads', {
    method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name), 'idempotency-key': key }, body: file,
  })).resource,
  uploadByKey: async (key: string) => (await call<{ resource: Resource }>(`/api/v1/uploads/by-key/${encodeURIComponent(key)}`)).resource,
  commitTus: async (id: string, key: string) => (await call<{ resource: Resource }>(`/api/v1/tus/${encodeURIComponent(id)}/commit`, {
    method: 'POST', headers: { 'idempotency-key': key },
  })).resource,
  import: async (rawResourceId: string, key: string, csv?: CsvImportOptions, sheetName?: string, json?: JsonImportOptions,
    columnTypes?: Record<string, ColumnType>) => call<{ job: Job; resource: Resource }>('/api/v1/imports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ rawResourceId, csv, sheetName, json, columnTypes }),
  }),
  filter: async (sourceId: string, columnId: string, mode: 'equals' | 'contains', value: string, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/filters', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, columnId, mode, value }),
  }),
  filterPlan: async (sourceId: string, plan: ViewPlan, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/filter-plans', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, plan }),
  }),
  clean: async (sourceId: string, columnId: string, mode: 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'replace' | 'fill-empty' | 'nfc' | 'nfkc' | 'date-iso', key: string, find = '', replacement = '', dateFormat: 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy' = 'yyyy-MM-dd') => call<{ job: Job; resource: Resource }>('/api/v1/cleans', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, columnId, mode, find, replacement, dateFormat }),
  }),
  cleanPlan: async (sourceId: string, plan: CleanPlan, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/clean-plans', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, plan }),
  }),
  previewCleanPlan: async (sourceId: string, plan: CleanPlan) => (await call<{ preview: CleanPreview }>('/api/v1/clean-plans/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId, plan }),
  })).preview,
  export: async (sourceId: string, format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet', safeText: boolean, key: string,
    textOptions?: TextExportOptions, jsonOptions?: JsonExportOptions, workbook?: { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number }, scope?: ExportScope,
    outputName?: string) => call<{ job: Job; resource: Resource }>('/api/v1/exports', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, format, safeText, textOptions, jsonOptions, workbook, scope, outputName }),
  }),
  exportPreflight: async (sourceId: string, format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet', safeText: boolean,
    textOptions?: TextExportOptions, jsonOptions?: JsonExportOptions, workbook?: { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number }, scope?: ExportScope) =>
    (await call<{ preflight: ExportPreflight }>('/api/v1/exports/preflight', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId, format, safeText, textOptions, jsonOptions, workbook, scope }),
    })).preflight,
  combine: async (sourceIds: string[], mode: 'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error' | 'relation' | 'set', key: string, relationConfig?: RelationConfig, setConfig?: SetConfig) => call<{ job: Job; resource: Resource }>('/api/v1/combines', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceIds, mode, relationConfig, setConfig }),
  }),
  relationPreflight: async (sourceIds: string[], config: RelationConfig) => (await call<{ preflight: {
    expectedRows: number; matchedPairs: number; unmatchedLeft: number; unmatchedRight: number; leftWidth: number; rightWidth: number;
    sample: { scope: string; leftSampleRows: number; rightSampleRows: number; headers: string[]; rows: string[][];
      sampleRows: number; columnCount: number; columnsTruncated: boolean; totalKnown: false } | null; sampleWarning: string | null } }>('/api/v1/relations/preflight', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceIds, config }),
  })).preflight,
  reshape: async (sourceId: string, config: ReshapeConfig, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/reshapes', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, config }),
  }),
  dedupe: async (sourceId: string, columnIds: string[], key: string) => call<{ job: Job; resource: Resource }>('/api/v1/dedupes', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, columnIds }),
  }),
  comparePreflight: async (leftId: string, rightId: string, config: CompareConfig, key: string) => call<{ job: Job }>('/api/v1/compares/preflights', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ leftId, rightId, config }),
  }),
  compare: async (leftId: string, rightId: string, config: CompareConfig, preflightJobId: string, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/compares', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ leftId, rightId, config, preflightJobId }),
  }),
  compareDetails: async (id: string, filters: CompareFilters, offset: number, limit = 100) =>
    call<Page<CompareDetail>>(filterUrl(`/api/v1/compare-results/${encodeURIComponent(id)}/find`, filters, offset, limit)),
  compareAnnotations: async (id: string, offset: number, limit = 100) =>
    call<{ items: CompareAnnotation[] }>(`/api/v1/compare-results/${encodeURIComponent(id)}/annotations?offset=${offset}&limit=${limit}`),
  setCompareAnnotations: async (id: string, edits: { detailRow: number; status: CompareAnnotation['status'] | null;
    note: string; expectedUpdatedAt: number | null }[]) => call<{ items: CompareAnnotation[] }>(`/api/v1/compare-results/${encodeURIComponent(id)}/annotations`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ edits }),
    }),
  compareReport: async (id: string, format: 'zip' | 'xlsx', key: string) =>
    call<{ job: Job; resource: Resource }>(`/api/v1/compare-results/${encodeURIComponent(id)}/reports`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ format }),
    }),
  sql: async (sourceIds: string[], sql: string, key: string, parameters?: SqlParameters) => call<{ job: Job; resource: Resource }>('/api/v1/sql-queries', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceIds, sql, parameters }),
  }),
  previewSql: async (sourceIds: string[], sql: string, parameters?: SqlParameters) =>
    (await call<{ preview: SqlPreview }>('/api/v1/sql-queries/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceIds, sql, parameters }),
    })).preview,
  analyze: async (sourceId: string, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/analyses', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId }),
  }),
  frequencyAnalyze: async (sourceId: string, columnId: string, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/analyses/frequencies', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ sourceId, columnId }),
  }),
  groupAnalyze: async (sourceId: string, aggregate: AggregateConfig, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/analyses/groups', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, aggregate }),
  }),
  pivotAnalyze: async (sourceId: string, pivot: PivotConfig, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/analyses/pivots', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, pivot }),
  }),
  quality: async (sourceId: string, rules: QualityRule[], key: string, outputMode: 'report' | 'valid' | 'invalid' = 'report') => call<{ job: Job; resource: Resource }>('/api/v1/quality-checks', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, rules, outputMode }),
  }),
  qualityPreview: async (sourceId: string, rules: QualityRule[]) => (await call<{ preview: {
    summary: { checkedRows: number; failedRows: number; violations: number; ruleFailures: number[]; ruleSkipped: number[] };
    preview: CsvPreview; sampledRows: number; scope: string } }>('/api/v1/quality-checks/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId, rules }),
  })).preview,
  split: async (sourceId: string, config: SplitConfig, key: string) => call<{ job: Job; resource: Resource }>('/api/v1/splits', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceId, config }),
  }),
  splitPreflight: async (sourceId: string, config: SplitConfig) => (await call<{ preflight: {
    fileCount: number; sourceRows: number; sourceHash: string; exact: boolean } }>('/api/v1/splits/preflight', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId, config }),
  })).preflight,
  splitManifest: async (id: string) => (await call<{ manifest: SplitManifest }>(`/api/v1/split-results/${encodeURIComponent(id)}/manifest`)).manifest,
  splitFileUrl: (id: string, name: string) => `/api/v1/split-results/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`,
  recipes: async () => (await call<{ items: Recipe[] }>('/api/v1/recipes')).items,
  recipe: async (id: string) => (await call<{ recipe: Recipe }>(`/api/v1/recipes/${encodeURIComponent(id)}`)).recipe,
  recipeVersions: async (id: string) => (await call<{ items: Recipe[] }>(`/api/v1/recipes/${encodeURIComponent(id)}/versions`)).items,
  recipePreflight: async (id: string, sourceIds: string[], parameterValues: Record<string, string> = {}) => (await call<{ preflight: RecipePreflight }>(`/api/v1/recipes/${encodeURIComponent(id)}/preflight`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceIds, parameterValues }),
  })).preflight,
  recipeTrial: async (id: string, sourceIds: string[], parameterValues: Record<string, string> = {}) => (await call<{ trial: RecipeTrial }>(
    `/api/v1/recipes/${encodeURIComponent(id)}/trial`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceIds, parameterValues }) })).trial,
  recipeFromJob: async (jobId: string, name: string, description: string, includeHistory: boolean) => (await call<{ recipe: Recipe }>('/api/v1/recipes/from-job', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, name, description, includeHistory }),
  })).recipe,
  importRecipe: async (payload: { format: 'qsv-recipe-v1'; name: string; description: string; spec: unknown }) =>
    (await call<{ recipe: Recipe }>('/api/v1/recipes/import', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload) })).recipe,
  versionRecipe: async (id: string, name: string, description: string, expectedUpdatedAt: number, spec?: unknown) => (await call<{ recipe: Recipe }>(`/api/v1/recipes/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, description, expectedUpdatedAt, spec }),
  })).recipe,
  copyRecipe: async (id: string, name: string) => (await call<{ recipe: Recipe }>(`/api/v1/recipes/${encodeURIComponent(id)}/copy`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  })).recipe,
  deleteRecipe: async (id: string, expectedUpdatedAt: number) => call<{ deleted: boolean }>(`/api/v1/recipes/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt }),
  }),
  runRecipeBatch: async (id: string, groups: string[][], key: string, parameterValues: Record<string, string> = {}) => call<RecipeBatch>(`/api/v1/recipes/${encodeURIComponent(id)}/batches`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ groups, parameterValues }),
  }),
  recipeBatch: async (id: string) => call<RecipeBatch>(`/api/v1/recipe-batches/${encodeURIComponent(id)}`),
  retryRecipeBatchGroup: async (id: string, index: number, sourceIds: string[], key: string) => call<RecipeBatch>(`/api/v1/recipe-batches/${encodeURIComponent(id)}/groups/${index}/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ sourceIds }),
  }),
  cancel: async (id: string) => (await call<{ job: Job }>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })).job,
  retry: async (id: string, key: string) => call<{ job: Job; resource: Resource }>(`/api/v1/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST', headers: { 'idempotency-key': key },
  }),
  createView: async (resourceId: string) => (await call<{ view: { id: string; resourceId: string; revision: string } }>('/api/v1/views', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceId }),
  })).view,
  rows: async (viewId: string, offset: number, limit: number, signal?: AbortSignal) => (await call<{ block: RowBlock }>(`/api/v1/views/${encodeURIComponent(viewId)}/rows?offset=${offset}&limit=${limit}`, { signal })).block,
  cell: async (viewId: string, rowIndex: number, columnId: string, signal?: AbortSignal) => (await call<{ cell: CellResult }>(`/api/v1/views/${encodeURIComponent(viewId)}/cells/${rowIndex}/${encodeURIComponent(columnId)}`, { signal })).cell,
  downloadUrl: (id: string) => `/api/v1/resources/${encodeURIComponent(id)}/download`,
  downloadResource: async (id: string, fallbackName: string) => downloadFromUrl(api.downloadUrl(id), fallbackName),
  downloadFromUrl: (url: string, fallbackName: string) => downloadFromUrl(url, fallbackName),
  cleanReportUrl: (id: string, step: number, kind: 'errors' | 'duplicates' | 'empty-rows') => `/api/v1/resources/${encodeURIComponent(id)}/clean-reports/${step}/${kind}`,
  relationReportUrl: (id: string, side: 'left' | 'right') => `/api/v1/resources/${encodeURIComponent(id)}/relation-reports/${side}`,
  jsonImportReportUrl: (id: string) => `/api/v1/resources/${encodeURIComponent(id)}/json-import-report`,
  jsonConversionReportUrl: (id: string) => `/api/v1/resources/${encodeURIComponent(id)}/json-conversion-report`,
  csvImportReportUrl: (id: string) => `/api/v1/resources/${encodeURIComponent(id)}/csv-import-report`,
}
