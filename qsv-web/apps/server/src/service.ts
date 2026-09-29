import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, statfsSync, type Dirent } from 'node:fs'
import { link, lstat, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse/sync'
import { parse as parseCsvStream } from 'csv-parse'
import { CsvValidationError, csvImportOptions, isDefaultCsvOptions, inspectCsv, normalizeCsvToFile, previewCsv, type CsvImportOptions } from './csv.ts'
import { ensureDurableDirectory, isCommit, readCommit, syncDirectory, syncFile, verifyCommit, writeCommit } from './commit.ts'
import { WebDatabase, type CompareAnnotationRow, type JobRow, type RecipeRow, type ResourceRow } from './database.ts'
import { ORDERS_EXAMPLE_HASH, ORDERS_EXAMPLE_UPLOAD_KEY } from './example.ts'
import { UploadLimitError, UploadValidationError, checkedResourcePath, digestFile, receiveUpload, resourceRelpath, uploadFormat, uploadSizeLimit, validateUploadName } from './files.ts'
import type { Identity } from './identity.ts'
import { QsvCommandError, QsvOutputLimitError, runQsv } from './qsv.ts'
import { ExportConfigError, inspectJsonExport, inspectTextExport, validateJsonExportOptions, validateTextExportOptions, writeJsonExport, writeTextExport,
  type JsonExportOptions, type TextExportOptions } from './export.ts'
import { DateValidationError, normalizeColumn, normalizeDateColumn, validIanaTimeZone, type DateInputFormat } from './transform.ts'
import { keepFirstPerKey } from './dedupe.ts'
import { CompareError, compareSortedInputs, inspectSortedKeys, prepareCompareInput, type CompareConfig, type CompareSummary } from './compare.ts'
import { SqlValidationError, validateReadOnlySql } from './sql.ts'
import { validDecimalRange, validTolerance, writeQualityReport, type QualityOutputMode, type QualityRule } from './quality.ts'
import { JsonImportError, jsonImportOptions, normalizeJsonToFile, previewJson, type JsonImportOptions } from './json-import.ts'
import { applyCleanPlanParameters, bindRecipe, cleanPlanParameterNames, recipeFromJob, recipeInputCount, RecipeValidationError, validateRecipeSpec,
  type BoundRecipe, type PipelineRecipeSpec, type RecipeRef, type RecipeSpec, type SingleRecipeSpec } from './recipe.ts'
import { SplitError, countSplitFiles, writeSplitFiles, writeSplitZip, type SplitConfig, type SplitManifest } from './split.ts'
import { writeHorizontalConcat } from './horizontal.ts'
import { validateViewPlan, ViewPlanError, writeFilteredSortedCsv, type ViewPlan } from './view-operation.ts'
import { AggregateError, validateAggregateConfig, writeGroupedAggregate, type AggregateConfig } from './aggregate.ts'
import { prepareRelation, projectRelationOutput, relationCellStates, sampleRelation, RelationError, validateRelationConfig, type RelationConfig } from './relation.ts'
import { SetOperationError, validateSetConfig, writeSetOperation, type SetConfig } from './set-operation.ts'
import { ReshapeError, reshapeCellStates, validateReshapeConfig, writeReshapedCsv, type ReshapeConfig } from './reshape.ts'
import { validSafePattern } from './safe-pattern.ts'
import { PivotError, validatePivotConfig, writePivot, type PivotConfig } from './pivot.ts'
import { CompareReportError, writeCompareReport } from './compare-report.ts'
import { readSqlPreview, SqlPreviewError, writeSqlInputSample } from './sql-preview.ts'
import { DEFAULT_SETTINGS, SettingsError, validateUserSettings, type UserSettings } from './settings.ts'
import { CleanPlanError, validateCleanPlan, writeCleanPlan, type CleanPlan } from './clean-plan.ts'
import { bindSqlParameters, SqlParameterError, type SqlParameters } from './sql-parameters.ts'
import { CellEditError, validateCellPatches, writeCellEdits, type CellPatch } from './cell-edit.ts'
import { ExportScopeError, scanWorkbookCells, validateExportScope, writeExportScope, type ExportScope } from './export-scope.ts'
import { columnTypes, ColumnTypeError, derivedColumnTypes, validateColumnTypes, type ColumnType } from './column-types.ts'
import { ParquetSchemaError, readFlatParquetSchema } from './parquet-schema.ts'
import { FrequencyError, writeFrequencyTop } from './frequency.ts'
import { appendCellStateCountsToStats, CellStateLineageError, copyCellStatesForEdits, horizontalCellStates, mapCellStates, mergeCellStates } from './cell-state-lineage.ts'
import { DEFAULT_APP_LIMITS, LimitsError, validateAppLimits, type AppLimits } from './limits.ts'

const ROW_BLOCK_BYTES = 2 * 1024 * 1024
const SOURCE_BLOCK_BYTES = 10 * 1024 * 1024
const ROW_CACHE_BYTES = 128 * 1024 * 1024
const MAX_CELL_PREVIEW_BYTES = 4096
const MAX_ROWS = 512
const MAX_ACTIVE_ROW_READS = 4
const MAX_METADATA_BYTES = 64 * 1024
const MAX_OWNER_RAW_PER_HOUR = 120
const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
type ExportWorkbook = { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number }

function exportSheetNames(workbook: ExportWorkbook, rows: number) {
  if (!workbook.rowsPerSheet) return workbook.sheetNames
  const count = Math.max(1, Math.ceil(rows / workbook.rowsPerSheet))
  if (count === 1) return workbook.sheetNames
  const base = workbook.sheetNames[0]!
  return Array.from({ length: count }, (_, index) => {
    const suffix = ` ${index + 1}`
    return `${base.slice(0, 31 - suffix.length)}${suffix}`
  })
}

export class ServiceError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function hash(value: string) { return createHash('sha256').update(value).digest('hex') }
function frequencyScratchLimit(sourceBytes: number) {
  return Math.min(1024 * 1024 * 1024, Math.max(64 * 1024 * 1024, Math.ceil(sourceBytes * 4)))
}
function parseCursor(value: string, kind: 'res' | 'job') {
  if (value === '') return null
  const match = /^(\d+)\.(res|job)_[0-9a-f-]{36}$/.exec(value)
  const createdAt = Number(match?.[1])
  if (!match || match[2] !== kind || !Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new ServiceError(400, 'INVALID_CURSOR', '翻页位置无效')
  }
  return { createdAt, id: value.slice(match[1].length + 1) }
}
function cursorFor(row: { created_at: number; id: string }) { return `${row.created_at}.${row.id}` }
function metadata(row: ResourceRow) { return JSON.parse(row.metadata_json) as Record<string, unknown> }
function hasScopedFill(plan: CleanPlan) {
  return plan.steps.some((step) => step.enabled !== false && step.type === 'fill' && step.scope && step.scope !== 'all')
}

async function directoryUsage(root: string, maxEntries = 10_000) {
  const pending = [root]
  let bytes = 0
  let entries = 0
  while (pending.length) {
    const directory = pending.pop()!
    let items: Dirent[]
    try { items = await readdir(directory, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    for (const item of items) {
      entries += 1
      if (entries > maxEntries) return { bytes, complete: false }
      const path = join(directory, item.name)
      if (item.isDirectory()) pending.push(path)
      else if (item.isFile()) bytes += (await lstat(path)).size
    }
  }
  return { bytes, complete: true }
}

interface RowBlock {
  viewId: string; revision: string | null; offset: number; limit: number; nextOffset: number
  columns: string[]; rowIds: string[]; sourceRowNumbers: number[]; rows: (string | null)[][]
  totalRows: number | null; totalKnown: boolean; hasMore: boolean
  truncatedCells: { rowId: string; columnId: string; originalBytes: number }[]
}

function previewValue(value: string, maxBytes: number) {
  const full = Buffer.from(value, 'utf8')
  if (full.length <= maxBytes) return { value, truncated: false, originalBytes: full.length }
  let end = maxBytes
  while (end > 0 && (full[end]! & 0xc0) === 0x80) end -= 1
  return { value: `${full.subarray(0, end).toString('utf8')}…`, truncated: true, originalBytes: full.length }
}

function resourceDto(row: ResourceRow) {
  return {
    id: row.id, kind: row.kind, status: row.status, name: row.name, format: row.format,
    groupId: row.group_id, version: row.version, sourceIds: JSON.parse(row.source_ids_json) as string[],
    producerJobId: row.producer_job_id, contentHash: row.content_hash, byteSize: row.byte_size,
    rowCount: row.row_count, columnCount: row.column_count, createdAt: row.created_at,
    updatedAt: row.updated_at, deletedAt: row.deleted_at, metadata: metadata(row),
  }
}

function jobDto(row: JobRow) {
  return {
    id: row.id, kind: row.kind, name: row.name, state: row.state, retryOf: row.retry_of, parentJobId: row.parent_job_id ?? null,
    inputIds: JSON.parse(row.input_ids_json) as string[], spec: JSON.parse(row.spec_json) as unknown,
    specHash: row.spec_hash, engineVersion: row.engine_version,
    progress: JSON.parse(row.progress_json) as unknown, summary: JSON.parse(row.summary_json) as unknown,
    error: row.error_json ? JSON.parse(row.error_json) as { code: string; message: string; retryable: boolean } : null,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at,
  }
}

function recipeDto(row: RecipeRow) {
  return { id: row.id, familyId: row.family_id, version: row.version, kind: row.kind, name: row.name,
    description: row.description, spec: JSON.parse(row.spec_json) as RecipeSpec,
    compatibility: JSON.parse(row.compatibility_json) as unknown,
    isCurrent: row.is_current === 1, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }
}

interface RecipeBatchGroup {
  index: number
  sourceIds: string[]
  childJobId: string | null
  submissionError: string | null
  stepIndex: number
  outputs: Record<string, string>
  attempt: number
  lastRetryKey: string | null
  historyJobIds: string[]
}

export interface ResourceFilters { name?: string; format?: string; kind?: string; status?: string; from?: number; to?: number }
export interface JobFilters { name?: string; kind?: string; state?: string; inputId?: string; from?: number; to?: number }

function validRange(from?: number, to?: number) {
  if ((from !== undefined && (!Number.isSafeInteger(from) || from < 0)) ||
    (to !== undefined && (!Number.isSafeInteger(to) || to < 0)) ||
    (from !== undefined && to !== undefined && from > to)) {
    throw new ServiceError(400, 'INVALID_DATE_RANGE', '时间范围无效')
  }
}

function decimalMagnitude(value: string) {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value)
  if (!match || match[1]!.length + (match[2]?.length ?? 0) > 40 || (match[2]?.length ?? 0) > 18) return null
  const fraction = match[2] ?? ''
  return { coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length }
}

function compareMagnitudes(left: NonNullable<ReturnType<typeof decimalMagnitude>>,
  right: NonNullable<ReturnType<typeof decimalMagnitude>>) {
  const scale = Math.max(left.scale, right.scale)
  const a = left.coefficient * 10n ** BigInt(scale - left.scale)
  const b = right.coefficient * 10n ** BigInt(scale - right.scale)
  return a < b ? -1 : a > b ? 1 : 0
}

export class WorkbenchService {
  readonly db: WebDatabase
  readonly dataDir: string
  readonly binary: string
  readonly engineVersion: string
  private readonly trialMode: boolean
  private limits: AppLimits
  private readonly pending: { owner: Identity; jobId: string; datasetId: string; reservedBytes: number }[] = []
  private readonly running = new Map<string, AbortController>()
  private draining = false
  private activeRowReads = 0
  private activeCompareReads = 0
  private activeSqlPreviews = 0
  private activeCleanPreviews = 0
  private activeRecipeTrials = 0
  private activeExportPreflights = 0
  private activeSplitPreflights = 0
  private reservedGlobal = 0
  private readonly reservedByOwner = new Map<string, number>()
  private readonly reservedResourceByOwner = new Map<string, number>()
  private reservedResourcesGlobal = 0
  private readonly activeUploads = new Set<Readable>()
  private readonly activeTusCommits = new Set<Promise<unknown>>()
  private readonly rowCache = new Map<string, { block: RowBlock; bytes: number }>()
  private readonly recipeTrials = new Map<string, { expiresAt: number; version: number; sourceHashes: (string | null)[] }>()
  private rowCacheSize = 0
  private readonly uploadIdleWaiters: Array<() => void> = []
  private drainTask: Promise<void> | null = null
  private stopping = false

  constructor(db: WebDatabase, dataDir: string, binary: string, engineVersion: string, trialMode = false) {
    this.db = db
    this.dataDir = dataDir
    this.binary = binary
    this.engineVersion = engineVersion
    this.trialMode = trialMode
    this.limits = validateAppLimits(JSON.parse(db.getAppLimits()?.limits_json ?? JSON.stringify(DEFAULT_APP_LIMITS)) as unknown)
  }

  appLimits(owner: Identity) { return { limits: this.limits, updatedAt: this.db.getAppLimits()?.updated_at ?? null,
    canEdit: owner.role === 'admin' } }

  saveAppLimits(owner: Identity, requested: unknown, expectedUpdatedAt: number | null) {
    if (owner.role !== 'admin') throw new ServiceError(403, 'ADMIN_REQUIRED', '只有管理员可以调整保护上限')
    let limits: AppLimits
    try { limits = validateAppLimits(requested) }
    catch (error) { throw new ServiceError(422, 'INVALID_LIMITS', error instanceof LimitsError ? error.message : '保护上限无效') }
    const saved = this.db.setAppLimits(JSON.stringify(limits), expectedUpdatedAt)
    if (!saved) throw new ServiceError(409, 'LIMITS_CHANGED', '保护上限已在其他位置修改，请刷新后重试')
    this.limits = limits
    return { limits, updatedAt: saved.updated_at, canEdit: true }
  }

  uploadLimit(name: string) {
    return Math.min(uploadSizeLimit(name), ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(uploadFormat(name))
      ? this.limits.workbookBytes : this.limits.fileBytes)
  }

  uploadConcurrency() { return { owner: this.limits.maxOwnerUploads, global: this.limits.maxGlobalUploads } }

  listResources(owner: Identity, offset = 0, limit = 50) { return { items: this.db.listResources(owner.ownerKey, limit, offset).map(resourceDto), total: this.db.countResources(owner.ownerKey) } }
  matchingRawUploads(owner: Identity, sha256: string, byteSize: number, format: string) {
    if (!/^[0-9a-f]{64}$/u.test(sha256) || !Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > 5 * 1024 * 1024 * 1024 ||
      !['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'json', 'jsonl', 'ndjson', 'parquet'].includes(format)) {
      throw new ServiceError(400, 'INVALID_DIGEST_QUERY', '文件摘要或大小无效')
    }
    return this.db.findReadyRawByDigest(owner.ownerKey, `sha256:${sha256}`, byteSize, format).map(resourceDto)
  }
  listJobs(owner: Identity, offset = 0, limit = 50) { return { items: this.db.listJobs(owner.ownerKey, limit, offset).map(jobDto), total: this.db.countJobs(owner.ownerKey) } }
  findResources(owner: Identity, filters: ResourceFilters, offset = 0, limit = 50) {
    if (filters.name && filters.name.length > 100 || filters.format && !/^[a-z0-9]{1,12}$/u.test(filters.format) ||
      filters.kind && !['raw', 'dataset', 'report', 'export'].includes(filters.kind) ||
      filters.status && !['staging', 'building', 'ready', 'failed'].includes(filters.status)) {
      throw new ServiceError(400, 'INVALID_RESOURCE_FILTER', '资源筛选条件无效')
    }
    validRange(filters.from, filters.to)
    const result = this.db.findResources(owner.ownerKey, filters, offset, limit)
    return { items: result.items.map(resourceDto), total: result.total }
  }
  findJobs(owner: Identity, filters: JobFilters, offset = 0, limit = 50) {
    if (filters.name && filters.name.length > 100 || filters.kind && !/^[a-z]{2,20}$/u.test(filters.kind) ||
      filters.state && !['draft', 'queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed', 'interrupted'].includes(filters.state) ||
      filters.inputId && !/^res_[0-9a-f-]{36}$/u.test(filters.inputId)) {
      throw new ServiceError(400, 'INVALID_JOB_FILTER', '任务筛选条件无效')
    }
    validRange(filters.from, filters.to)
    const result = this.db.findJobs(owner.ownerKey, filters, offset, limit)
    return { items: result.items.map(jobDto), total: result.total }
  }
  listResourcesAfter(owner: Identity, cursor: string, limit = 50) {
    const parsed = parseCursor(cursor, 'res')
    const rows = this.db.listResourcesAfter(owner.ownerKey, limit + 1, parsed)
    return { items: rows.slice(0, limit).map(resourceDto), total: this.db.countResources(owner.ownerKey),
      nextCursor: rows.length > limit ? cursorFor(rows[limit - 1]!) : null }
  }
  listJobsAfter(owner: Identity, cursor: string, limit = 50) {
    const parsed = parseCursor(cursor, 'job')
    const rows = this.db.listJobsAfter(owner.ownerKey, limit + 1, parsed)
    return { items: rows.slice(0, limit).map(jobDto), total: this.db.countJobs(owner.ownerKey),
      nextCursor: rows.length > limit ? cursorFor(rows[limit - 1]!) : null }
  }
  search(owner: Identity, query: string) {
    const text = query.trim()
    if (text.length < 1 || text.length > 100) throw new ServiceError(400, 'INVALID_SEARCH', '搜索词长度应为 1 到 100 个字符')
    return { resources: this.db.searchResources(owner.ownerKey, text).map(resourceDto),
      jobs: this.db.searchJobs(owner.ownerKey, text).map(jobDto) }
  }
  overview(owner: Identity) {
    const states = this.db.countJobsByState(owner.ownerKey)
    return { resources: this.db.countResources(owner.ownerKey), jobs: this.db.countJobs(owner.ownerKey),
      running: (states.running ?? 0) + (states.cancel_requested ?? 0), queued: states.queued ?? 0,
      needsAttention: this.db.countAttentionJobs(owner.ownerKey),
      attentionJobs: this.db.listAttentionJobs(owner.ownerKey).map(jobDto) }
  }

  storage(owner: Identity) {
    return { usedBytes: this.db.storageBytes(owner.ownerKey), quotaBytes: this.limits.ownerQuotaBytes }
  }

  getUserSettings(owner: Identity) {
    const row = this.db.getUserSettings(owner.ownerKey)
    return { settings: row ? validateUserSettings(JSON.parse(row.settings_json) as unknown) : { ...DEFAULT_SETTINGS },
      updatedAt: row?.updated_at ?? null }
  }

  updateUserSettings(owner: Identity, raw: unknown, expectedUpdatedAt: number | null) {
    if (expectedUpdatedAt !== null && (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0)) {
      throw new ServiceError(422, 'INVALID_SETTINGS_REVISION', '设置版本无效')
    }
    let settings: UserSettings
    try { settings = validateUserSettings(raw) }
    catch (error) { throw new ServiceError(422, 'INVALID_SETTINGS', error instanceof SettingsError ? error.message : '默认设置无效') }
    const row = this.db.setUserSettings(owner.ownerKey, JSON.stringify(settings), expectedUpdatedAt)
    if (!row) throw new ServiceError(409, 'SETTINGS_CHANGED', '设置已在其他页面更新，请刷新后再保存')
    return { settings, updatedAt: row.updated_at }
  }

  async storageDetails(owner: Identity) {
    const workspace = join(this.dataDir, 'owners', owner.workspaceId)
    const [uploads, jobs] = await Promise.all([
      directoryUsage(join(workspace, 'uploads')),
      directoryUsage(join(workspace, 'jobs')),
    ])
    let cacheBytes = 0
    for (const [key, value] of this.rowCache) {
      if (key.startsWith(`["${owner.ownerKey}",`)) cacheBytes += value.bytes
    }
    return { ...this.storage(owner), categories: this.db.storageBreakdown(owner.ownerKey),
      uploads, temporaryJobs: jobs, previewCacheBytes: cacheBytes,
      globalQuotaBytes: this.limits.globalQuotaBytes, limits: this.limits }
  }

  clearPreviewCache(owner: Identity) {
    let freedBytes = 0
    for (const [key, value] of this.rowCache) {
      if (key.startsWith(`["${owner.ownerKey}",`)) {
        this.rowCache.delete(key)
        this.rowCacheSize -= value.bytes
        freedBytes += value.bytes
      }
    }
    return { freedBytes, resourceFilesDeleted: 0 }
  }

  async cleanupPreview(owner: Identity) {
    const rows = this.db.listTrashedResources(owner.ownerKey, 100, 0)
    const items = []
    for (const row of rows) {
      const activeJobs = this.db.resourceDependencies(owner.ownerKey, row.id).activeJobs.length
      const directory = join(this.dataDir, 'owners', owner.workspaceId, 'resources', row.id)
      const usage = await directoryUsage(directory, 2000)
      items.push({ id: row.id, name: row.name, kind: row.kind, updatedAt: row.updated_at,
        estimatedBytes: usage.bytes, estimateComplete: usage.complete, activeJobs,
        dependentResources: this.db.resourceDependencies(owner.ownerKey, row.id).derivedResources.length,
        canPurge: activeJobs === 0 })
    }
    return { items, total: this.db.countTrashedResources(owner.ownerKey),
      note: '永久清理后文件不能恢复；由该文件生成的结果仍保留，但来源可能无法再次打开。' }
  }

  async purgeTrashedResource(owner: Identity, id: string, expectedUpdatedAt: number) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind === 'view' || row.status !== 'trashed') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '回收站中没有该资源')
    if (!Number.isSafeInteger(expectedUpdatedAt) || row.updated_at !== expectedUpdatedAt) {
      throw new ServiceError(409, 'RESOURCE_CHANGED', '资源已变化，请重新查看清理预览')
    }
    if (this.db.resourceDependencies(owner.ownerKey, id).activeJobs.length) {
      throw new ServiceError(409, 'RESOURCE_IN_USE', '资源正被任务使用，不能清理')
    }
    const directory = join(this.dataDir, 'owners', owner.workspaceId, 'resources', id)
    const estimate = await directoryUsage(directory)
    try {
      const info = await lstat(directory)
      if (!info.isDirectory()) throw new ServiceError(500, 'RESOURCE_DIRECTORY_INVALID', '资源目录结构无效，不能清理')
      const marker = join(directory, '.purged')
      await writeFile(marker, JSON.stringify({ resourceId: id, ownerKey: owner.ownerKey }), { mode: 0o600 })
      await syncFile(marker)
      await syncDirectory(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!this.db.purgeTrashedResource(owner.ownerKey, id, expectedUpdatedAt)) {
      throw new ServiceError(409, 'RESOURCE_CHANGED', '资源已变化，请重新查看清理预览')
    }
    try { await rm(directory, { recursive: true, force: true }) }
    catch { return { id, freedBytes: 0, pendingFileCleanup: true, resourceFilesDeleted: 0 } }
    return { id, freedBytes: estimate.bytes, pendingFileCleanup: false, resourceFilesDeleted: 1 }
  }

  async purgeExpiredTrashedResources() {
    const expired = this.db.listExpiredTrashedResources(Date.now() - TRASH_RETENTION_MS, 1000)
    let purged = 0, failed = 0
    for (const row of expired) {
      if (!/^[0-9a-f]{64}$/u.test(row.owner_key) || !/^res_[0-9a-f-]{36}$/u.test(row.id)) {
        failed += 1
        continue
      }
      const owner: Identity = { ownerKey: row.owner_key, workspaceId: row.owner_key.slice(0, 24),
        displayName: '', source: 'local' }
      try {
        await this.purgeTrashedResource(owner, row.id, row.updated_at)
        purged += 1
      } catch { failed += 1 }
    }
    return { purged, failed, remainingMayExist: expired.length === 1000 }
  }

  private compareResult(owner: Identity, id: string) {
    const resource = this.db.getResource(owner.ownerKey, id)
    if (!resource || resource.kind !== 'dataset' || resource.status !== 'ready' || !resource.storage_relpath ||
      !metadata(resource).compareSummary) throw new ServiceError(404, 'COMPARE_RESULT_NOT_FOUND', '核对结果不存在')
    return resource
  }

  listCompareAnnotations(owner: Identity, id: string, offset: number, limit: number) {
    this.compareResult(owner, id)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ServiceError(400, 'INVALID_PAGE', '标注范围无效')
    }
    return { items: this.db.listCompareAnnotations(owner.ownerKey, id,
      Array.from({ length: limit }, (_, index) => offset + index + 1)).map((row) => ({
        detailRow: row.detail_row, status: row.status, note: row.note, updatedAt: row.updated_at })) }
  }

  setCompareAnnotations(owner: Identity, id: string, edits: { detailRow: number;
    status: CompareAnnotationRow['status'] | null; note: string; expectedUpdatedAt: number | null }[]) {
    const resource = this.compareResult(owner, id)
    if (!Array.isArray(edits) || !edits.length || edits.length > 100 ||
      new Set(edits.map((edit) => edit.detailRow)).size !== edits.length ||
      edits.some((edit) => !Number.isSafeInteger(edit.detailRow) || edit.detailRow < 1 || edit.detailRow > (resource.row_count ?? 0) ||
        edit.status !== null && !['pending', 'verified', 'ignored'].includes(edit.status) ||
        typeof edit.note !== 'string' || edit.note.length > 1000 ||
        edit.expectedUpdatedAt !== null && (!Number.isSafeInteger(edit.expectedUpdatedAt) || edit.expectedUpdatedAt < 0))) {
      throw new ServiceError(422, 'INVALID_ANNOTATION', '标注内容或明细行号无效')
    }
    const updated = this.db.setCompareAnnotations(owner.ownerKey, id, edits)
    if (!updated) throw new ServiceError(409, 'ANNOTATION_CONFLICT', '标注已由其他页面修改，请刷新后再保存')
    return { items: updated.map((row) => ({ detailRow: row.detail_row, status: row.status, note: row.note, updatedAt: row.updated_at })) }
  }

  async findCompareDetails(owner: Identity, id: string, filters: { category?: string; key?: string; field?: string;
    fieldState?: string; value?: string; differenceMin?: string; differenceMax?: string;
    sourceRow?: number; annotationStatus?: string }, offset: number, limit: number) {
    const differenceMin = filters.differenceMin ? decimalMagnitude(filters.differenceMin) : null
    const differenceMax = filters.differenceMax ? decimalMagnitude(filters.differenceMax) : null
    if (offset < 0 || offset > 10_000_000 || limit < 1 || limit > 100 ||
      [filters.key, filters.field, filters.value].some((value) => value !== undefined && value.length > 120) ||
      (filters.differenceMin && !differenceMin) || (filters.differenceMax && !differenceMax) ||
      (differenceMin && differenceMax && compareMagnitudes(differenceMin, differenceMax) > 0) ||
      filters.category && !['equal', 'different', 'pair_error', 'left_only', 'right_only', 'key_conflict', 'invalid_left_key', 'invalid_right_key'].includes(filters.category) ||
      filters.fieldState && !['equal', 'different', 'error'].includes(filters.fieldState) ||
      filters.annotationStatus && !['unmarked', 'pending', 'verified', 'ignored'].includes(filters.annotationStatus) ||
      filters.sourceRow !== undefined && (!Number.isSafeInteger(filters.sourceRow) || filters.sourceRow < 1)) {
      throw new ServiceError(400, 'INVALID_COMPARE_FILTER', '核对明细检索条件无效')
    }
    const resource = this.compareResult(owner, id)
    if (this.activeCompareReads >= 2) throw new ServiceError(429, 'COMPARE_SEARCH_BUSY', '同时检索的核对结果过多')
    this.activeCompareReads += 1
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), 30 * 1000)
    deadline.unref()
    try {
      const path = await checkedResourcePath(this.dataDir, owner.workspaceId, resource.storage_relpath)
      const source = createReadStream(path, { signal: abort.signal })
      const parser = parseCsvStream({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
      source.on('error', (error) => parser.destroy(error))
      source.pipe(parser)
      const rows: { detailRow: number; cells: string[]; annotation: { status: string; note: string; updatedAt: number } | null }[] = []
      let total = 0
      let scanned = 0
      let first = true
      try {
        for await (const row of parser as AsyncIterable<string[]>) {
          if (first) { first = false; continue }
          scanned += 1
          if (![10, 12, 14, 16].includes(row.length)) throw new ServiceError(500, 'COMPARE_RESULT_DAMAGED', '核对结果字段数无效')
          const oldCells = row.length === 10 ? [...row.slice(0, 8), '', '', ...row.slice(8), '', '']
            : row.length === 12 ? [...row, '', ''] : row
          const cells = oldCells.length === 14 ? [...oldCells, '', ''] : oldCells
          const difference = differenceMin || differenceMax ? decimalMagnitude(cells[10] ?? '') : null
          if (filters.category && cells[0] !== filters.category || filters.key && !cells[2]!.includes(filters.key) ||
            filters.field && !cells[5]!.includes(filters.field) || filters.fieldState && cells[1] !== filters.fieldState ||
            filters.value && ![cells[6], cells[7], cells[8], cells[9], cells[14], cells[15]].some((value) => value?.includes(filters.value!)) ||
            (differenceMin || differenceMax) && (!difference ||
              differenceMin && compareMagnitudes(difference, differenceMin) < 0 ||
              differenceMax && compareMagnitudes(difference, differenceMax) > 0) ||
            filters.sourceRow !== undefined && cells[3] !== String(filters.sourceRow) && cells[4] !== String(filters.sourceRow) &&
              !cells[12]!.split(',').includes(String(filters.sourceRow)) && !cells[13]!.split(',').includes(String(filters.sourceRow))) continue
          const annotation = filters.annotationStatus || total >= offset && rows.length < limit
            ? this.db.getCompareAnnotation(owner.ownerKey, id, scanned) : undefined
          if (filters.annotationStatus && (annotation?.status ?? 'unmarked') !== filters.annotationStatus) continue
          if (total >= offset && rows.length < limit) rows.push({ detailRow: scanned, cells,
            annotation: annotation ? { status: annotation.status, note: annotation.note, updatedAt: annotation.updated_at } : null })
          total += 1
        }
      } finally { source.destroy(); parser.destroy() }
      if (first) throw new ServiceError(500, 'COMPARE_RESULT_DAMAGED', '核对结果缺少表头')
      if (scanned !== resource.row_count) throw new ServiceError(500, 'COMPARE_RESULT_DAMAGED', '核对结果行数与资源记录不一致')
      return { items: rows, total, offset, limit }
    } finally { clearTimeout(deadline); this.activeCompareReads -= 1 }
  }

  listRecipes(owner: Identity) { return { items: this.db.listCurrentRecipes(owner.ownerKey).map(recipeDto) } }

  getRecipe(owner: Identity, id: string) {
    const row = this.db.getRecipe(owner.ownerKey, id)
    if (!row || row.deleted_at !== null) throw new ServiceError(404, 'RECIPE_NOT_FOUND', '模板不存在')
    return recipeDto(row)
  }

  listRecipeVersions(owner: Identity, id: string) {
    const row = this.db.getRecipe(owner.ownerKey, id)
    if (!row || row.deleted_at !== null) throw new ServiceError(404, 'RECIPE_NOT_FOUND', '模板不存在')
    return { items: this.db.listRecipeVersions(owner.ownerKey, row.family_id).filter((item) => item.deleted_at === null).map(recipeDto) }
  }

  private buildPipelineFromJob(owner: Identity, job: JobRow): PipelineRecipeSpec {
    if (job.state !== 'succeeded') throw new ServiceError(422, 'PIPELINE_SOURCE_UNFINISHED', '保存连续步骤需要已完成的最终任务')
    const resultId = (JSON.parse(job.summary_json) as { outputId?: string }).outputId
    if (!resultId) throw new ServiceError(422, 'PIPELINE_OUTPUT_MISSING', '最终任务没有结果资源')
    const inputs: PipelineRecipeSpec['inputs'] = []
    const steps: PipelineRecipeSpec['steps'] = []
    const seenResources = new Map<string, RecipeRef>()
    const visiting = new Set<string>()
    const allowed = new Set(['filter', 'clean', 'dedup', 'quality', 'analyze', 'split', 'export', 'combine', 'compare', 'sql'])
    const visit = (resourceId: string): RecipeRef => {
      const prior = seenResources.get(resourceId)
      if (prior) return prior
      if (visiting.has(resourceId)) throw new ServiceError(422, 'PIPELINE_CYCLE', '任务来源关系存在循环')
      visiting.add(resourceId)
      const resource = this.db.getResource(owner.ownerKey, resourceId)
      if (!resource || resource.status !== 'ready') throw new ServiceError(422, 'PIPELINE_SOURCE_MISSING', '连续步骤中的资源已不可用')
      const producer = resource.producer_job_id ? this.db.getJob(owner.ownerKey, resource.producer_job_id) : undefined
      let ref: RecipeRef
      if (producer && producer.state === 'succeeded' && allowed.has(producer.kind)) {
        const sourceIds = JSON.parse(producer.input_ids_json) as string[]
        const sourceRefs = sourceIds.map(visit)
        const sourceHeaders = sourceIds.map((id) => metadata(this.db.getResource(owner.ownerKey, id)!).headers as string[])
        const rule = recipeFromJob(producer.kind, JSON.parse(producer.spec_json) as unknown, sourceHeaders)
        if (steps.length >= 64) throw new ServiceError(422, 'PIPELINE_TOO_LONG', '连续步骤超过 64 步')
        const stepId = `s${steps.length + 1}`
        steps.push({ id: stepId, inputs: sourceRefs, rule })
        ref = `step:${stepId}`
      } else {
        if (resource.kind !== 'dataset') throw new ServiceError(422, 'PIPELINE_SOURCE_INVALID', '连续步骤需要从可用数据集开始')
        if (inputs.length >= 20) throw new ServiceError(422, 'PIPELINE_TOO_MANY_INPUTS', '连续步骤输入超过 20 份')
        const index = inputs.length
        inputs.push({ name: resource.name.slice(0, 120), requiredHeaders: [] })
        ref = `input:${index}`
      }
      visiting.delete(resourceId)
      seenResources.set(resourceId, ref)
      return ref
    }
    const output = visit(resultId)
    if (steps.length === 0) throw new ServiceError(422, 'PIPELINE_EMPTY', '没有可复用的处理步骤')
    return { version: 1, operation: 'pipeline', inputs, steps, output }
  }

  createRecipeFromJob(owner: Identity, jobId: string, name: string, description: string, includeHistory = false) {
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 120 || description.length > 1000) {
      throw new ServiceError(422, 'INVALID_RECIPE', '模板名称或说明长度无效')
    }
    const job = this.db.getJob(owner.ownerKey, jobId)
    if (!job) throw new ServiceError(404, 'JOB_NOT_FOUND', '任务不存在')
    let spec: RecipeSpec
    try {
      if (includeHistory) spec = this.buildPipelineFromJob(owner, job)
      else {
        const sourceIds = JSON.parse(job.input_ids_json) as string[]
        const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
        if (sources.length === 0 || sources.some((source) => !source || source.kind !== 'dataset' || source.status !== 'ready')) {
          throw new ServiceError(422, 'RECIPE_INPUT_UNAVAILABLE', '保存模板需要仍然可用的输入数据集')
        }
        const headers = sources.map((source) => metadata(source!).headers as string[])
        spec = recipeFromJob(job.kind, JSON.parse(job.spec_json) as unknown, headers)
      }
    }
    catch (error) {
      if (error instanceof RecipeValidationError) throw new ServiceError(422, 'RECIPE_UNSUPPORTED', error.message)
      throw error
    }
    spec = validateRecipeSpec(spec)
    const serialized = JSON.stringify(spec)
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new ServiceError(413, 'RECIPE_TOO_LARGE', '模板规则超过 256 KiB')
    const kind: RecipeRow['kind'] = spec.operation === 'pipeline' ? 'pipeline' : spec.operation === 'compare' ? 'compare' : spec.operation === 'quality' ? 'validate'
      : spec.operation === 'sql' ? 'sql' : 'transform'
    const now = Date.now()
    const id = `rec_${randomUUID()}`
    const row: RecipeRow = { id, owner_key: owner.ownerKey, family_id: id, version: 1, kind,
      name: cleanName, description, spec_json: serialized, parameter_schema: '{}',
      compatibility_json: JSON.stringify({ sourceJobId: job.id, inputCount: recipeInputCount(spec), engineVersion: job.engine_version }),
      is_current: 1, created_at: now, updated_at: now, deleted_at: null }
    this.db.insertRecipe(row)
    return recipeDto(row)
  }

  importRecipe(owner: Identity, name: string, description: string, rawSpec: unknown) {
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 120 || typeof description !== 'string' || description.length > 1000) {
      throw new ServiceError(422, 'INVALID_RECIPE', '模板名称或说明无效')
    }
    let spec: RecipeSpec
    try { spec = validateRecipeSpec(rawSpec) }
    catch (error) {
      if (error instanceof RecipeValidationError) throw new ServiceError(422, 'INVALID_RECIPE_SPEC', error.message)
      throw error
    }
    const serialized = JSON.stringify(spec)
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new ServiceError(413, 'RECIPE_TOO_LARGE', '模板规则超过 256 KiB')
    const kind: RecipeRow['kind'] = spec.operation === 'pipeline' ? 'pipeline' : spec.operation === 'compare' ? 'compare' :
      spec.operation === 'quality' ? 'validate' : spec.operation === 'sql' ? 'sql' : 'transform'
    const now = Date.now()
    const id = `rec_${randomUUID()}`
    const row: RecipeRow = { id, owner_key: owner.ownerKey, family_id: id, version: 1, kind,
      name: cleanName, description, spec_json: serialized, parameter_schema: '{}',
      compatibility_json: JSON.stringify({ inputCount: recipeInputCount(spec), engineVersion: this.engineVersion, imported: true }),
      is_current: 1, created_at: now, updated_at: now, deleted_at: null }
    this.db.insertRecipe(row)
    return recipeDto(row)
  }

  versionRecipe(owner: Identity, id: string, name: string, description: string, expectedUpdatedAt: number, rawSpec?: unknown) {
    const current = this.db.getRecipe(owner.ownerKey, id)
    if (!current || current.deleted_at !== null || current.is_current !== 1) throw new ServiceError(404, 'RECIPE_NOT_FOUND', '当前模板不存在')
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 120 || description.length > 1000) throw new ServiceError(422, 'INVALID_RECIPE', '模板名称或说明长度无效')
    let spec: RecipeSpec
    try { spec = rawSpec === undefined ? JSON.parse(current.spec_json) as RecipeSpec : validateRecipeSpec(rawSpec) }
    catch (error) {
      if (error instanceof RecipeValidationError) throw new ServiceError(422, 'INVALID_RECIPE_SPEC', error.message)
      throw error
    }
    const serialized = JSON.stringify(spec)
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new ServiceError(413, 'RECIPE_TOO_LARGE', '模板规则超过 256 KiB')
    const kind: RecipeRow['kind'] = spec.operation === 'pipeline' ? 'pipeline' : spec.operation === 'compare' ? 'compare' :
      spec.operation === 'quality' ? 'validate' : spec.operation === 'sql' ? 'sql' : 'transform'
    const next: RecipeRow = { ...current, id: `rec_${randomUUID()}`, version: current.version + 1, name: cleanName, description,
      kind, spec_json: serialized, compatibility_json: JSON.stringify({ inputCount: recipeInputCount(spec), engineVersion: this.engineVersion }),
      is_current: 1, created_at: Date.now(), updated_at: Math.max(Date.now(), current.updated_at + 1), deleted_at: null }
    if (!this.db.versionRecipe(owner.ownerKey, id, expectedUpdatedAt, next)) {
      throw new ServiceError(409, 'RECIPE_CHANGED', '模板已在其他位置修改，请刷新后重试')
    }
    return recipeDto(next)
  }

  copyRecipe(owner: Identity, id: string, name: string) {
    const source = this.db.getRecipe(owner.ownerKey, id)
    if (!source || source.deleted_at !== null) throw new ServiceError(404, 'RECIPE_NOT_FOUND', '模板不存在')
    const cleanName = name.trim()
    if (!cleanName || cleanName.length > 120) throw new ServiceError(422, 'INVALID_RECIPE', '模板名称无效')
    const now = Date.now()
    const newId = `rec_${randomUUID()}`
    const copy: RecipeRow = { ...source, id: newId, family_id: newId, version: 1, name: cleanName,
      is_current: 1, created_at: now, updated_at: now, deleted_at: null }
    this.db.insertRecipe(copy)
    return recipeDto(copy)
  }

  deleteRecipe(owner: Identity, id: string, expectedUpdatedAt: number) {
    if (!this.db.deleteRecipeFamily(owner.ownerKey, id, expectedUpdatedAt)) {
      throw new ServiceError(409, 'RECIPE_CHANGED', '模板已在其他位置修改，请刷新后重试')
    }
  }

  private bindRecipeInputs(owner: Identity, spec: SingleRecipeSpec, sourceIds: string[], parameterValues: Record<string, string> = {}): BoundRecipe {
    if (sourceIds.length !== recipeInputCount(spec) || new Set(sourceIds).size !== sourceIds.length) {
      throw new ServiceError(422, 'RECIPE_INPUT_COUNT', '输入数量与模板不一致或包含重复资源')
    }
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((source) => !source || source.kind !== 'dataset' || source.status !== 'ready' || !source.content_hash)) {
      throw new ServiceError(422, 'RECIPE_INPUT_UNAVAILABLE', '输入数据集未完成或不属于当前用户')
    }
    try { return bindRecipe(spec.operation === 'clean-plan'
      ? { ...spec, plan: applyCleanPlanParameters(spec.plan, parameterValues) } : spec,
    sources.map((source) => metadata(source!).headers as string[])) }
    catch (error) {
      if (error instanceof RecipeValidationError) throw new ServiceError(422, 'RECIPE_SCHEMA_MISMATCH', error.message)
      throw error
    }
  }

  private submitBoundRecipe(owner: Identity, spec: BoundRecipe, sourceIds: string[], key: string,
    parameterValues: Record<string, string> = {}) {
    if (spec.operation === 'filter') return this.submitFilter(owner, sourceIds[0]!, spec.columnId, spec.mode, spec.value, key)
    if (spec.operation === 'filter-plan') return this.submitFilterPlan(owner, sourceIds[0]!, spec.plan, key)
    if (spec.operation === 'clean') return this.submitClean(owner, sourceIds[0]!, spec.columnId, spec.mode, key,
      null, spec.find, spec.replacement, spec.dateFormat)
    if (spec.operation === 'clean-plan') return this.submitCleanPlan(owner, sourceIds[0]!, spec.plan, key)
    if (spec.operation === 'dedup') return this.submitDedupe(owner, sourceIds[0]!, spec.columnIds, key)
    if (spec.operation === 'quality') return this.submitQuality(owner, sourceIds[0]!, spec.rules.map((rule) =>
      rule.kind === 'reference' ? { ...rule, referenceId: sourceIds[Number(rule.referenceId.slice(6))] ?? '' } : rule),
    key, null, spec.outputMode)
    if (spec.operation === 'analyze') return this.submitAnalyze(owner, sourceIds[0]!, key, null, spec.aggregate, spec.pivot,
      spec.frequencyColumnId)
    if (spec.operation === 'split') return this.submitSplit(owner, sourceIds[0]!, spec.config, key)
    if (spec.operation === 'export') {
      const sampleRows = this.trialMode && spec.scope
        ? this.db.getResource(owner.ownerKey, sourceIds[0]!)?.row_count ?? 0 : 0
      if (this.trialMode && spec.scope && sampleRows === 0) {
        throw new ServiceError(422, 'RECIPE_TRIAL_EMPTY_SCOPE', '样本没有可用于检查导出范围的记录')
      }
      const scope = this.trialMode && spec.scope
        ? { ...spec.scope, startRow: 1, endRow: Math.min(sampleRows, spec.scope.endRow - spec.scope.startRow + 1) }
        : spec.scope
      return this.submitExport(owner, sourceIds[0]!, spec.format, spec.safeText, key,
        null, false, spec.textOptions, spec.jsonOptions,
        spec.workbook ? { sourceIds, sheetNames: spec.workbook.sheetNames,
          rowsPerSheet: spec.workbook.rowsPerSheet } : undefined, scope, spec.outputName)
    }
    if (spec.operation === 'combine') return this.submitCombine(owner, sourceIds, spec.mode, key)
    if (spec.operation === 'relation') return this.submitCombine(owner, sourceIds, 'relation', key, null, spec.config)
    if (spec.operation === 'set') return this.submitCombine(owner, sourceIds, 'set', key, null, undefined, spec.config)
    if (spec.operation === 'reshape') return this.submitCombine(owner, sourceIds, 'reshape', key, null, undefined, undefined, spec.config)
    if (spec.operation === 'sql') return this.submitSql(owner, sourceIds, spec.sql, key, null,
      spec.parameterDefinitions ? { definitions: spec.parameterDefinitions,
        values: Object.fromEntries(spec.parameterDefinitions.map((item) => [item.name, parameterValues[item.name]])) as Record<string, string> } : undefined)
    return this.submitCompare(owner, sourceIds[0]!, sourceIds[1]!, spec.config, key)
  }

  private advanceRecipeGroup(owner: Identity, batchId: string, spec: RecipeSpec, group: RecipeBatchGroup,
    parameterValues: Record<string, string> = {}) {
    if (group.submissionError) return
    const steps: { id: string; enabled?: boolean; inputs: RecipeRef[]; rule: SingleRecipeSpec }[] =
      spec.operation === 'pipeline' ? spec.steps : [{ id: 's1', inputs: group.sourceIds.map((_, index) => `input:${index}` as RecipeRef), rule: spec }]
    const skipDisabled = () => {
      while (group.stepIndex < steps.length && steps[group.stepIndex]!.enabled === false) group.stepIndex += 1
    }
    skipDisabled()
    if (group.stepIndex >= steps.length) return
    const current = group.childJobId ? this.db.getJob(owner.ownerKey, group.childJobId) : null
    if (current) {
      if (current.state !== 'succeeded') return
      const outputId = (JSON.parse(current.summary_json) as { outputId?: string }).outputId
      const step = steps[group.stepIndex]!
      if (!outputId) { group.submissionError = '处理步骤没有可用结果'; return }
      group.outputs[step.id] = outputId
      group.stepIndex += 1
      skipDisabled()
      if (group.stepIndex >= steps.length) return
      group.childJobId = null
    }
    const step = steps[group.stepIndex]!
    const sourceIds = step.inputs.map((ref) => {
      if (ref.startsWith('input:')) return group.sourceIds[Number(ref.slice(6))]
      return group.outputs[ref.slice(5)]
    })
    if (sourceIds.some((id) => !id)) { group.submissionError = '流程步骤依赖的结果不存在'; return }
    try {
      if (spec.operation === 'pipeline' && Object.keys(group.outputs).length === 0) {
        for (let index = 0; index < spec.inputs.length; index += 1) {
          const source = this.db.getResource(owner.ownerKey, group.sourceIds[index]!)
          if (!source || source.kind !== 'dataset' || source.status !== 'ready') {
            throw new ServiceError(422, 'RECIPE_INPUT_UNAVAILABLE', `输入 ${index + 1} 的数据集不可用`)
          }
          const headers = metadata(source).headers as string[]
          for (const name of spec.inputs[index]!.requiredHeaders) {
            if (headers.indexOf(name) < 0 || headers.indexOf(name) !== headers.lastIndexOf(name)) {
              throw new ServiceError(422, 'RECIPE_SCHEMA_MISMATCH', `输入 ${index + 1} 缺少唯一字段：${name.slice(0, 80)}`)
            }
          }
        }
      }
      const bound = this.bindRecipeInputs(owner, step.rule, sourceIds as string[], parameterValues)
      const child = this.submitBoundRecipe(owner, bound, sourceIds as string[], `batch_${batchId}_${group.index}_${group.stepIndex}_${group.attempt}`, parameterValues)
      if (!this.db.linkJobToParent(owner.ownerKey, child.job.id, batchId)) {
        const linked = this.db.getJob(owner.ownerKey, child.job.id)
        if (linked?.parent_job_id !== batchId) throw new Error('批量子任务关联失败')
      }
      group.childJobId = child.job.id
      if (!group.historyJobIds.includes(child.job.id)) group.historyJobIds.push(child.job.id)
      group.submissionError = null
    } catch (error) {
      group.submissionError = error instanceof ServiceError ? error.message : '该步骤未能提交'
    }
  }

  preflightRecipe(owner: Identity, recipeId: string, sourceIds: string[], parameterValues: Record<string, string> = {}) {
    const recipe = this.db.getRecipe(owner.ownerKey, recipeId)
    if (!recipe || recipe.deleted_at !== null) throw new ServiceError(404, 'RECIPE_NOT_FOUND', '模板不存在')
    const spec = JSON.parse(recipe.spec_json) as RecipeSpec
    const problems: string[] = []
    if (!Array.isArray(sourceIds) || sourceIds.length !== recipeInputCount(spec) || new Set(sourceIds).size !== sourceIds.length) {
      throw new ServiceError(422, 'RECIPE_INPUT_COUNT', '输入数量与模板不一致或包含重复资源')
    }
    const compatibility = JSON.parse(recipe.compatibility_json) as { engineVersion?: string }
    if (compatibility.engineVersion && compatibility.engineVersion !== this.engineVersion) {
      problems.push(`模板记录的引擎版本为 ${compatibility.engineVersion}，当前为 ${this.engineVersion}`)
    }
    const sources = sourceIds.map((id, index) => {
      const source = this.db.getResource(owner.ownerKey, id)
      if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.content_hash) {
        problems.push(`输入 ${index + 1} 的数据集不可用`)
      }
      return source
    })
    if (spec.operation === 'pipeline') {
      for (let index = 0; index < spec.inputs.length; index += 1) {
        const source = sources[index]
        if (!source || source.status !== 'ready') continue
        const headers = metadata(source).headers as string[]
        for (const name of spec.inputs[index]!.requiredHeaders) {
          if (headers.indexOf(name) < 0 || headers.indexOf(name) !== headers.lastIndexOf(name)) {
            problems.push(`输入 ${index + 1} 缺少唯一字段：${name.slice(0, 80)}`)
          }
        }
      }
    }
    const sqlRules = spec.operation === 'pipeline' ? spec.steps.filter((step) => step.enabled !== false).map((step) => step.rule).filter((rule) => rule.operation === 'sql') :
      spec.operation === 'sql' ? [spec] : []
    for (const [index, rule] of sqlRules.entries()) {
      if (rule.operation !== 'sql') continue
      try { bindSqlParameters(rule.sql, rule.parameterDefinitions ? { definitions: rule.parameterDefinitions,
        values: Object.fromEntries(rule.parameterDefinitions.map((item) => [item.name, parameterValues[item.name]])) as Record<string, string> } : undefined) }
      catch (error) { problems.push(`SQL 规则 ${index + 1}：${error instanceof SqlParameterError ? error.message : '参数无效'}`) }
    }
    const cleanRules = spec.operation === 'pipeline' ? spec.steps.filter((step) => step.enabled !== false)
      .map((step) => step.rule).filter((rule) => rule.operation === 'clean-plan') : spec.operation === 'clean-plan' ? [spec] : []
    for (const [index, rule] of cleanRules.entries()) {
      if (rule.operation !== 'clean-plan') continue
      try {
        cleanPlanParameterNames(rule.plan)
        applyCleanPlanParameters(rule.plan, parameterValues)
      } catch (error) { problems.push(`清洗规则 ${index + 1}：${error instanceof RecipeValidationError ? error.message : '参数无效'}`) }
    }
    let checkedSteps = 0, deferredSteps = 0
    const steps: { id: string; enabled?: boolean; inputs: RecipeRef[]; rule: SingleRecipeSpec }[] =
      spec.operation === 'pipeline' ? spec.steps : [{ id: 's1', inputs: sourceIds.map((_, index) => `input:${index}` as RecipeRef), rule: spec }]
    for (const [index, step] of steps.entries()) {
      if (step.enabled === false) continue
      if (step.rule.operation === 'clean-plan' && step.rule.plan.steps.some((item) => item.enabled !== false &&
        item.type === 'fill' && item.scope && item.scope !== 'all')) {
        const ref = step.inputs[0]
        const source = ref?.startsWith('input:') ? sources[Number(ref.slice(6))] : null
        const producer = source?.producer_job_id ? this.db.getJob(owner.ownerKey, source.producer_job_id) : null
        if (ref?.startsWith('step:')) { deferredSteps += 1; continue }
        if (!source || producer?.kind !== 'import' && !metadata(source).cellStateReport && metadata(source).cellStateLineage !== true) {
          problems.push(`步骤 ${index + 1} 的输入没有可追溯的空值来源`)
          continue
        }
      }
      if (step.inputs.some((ref) => ref.startsWith('step:'))) { deferredSteps += 1; continue }
      if (step.inputs.some((ref) => !sources[Number(ref.slice(6))] || sources[Number(ref.slice(6))]!.status !== 'ready')) continue
      try {
        const bound = this.bindRecipeInputs(owner, step.rule,
          step.inputs.map((ref) => sourceIds[Number(ref.slice(6))]!), parameterValues)
        if (bound.operation === 'export') {
          const input = sources[Number(step.inputs[0]!.slice(6))]!
          if (bound.scope) validateExportScope(bound.scope, input.row_count ?? 0, input.column_count ?? 0)
          const rows = bound.scope ? bound.scope.endRow - bound.scope.startRow + 1 : input.row_count ?? 0
          if (bound.workbook?.rowsPerSheet && rows > bound.workbook.rowsPerSheet * 20) {
            throw new ExportScopeError('导出数据需要超过 20 张工作表，请增大每张工作表的行数')
          }
        }
        checkedSteps += 1
      } catch (error) {
        problems.push(`步骤 ${index + 1}：${error instanceof ServiceError || error instanceof ExportScopeError
          ? error.message : '规则与输入不兼容'}`)
      }
    }
    return { ready: problems.length === 0, problems, checkedSteps, deferredSteps,
      sources: sources.map((source, index) => ({ id: sourceIds[index], hash: source?.content_hash ?? null,
        name: source?.name ?? null })), recipeVersion: recipe.version, engineVersion: this.engineVersion }
  }

  /** 在隔离的临时工作区运行同一套正式任务，只把每份输入的前 200 条记录交给它。 */
  async trialRecipe(owner: Identity, recipeId: string, sourceIds: string[], parameterValues: Record<string, string> = {}) {
    if (this.activeRecipeTrials >= 2) throw new ServiceError(429, 'RECIPE_TRIAL_BUSY', '正在试跑的模板过多，请稍后重试')
    this.activeRecipeTrials += 1
    try { return await this.executeRecipeTrial(owner, recipeId, sourceIds, parameterValues) }
    finally { this.activeRecipeTrials -= 1 }
  }

  private async executeRecipeTrial(owner: Identity, recipeId: string, sourceIds: string[],
    parameterValues: Record<string, string>) {
    const preflight = this.preflightRecipe(owner, recipeId, sourceIds, parameterValues)
    if (!preflight.ready) throw new ServiceError(422, 'RECIPE_PREFLIGHT_FAILED', preflight.problems.join('；'))
    const recipe = this.db.getRecipe(owner.ownerKey, recipeId)!
    const spec = JSON.parse(recipe.spec_json) as RecipeSpec
    const previewRoot = join('owners', owner.workspaceId, 'previews')
    await ensureDurableDirectory(this.dataDir, previewRoot)
    const trialDir = await mkdtemp(join(this.dataDir, previewRoot, 'recipe-trial-'))
    let trialDb: WebDatabase | null = null
    let trialService: WorkbenchService | null = null
    try {
      trialDb = new WebDatabase(trialDir)
      trialService = new WorkbenchService(trialDb, trialDir, this.binary, this.engineVersion, true)
      trialService.limits = this.limits
      const sampleIds: string[] = []
      const sampledRows: number[] = []
      for (const [inputIndex, id] of sourceIds.entries()) {
        const source = this.db.getResource(owner.ownerKey, id)
        if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath ||
          !source.content_hash || preflight.sources.find((item) => item.id === id)?.hash !== source.content_hash) {
          throw new ServiceError(409, 'RECIPE_INPUT_CHANGED', '试跑时输入数据集发生变化，请重新检查')
        }
        const sourcePath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
        const sampleId = `res_${randomUUID()}`
        const relpath = resourceRelpath(owner.workspaceId, sampleId, 'data.csv')
        await ensureDurableDirectory(trialDir, dirname(relpath))
        const samplePath = join(trialDir, relpath)
        const sampleRange = inputIndex === 0 && spec.operation === 'export' ? spec.scope : undefined
        const sampled = await writeSqlInputSample(sourcePath, samplePath, source.column_count ?? 0, undefined,
          sampleRange ? { startRow: sampleRange.startRow, endRow: sampleRange.endRow } : undefined)
        const conversionReport = metadata(source).jsonConversionReport as { file: string; rows: number;
          bytes: number; sha256: string } | undefined
        const stateReport = metadata(source).cellStateReport as { file: string; rows: number;
          bytes: number; sha256: string } | undefined
        if (conversionReport) {
          const verified = await this.jsonConversionReportPath(owner, id)
          await link(verified.path, join(dirname(samplePath), conversionReport.file))
        }
        if (stateReport) {
          const verified = await this.cellStateReportPath(owner, source)
          await link(verified, join(dirname(samplePath), stateReport.file))
        }
        await runQsv(this.binary, ['index', samplePath])
        const digest = await digestFile(samplePath)
        const now = Date.now()
        trialDb.insertResource({ id: sampleId, owner_key: owner.ownerKey, kind: 'dataset', status: 'ready',
          name: `${source.name.slice(0, 220)} · 样本`, format: 'csv', group_id: sampleId, version: 1,
          source_ids_json: '[]', producer_job_id: null, storage_relpath: relpath,
          content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, row_count: sampled.rows,
          column_count: source.column_count, metadata_json: JSON.stringify({ originalName: 'sample.csv',
            headers: metadata(source).headers, columnTypes: metadata(source).columnTypes ?? {},
            ...(conversionReport ? { jsonConversionReport: conversionReport } : {}),
            ...(stateReport ? { cellStateReport: stateReport } : {}),
            cellStateLineage: metadata(source).cellStateLineage === true ||
              this.db.getJob(owner.ownerKey, source.producer_job_id ?? '')?.kind === 'import',
            sampleOriginRows: sampled.rows, indexState: 'ready' }),
          created_at: now, updated_at: now, deleted_at: null })
        sampleIds.push(sampleId)
        sampledRows.push(sampled.rows)
      }
      const trialRecipe = trialService.importRecipe(owner, recipe.name, recipe.description, spec)
      const submitted = trialService.submitRecipeBatch(owner, trialRecipe.id, [sampleIds], `trial_${randomUUID()}`, parameterValues)
      let batch = submitted
      const deadline = Date.now() + 60_000
      while (batch.batch.state === 'running' && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150))
        batch = trialService.getRecipeBatch(owner, submitted.batch.id)
      }
      if (batch.batch.state === 'running') throw new ServiceError(408, 'RECIPE_TRIAL_TIMEOUT', '样本试跑超过 60 秒，请减少步骤或缩小输入')
      const steps = spec.operation === 'pipeline' ? spec.steps.filter((step) => step.enabled !== false) :
        [{ id: 's1', rule: spec }]
      const history = batch.groups[0]?.history ?? []
      const stepResults = history.map((job, index) => {
        const summary = job.summary as { outputId?: string; rowsIn?: number | null }
        const outputId = summary.outputId
        const output = outputId ? trialDb!.getResource(owner.ownerKey, outputId) : null
        return { id: steps[index]?.id ?? `s${index + 1}`, operation: steps[index]?.rule.operation ?? job.kind,
          state: job.state, rowsIn: summary.rowsIn ?? null, rowsOut: output?.row_count ?? null,
          outputKind: output?.kind ?? null, error: job.error?.message ?? null }
      })
      const finalId = (history.at(-1)?.summary as { outputId?: string } | undefined)?.outputId
      const finalResource = finalId ? trialDb.getResource(owner.ownerKey, finalId) : null
      const preview = finalResource?.kind === 'dataset' && finalResource.status === 'ready' && finalResource.storage_relpath
        ? await readSqlPreview(join(trialDir, finalResource.storage_relpath)) : null
      const ready = batch.batch.state === 'succeeded'
      if (ready) {
        const trialKey = hash(JSON.stringify({ ownerKey: owner.ownerKey, recipeId, sourceIds, parameterValues }))
        this.recipeTrials.set(trialKey, { expiresAt: Date.now() + 10 * 60_000, version: recipe.version,
          sourceHashes: preflight.sources.map((source) => source.hash) })
        if (this.recipeTrials.size > 5000) {
          for (const [key, value] of this.recipeTrials) if (value.expiresAt < Date.now()) this.recipeTrials.delete(key)
          if (this.recipeTrials.size > 5000) this.recipeTrials.delete(this.recipeTrials.keys().next().value!)
        }
      }
      return { ready, recipeVersion: recipe.version, engineVersion: this.engineVersion,
        sources: preflight.sources, sampledRows,
        scope: spec.operation === 'export' && spec.scope
          ? '导出输入取所选范围的前 200 条记录；其余输入取前 200 条记录；所有步骤在隔离样本上执行'
          : '每份输入的前 200 条记录；所有步骤在隔离样本上依次执行',
        steps: stepResults, preview: preview ? { ...preview, rows: preview.rows.slice(0, 20), sampleRows: Math.min(preview.sampleRows, 20) } : null,
        error: batch.groups[0]?.submissionError ?? history.at(-1)?.error?.message ?? null }
    } finally {
      try { await trialService?.shutdown() } finally { trialDb?.close(); await rm(trialDir, { recursive: true, force: true }) }
    }
  }

  private requireRecipeTrial(owner: Identity, recipeId: string, recipeVersion: number, sourceIds: string[],
    parameterValues: Record<string, string>) {
    const trialKey = hash(JSON.stringify({ ownerKey: owner.ownerKey, recipeId, sourceIds, parameterValues }))
    const trial = this.recipeTrials.get(trialKey)
    if (!trial || trial.expiresAt < Date.now() || trial.version !== recipeVersion) {
      throw new ServiceError(409, 'RECIPE_TRIAL_REQUIRED', '输入或参数尚未完成有效样本试跑，请重新试跑')
    }
    const current = this.preflightRecipe(owner, recipeId, sourceIds, parameterValues)
    if (!current.ready || current.sources.some((source, index) => source.hash !== trial.sourceHashes[index])) {
      this.recipeTrials.delete(trialKey)
      throw new ServiceError(409, 'RECIPE_TRIAL_STALE', '输入或模板已变化，请重新检查并试跑')
    }
  }

  submitRecipeBatch(owner: Identity, recipeId: string, groups: string[][], key: string,
    parameterValues: Record<string, string> = {}) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const recipe = this.db.getRecipe(owner.ownerKey, recipeId)
    if (!recipe || recipe.deleted_at !== null) throw new ServiceError(404, 'RECIPE_NOT_FOUND', '模板不存在')
    const spec = JSON.parse(recipe.spec_json) as RecipeSpec
    if (!Array.isArray(groups) || groups.length < 1 || groups.length > 20 || groups.some((group) =>
      !Array.isArray(group) || group.length !== recipeInputCount(spec) || group.some((id) => typeof id !== 'string' || id.length > 80))) {
      throw new ServiceError(422, 'INVALID_BATCH', '每组输入数量与模板不一致，批量最多 20 组')
    }
    if (!parameterValues || typeof parameterValues !== 'object' || Array.isArray(parameterValues) ||
      Object.keys(parameterValues).length > 16 || Object.entries(parameterValues).some(([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/u.test(name) || typeof value !== 'string' || value.length > 1024)) {
      throw new ServiceError(422, 'INVALID_SQL_PARAMETERS', '模板参数无效')
    }
    const snapshot = JSON.stringify({ recipeId, recipeVersion: recipe.version, recipeSpec: spec, groups, parameterValues })
    if (Buffer.byteLength(snapshot, 'utf8') > 256 * 1024) throw new ServiceError(413, 'BATCH_TOO_LARGE', '批量运行配置超过 256 KiB')
    const specHash = `sha256:${hash(snapshot)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.kind !== 'batch' || existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return this.getRecipeBatch(owner, existing.id)
    }
    if (!this.trialMode) for (const sourceIds of groups) {
      this.requireRecipeTrial(owner, recipeId, recipe.version, sourceIds, parameterValues)
    }
    const now = Date.now()
    const batchId = `job_${randomUUID()}`
    const entries: RecipeBatchGroup[] = groups.map((sourceIds, index) => ({ index, sourceIds, childJobId: null,
      submissionError: null, stepIndex: 0, outputs: {}, attempt: 0, lastRetryKey: null, historyJobIds: [] }))
    const job: JobRow = { id: batchId, owner_key: owner.ownerKey, kind: 'batch', name: `批量运行 ${recipe.name.slice(0, 200)}`,
      state: 'running', retry_of: null, input_ids_json: JSON.stringify([...new Set(groups.flat())]),
      spec_json: snapshot, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '提交各组任务' }),
      summary_json: JSON.stringify({ groups: entries, succeeded: 0, failed: 0, running: groups.length }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', batchId),
      created_at: now, started_at: now, finished_at: null, updated_at: now }
    this.db.insertJob(job)
    for (const entry of entries) {
      this.advanceRecipeGroup(owner, batchId, spec, entry, parameterValues)
      this.db.updateJobSummary(owner.ownerKey, batchId, { groups: entries, succeeded: 0, failed: 0, running: groups.length })
    }
    return this.getRecipeBatch(owner, batchId)
  }

  getRecipeBatch(owner: Identity, id: string) {
    const row = this.db.getJob(owner.ownerKey, id)
    if (!row || row.kind !== 'batch') throw new ServiceError(404, 'BATCH_NOT_FOUND', '批量任务不存在')
    const summary = JSON.parse(row.summary_json) as { groups: RecipeBatchGroup[] }
    const snapshot = JSON.parse(row.spec_json) as { recipeId: string; recipeVersion: number; recipeSpec: RecipeSpec;
      parameterValues?: Record<string, string> }
    for (const group of summary.groups) this.advanceRecipeGroup(owner, id, snapshot.recipeSpec, group, snapshot.parameterValues)
    const groups = summary.groups.map((group) => ({ ...group,
      job: group.childJobId ? this.db.getJob(owner.ownerKey, group.childJobId) : undefined }))
    const stepCount = snapshot.recipeSpec.operation === 'pipeline' ? snapshot.recipeSpec.steps.length : 1
    const succeeded = groups.filter((group) => group.stepIndex >= stepCount && group.job?.state === 'succeeded').length
    const running = groups.filter((group) => !group.submissionError && group.stepIndex < stepCount && group.job &&
      ['draft', 'queued', 'running', 'cancel_requested'].includes(group.job.state)).length
    const failed = groups.length - succeeded - running
    const state: JobRow['state'] = running > 0 ? 'running' : failed > 0 ? 'failed' : 'succeeded'
    const nextSummary = { groups: summary.groups, succeeded, failed, running }
    if (row.state !== state || row.summary_json !== JSON.stringify(nextSummary)) {
      this.db.setJobState(owner.ownerKey, id, state, { mode: 'stage', percent: null,
        stage: running > 0 ? `${succeeded} 组完成，${running} 组仍在运行` : failed > 0 ? `${succeeded} 组成功，${failed} 组失败` : '全部组完成' },
      failed > 0 && running === 0 ? { code: 'BATCH_PARTIAL_FAILURE', message: `${failed} 组未成功`, retryable: true } : null, nextSummary)
    }
    const updated = this.db.getJob(owner.ownerKey, id)!
    const outputRefs = snapshot.recipeSpec.operation === 'pipeline'
      ? snapshot.recipeSpec.outputs ?? [snapshot.recipeSpec.output] : ['step:s1']
    return { batch: jobDto(updated), recipeId: snapshot.recipeId, recipeVersion: snapshot.recipeVersion,
      parameterValues: snapshot.parameterValues ?? {}, groups: groups.map((group) => ({ index: group.index, sourceIds: group.sourceIds,
      submissionError: group.submissionError, stepIndex: group.stepIndex, stepCount, outputs: group.outputs,
      selectedOutputs: outputRefs.flatMap((ref) => {
        const stepId = ref.slice(5), resourceId = group.outputs[stepId]
        return resourceId ? [{ stepId, resourceId }] : []
      }),
      job: group.job ? jobDto(group.job) : null,
      history: group.historyJobIds.map((jobId) => this.db.getJob(owner.ownerKey, jobId)).filter((child): child is JobRow => Boolean(child)).map(jobDto) })) }
  }

  retryRecipeBatchGroup(owner: Identity, batchId: string, index: number, sourceIds: string[], key: string) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const batch = this.db.getJob(owner.ownerKey, batchId)
    if (!batch || batch.kind !== 'batch') throw new ServiceError(404, 'BATCH_NOT_FOUND', '批量任务不存在')
    const snapshot = JSON.parse(batch.spec_json) as { recipeId: string; recipeVersion: number; recipeSpec: RecipeSpec;
      parameterValues?: Record<string, string> }
    const summary = JSON.parse(batch.summary_json) as { groups: RecipeBatchGroup[] }
    const group = summary.groups[index]
    if (!group || group.index !== index) throw new ServiceError(404, 'BATCH_GROUP_NOT_FOUND', '分组不存在')
    if (group.lastRetryKey === key) return this.getRecipeBatch(owner, batchId)
    const current = group.childJobId ? this.db.getJob(owner.ownerKey, group.childJobId) : null
    if (current && !['failed', 'cancelled', 'interrupted'].includes(current.state)) {
      throw new ServiceError(409, 'BATCH_GROUP_NOT_RETRYABLE', '该组当前不能重试')
    }
    if (sourceIds.length !== recipeInputCount(snapshot.recipeSpec)) throw new ServiceError(422, 'RECIPE_INPUT_COUNT', '输入数量与模板不一致')
    const changed = JSON.stringify(sourceIds) !== JSON.stringify(group.sourceIds)
    if (changed) this.requireRecipeTrial(owner, snapshot.recipeId, snapshot.recipeVersion, sourceIds,
      snapshot.parameterValues ?? {})
    group.sourceIds = sourceIds
    if (changed) { group.stepIndex = 0; group.outputs = {} }
    group.childJobId = null
    group.submissionError = null
    group.attempt += 1
    group.lastRetryKey = key
    this.advanceRecipeGroup(owner, batchId, snapshot.recipeSpec, group, snapshot.parameterValues)
    this.db.updateJobSummary(owner.ownerKey, batchId, { groups: summary.groups, succeeded: 0, failed: 0, running: 1 })
    return this.getRecipeBatch(owner, batchId)
  }

  async getSplitManifest(owner: Identity, id: string): Promise<SplitManifest> {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'export' || row.status !== 'ready' || row.format !== 'zip' || !row.storage_relpath) {
      throw new ServiceError(404, 'SPLIT_NOT_FOUND', '拆分结果不存在')
    }
    const archive = await checkedResourcePath(this.dataDir, owner.workspaceId, row.storage_relpath)
    const path = join(dirname(archive), 'manifest.json')
    const file = await stat(path)
    if (file.size > 8 * 1024 * 1024) throw new ServiceError(500, 'SPLIT_MANIFEST_INVALID', '拆分清单过大')
    return JSON.parse(await readFile(path, 'utf8')) as SplitManifest
  }

  async getSplitFile(owner: Identity, id: string, fileName: string) {
    const manifest = await this.getSplitManifest(owner, id)
    const file = manifest.files.find((entry) => entry.name === fileName)
    if (!file || !/^(chunk_[0-9]{5,}|part_[0-9a-f]{64})\.csv$/.test(fileName)) {
      throw new ServiceError(404, 'SPLIT_FILE_NOT_FOUND', '拆分文件不存在')
    }
    const row = this.db.getResource(owner.ownerKey, id)!
    const relpath = join(dirname(row.storage_relpath!), 'chunks', fileName)
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, relpath)
    const digest = await digestFile(path)
    if (digest.bytes !== file.bytes || digest.sha256 !== file.sha256) throw new ServiceError(500, 'SPLIT_FILE_CHANGED', '拆分文件校验失败')
    return { path, name: fileName, bytes: file.bytes }
  }

  private checkResourceCapacity(owner: Identity, kind: 'raw' | 'dataset' | 'view') {
    if (this.db.countAllResources(owner.ownerKey) + (this.reservedResourceByOwner.get(owner.ownerKey) ?? 0) >= this.limits.maxOwnerResources ||
      this.db.countAllResources() + this.reservedResourcesGlobal >= this.limits.maxGlobalResources) {
      throw new ServiceError(507, 'RESOURCE_LIMIT', '资源数量已达到上限')
    }
    if (kind === 'raw' && this.db.countRecentRawResources(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= MAX_OWNER_RAW_PER_HOUR) {
      throw new ServiceError(429, 'UPLOAD_RATE_LIMIT', '一小时内上传的文件过多，请稍后重试')
    }
  }

  private reserveResourceSlot(owner: Identity, kind: 'raw' | 'dataset' | 'view') {
    this.checkResourceCapacity(owner, kind)
    this.reservedResourcesGlobal += 1
    this.reservedResourceByOwner.set(owner.ownerKey, (this.reservedResourceByOwner.get(owner.ownerKey) ?? 0) + 1)
    return () => {
      this.reservedResourcesGlobal -= 1
      const left = (this.reservedResourceByOwner.get(owner.ownerKey) ?? 1) - 1
      if (left > 0) this.reservedResourceByOwner.set(owner.ownerKey, left)
      else this.reservedResourceByOwner.delete(owner.ownerKey)
    }
  }

  checkTusCapacity(owner: Identity, bytes: number, ownerPendingBytes: number, globalPendingBytes: number, pendingDiskBytes: number) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.limits.fileBytes) {
      throw new ServiceError(413, 'UPLOAD_SIZE_INVALID', '文件大小无效或超过当前上限')
    }
    if (this.db.storageBytes(owner.ownerKey) + (this.reservedByOwner.get(owner.ownerKey) ?? 0) + ownerPendingBytes + bytes > this.limits.ownerQuotaBytes ||
      this.db.storageBytes() + this.reservedGlobal + globalPendingBytes + bytes > this.limits.globalQuotaBytes) {
      throw new ServiceError(507, 'STORAGE_QUOTA_EXCEEDED', '存储配额不足')
    }
    const volume = statfsSync(this.dataDir)
    const freeBytes = Number(volume.bavail) * Number(volume.bsize)
    const protectedBytes = Math.max(this.limits.minFreeBytes, Math.ceil(freeBytes * 0.1))
    if (freeBytes - this.reservedGlobal - pendingDiskBytes - bytes < protectedBytes) {
      throw new ServiceError(507, 'DISK_SPACE_LOW', '可用磁盘空间不足')
    }
  }

  checkTusChunkSpace(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ServiceError(413, 'UPLOAD_CHUNK_INVALID', '上传分块大小无效')
    }
    const volume = statfsSync(this.dataDir)
    const freeBytes = Number(volume.bavail) * Number(volume.bsize)
    const protectedBytes = Math.max(this.limits.minFreeBytes, Math.ceil(freeBytes * 0.1))
    if (freeBytes - this.reservedGlobal - bytes < protectedBytes) {
      throw new ServiceError(507, 'DISK_SPACE_LOW', '可用磁盘空间不足')
    }
  }

  private reserve(owner: Identity, bytes: number, diskBytes = bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ServiceError(400, 'INVALID_SIZE', '文件大小无效')
    const currentOwnerReservation = this.reservedByOwner.get(owner.ownerKey) ?? 0
    if (this.db.storageBytes(owner.ownerKey) + currentOwnerReservation + bytes > this.limits.ownerQuotaBytes ||
      this.db.storageBytes() + this.reservedGlobal + bytes > this.limits.globalQuotaBytes) {
      throw new ServiceError(507, 'STORAGE_QUOTA_EXCEEDED', '存储配额不足')
    }
    const volume = statfsSync(this.dataDir)
    const freeBytes = Number(volume.bavail) * Number(volume.bsize)
    const protectedBytes = Math.max(this.limits.minFreeBytes, Math.ceil(freeBytes * 0.1))
    if (freeBytes - this.reservedGlobal - diskBytes < protectedBytes) {
      throw new ServiceError(507, 'DISK_SPACE_LOW', '可用磁盘空间不足')
    }
    this.reservedGlobal += bytes
    this.reservedByOwner.set(owner.ownerKey, currentOwnerReservation + bytes)
  }

  private release(owner: Identity, bytes: number) {
    this.reservedGlobal = Math.max(0, this.reservedGlobal - bytes)
    const remaining = Math.max(0, (this.reservedByOwner.get(owner.ownerKey) ?? 0) - bytes)
    if (remaining === 0) this.reservedByOwner.delete(owner.ownerKey)
    else this.reservedByOwner.set(owner.ownerKey, remaining)
  }

  getResource(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.status === 'trashed') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '资源不存在')
    return resourceDto(row)
  }

  listTrashedResources(owner: Identity, offset: number, limit: number) {
    return { items: this.db.listTrashedResources(owner.ownerKey, limit, offset).map(resourceDto), total: this.db.countTrashedResources(owner.ownerKey) }
  }

  resourceDependencies(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind === 'view' || row.status === 'trashed') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '资源不存在')
    return this.db.resourceDependencies(owner.ownerKey, id)
  }

  trashResource(owner: Identity, id: string, expectedUpdatedAt: number) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind === 'view' || row.status === 'trashed') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '资源不存在')
    if (!['ready', 'failed'].includes(row.status)) throw new ServiceError(409, 'RESOURCE_BUSY', '资源正在处理，不能删除')
    if (this.db.resourceDependencies(owner.ownerKey, id).activeJobs.length) throw new ServiceError(409, 'RESOURCE_IN_USE', '资源正被运行中的任务使用')
    const updated = this.db.setResourceTrashed(owner.ownerKey, id, expectedUpdatedAt, row.status as 'ready' | 'failed', 'trashed',
      JSON.stringify({ ...metadata(row), trashPreviousStatus: row.status }))
    if (!updated) throw new ServiceError(409, 'RESOURCE_CHANGED', '资源已在其他位置修改，请刷新后重试')
    return resourceDto(updated)
  }

  async restoreResource(owner: Identity, id: string, expectedUpdatedAt: number) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind === 'view' || row.status !== 'trashed') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '回收站中没有该资源')
    if (row.updated_at !== expectedUpdatedAt) throw new ServiceError(409, 'RESOURCE_CHANGED', '资源已在其他位置修改，请刷新后重试')
    const details = metadata(row)
    const target = details.trashPreviousStatus === 'failed' ? 'failed' : 'ready'
    if (target === 'ready' && !row.storage_relpath) throw new ServiceError(409, 'RESOURCE_FILE_UNAVAILABLE', '资源文件不存在，不能恢复为可用状态')
    if (target === 'ready' && row.storage_relpath) {
      let verified = false
      try {
        if (details.commitVersion === 1) {
          const commit = await readCommit(join(this.dataDir, 'owners', owner.workspaceId, 'resources', id, 'commit.json'))
          verified = isCommit(commit) && commit.resourceId === id && commit.ownerKey === owner.ownerKey &&
            commit.relpath === row.storage_relpath && commit.sha256 === row.content_hash?.replace(/^sha256:/, '') &&
            await verifyCommit(this.dataDir, commit)
        } else {
          const path = await checkedResourcePath(this.dataDir, owner.workspaceId, row.storage_relpath)
          const digest = await digestFile(path)
          verified = row.content_hash === `sha256:${digest.sha256}` && (row.kind !== 'dataset' || (await stat(`${path}.idx`)).isFile())
        }
      } catch { /* 缺失或损坏的文件不能恢复为可用资源。 */ }
      if (!verified) throw new ServiceError(409, 'RESOURCE_FILE_UNAVAILABLE', '资源文件校验失败，不能恢复为可用状态')
    }
    const restoredMetadata = { ...details }
    delete restoredMetadata.trashPreviousStatus
    const updated = this.db.setResourceTrashed(owner.ownerKey, id, expectedUpdatedAt, 'trashed', target, JSON.stringify(restoredMetadata))
    if (!updated) throw new ServiceError(409, 'RESOURCE_CHANGED', '资源已在其他位置修改，请刷新后重试')
    return resourceDto(updated)
  }

  updateResourceDetails(owner: Identity, id: string, name: string, description: string, expectedUpdatedAt: number) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.status === 'trashed' || row.kind === 'view') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '资源不存在')
    if (row.status !== 'ready' && row.status !== 'failed') throw new ServiceError(409, 'RESOURCE_BUSY', '资源正在处理，完成后再修改名称和说明')
    const displayName = name.trim()
    const note = description.trim()
    if (!displayName || displayName.length > 255 || /[\x00-\x1f\x7f]/.test(displayName)) throw new ServiceError(422, 'INVALID_RESOURCE_NAME', '显示名称应为 1 到 255 个字符，且不能包含控制字符')
    if (note.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(note)) throw new ServiceError(422, 'INVALID_RESOURCE_DESCRIPTION', '说明不能超过 1000 个字符或包含控制字符')
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) throw new ServiceError(400, 'INVALID_RESOURCE_VERSION', '资源更新时间无效')
    const details = metadata(row)
    const originalName = typeof details.originalName === 'string' ? details.originalName : row.name
    const sourceId = row.kind === 'dataset' ? (JSON.parse(row.source_ids_json) as string[])[0] : null
    const exampleRaw = row.kind === 'raw' ? row : sourceId ? this.db.getResource(owner.ownerKey, sourceId) : undefined
    const isBuiltInExample = exampleRaw?.kind === 'raw' && exampleRaw.content_hash === ORDERS_EXAMPLE_HASH && metadata(exampleRaw).uploadKey === ORDERS_EXAMPLE_UPLOAD_KEY
    if (isBuiltInExample && !displayName.startsWith('[内置示例]')) {
      throw new ServiceError(422, 'EXAMPLE_LABEL_REQUIRED', '内置示例的显示名称须保留“[内置示例]”标记')
    }
    const updated = this.db.updateResourceDetails(owner.ownerKey, id, expectedUpdatedAt, displayName, JSON.stringify({ ...details, originalName, description: note }))
    if (!updated) throw new ServiceError(409, 'RESOURCE_CHANGED', '资源已在其他位置修改，请刷新后重试')
    return resourceDto(updated)
  }

  rawByUploadKey(owner: Identity, key: string) {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const row = this.db.findRawByUploadKey(owner.ownerKey, key)
    if (!row || row.status === 'trashed') throw new ServiceError(404, 'RESOURCE_NOT_FOUND', '上传资源不存在')
    return resourceDto(row)
  }

  async previewRawCsv(owner: Identity, id: string, requestedOptions?: CsvImportOptions) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'raw' || row.status !== 'ready' || !['csv', 'tsv'].includes(row.format) || !row.storage_relpath) {
      throw new ServiceError(404, 'RAW_NOT_FOUND', '原文件不存在或尚未就绪')
    }
    let options: CsvImportOptions
    try { options = csvImportOptions(requestedOptions ?? (row.format === 'tsv' ? { ...csvImportOptions(undefined), delimiter: '\t' } : undefined)) }
    catch { throw new ServiceError(422, 'INVALID_CSV_OPTIONS', 'CSV 解析配置无效') }
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, row.storage_relpath)
    try { return await previewCsv(path, options) }
    catch (error) {
      if (error instanceof CsvValidationError) throw new ServiceError(422, 'CSV_PREVIEW_FAILED', error.message)
      throw error
    }
  }

  async previewRawJson(owner: Identity, id: string, requestedOptions?: JsonImportOptions) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'raw' || row.status !== 'ready' || !['json', 'jsonl', 'ndjson'].includes(row.format) || !row.storage_relpath) {
      throw new ServiceError(404, 'RAW_NOT_FOUND', 'JSON 原文件不存在或尚未就绪')
    }
    let options: JsonImportOptions
    try { options = jsonImportOptions(requestedOptions) }
    catch { throw new ServiceError(422, 'INVALID_JSON_OPTIONS', 'JSON 导入配置无效') }
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, row.storage_relpath)
    try { return await previewJson(path, row.format === 'json' ? 'json' : 'jsonl', options) }
    catch (error) {
      if (error instanceof JsonImportError) throw new ServiceError(422, 'JSON_PREVIEW_FAILED', error.message)
      throw error
    }
  }

  async previewRawParquet(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'raw' || row.status !== 'ready' || row.format !== 'parquet' || !row.storage_relpath) {
      throw new ServiceError(404, 'RAW_NOT_FOUND', 'Parquet 原文件不存在或尚未就绪')
    }
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, row.storage_relpath)
    let parquetColumns: Awaited<ReturnType<typeof readFlatParquetSchema>>
    try { parquetColumns = await readFlatParquetSchema(path) }
    catch (error) { throw new ServiceError(422, 'PARQUET_SCHEMA_UNSUPPORTED', error instanceof ParquetSchemaError ? error.message : 'Parquet 字段无法读取') }
    let output: string
    try { output = await runQsv(this.binary, ['sqlp', 'SKIP_INPUT',
      `SELECT * FROM read_parquet('${path.replaceAll("'", "''")}') LIMIT 21`, '--quiet'], undefined, 2 * 1024 * 1024, 60_000) }
    catch { throw new ServiceError(422, 'PARQUET_PREVIEW_FAILED', 'Parquet 样本无法读取，可能包含不支持的嵌套字段或超过预览上限') }
    let records: string[][]
    try { records = parse(output, { bom: true, relax_quotes: false, relax_column_count: false }) as string[][] }
    catch { throw new ServiceError(422, 'PARQUET_PREVIEW_FAILED', 'Parquet 样本转换结果无效') }
    const [headers = [], ...dataRows] = records
    if (headers.length === 0 || headers.length > 4096) throw new ServiceError(422, 'PARQUET_PREVIEW_FAILED', 'Parquet 字段数无效')
    const clip = (value: string) => value.length > 256 ? `${value.slice(0, 256)}…` : value
    if (headers.length !== parquetColumns.length || headers.some((name, index) => name !== parquetColumns[index]?.name)) {
      throw new ServiceError(422, 'PARQUET_SCHEMA_CHANGED', 'Parquet 样本字段与文件元数据不一致')
    }
    return { headers: headers.slice(0, 30).map(clip), rows: dataRows.slice(0, 20).map((data) => data.slice(0, 30).map(clip)),
      sampleRows: Math.min(dataRows.length, 20), totalKnown: false as const, columnCount: headers.length,
      columnsTruncated: headers.length > 30, parquetColumns: parquetColumns.slice(0, 30) }
  }

  async workbookSheets(owner: Identity, id: string, signal?: AbortSignal) {
    const raw = this.db.getResource(owner.ownerKey, id)
    if (!raw || raw.kind !== 'raw' || raw.status !== 'ready' || !['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(raw.format) || !raw.storage_relpath) {
      throw new ServiceError(404, 'WORKBOOK_NOT_FOUND', '工作簿不存在或尚未就绪')
    }
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, raw.storage_relpath)
    let value: unknown
    try { value = JSON.parse(await runQsv(this.binary, ['excel', '--metadata', 'json', path], signal, 4 * 1024 * 1024, 60_000)) }
    catch { throw new ServiceError(422, 'WORKBOOK_INVALID', '工作簿元信息无法读取，可能已加密或文件损坏') }
    const sheet = (value as { sheet?: unknown })?.sheet
    if (!Array.isArray(sheet) || sheet.length > 1000) throw new ServiceError(422, 'WORKBOOK_INVALID', '工作簿工作表列表无效或过长')
    const sheets = sheet.map((entry, index) => {
      const item = entry as Record<string, unknown>
      if (!item || typeof item.name !== 'string' || item.name.length > 255 ||
        !Number.isSafeInteger(item.index) || item.index !== index) throw new ServiceError(422, 'WORKBOOK_INVALID', '工作表元信息无效')
      return { index, name: item.name, type: String(item.typ ?? ''), visible: String(item.visible ?? ''),
        rowCount: Number.isSafeInteger(item.row_count) ? Number(item.row_count) : null,
        columnCount: Number.isSafeInteger(item.column_count) ? Number(item.column_count) : null }
    })
    if (sheets.length === 0) throw new ServiceError(422, 'WORKBOOK_EMPTY', '工作簿没有可读取的工作表')
    return sheets
  }

  async previewWorkbookSheet(owner: Identity, id: string, sheetName: string, requestedOptions?: CsvImportOptions) {
    if (!sheetName || sheetName.length > 255) throw new ServiceError(422, 'INVALID_SHEET', '工作表名称无效')
    let options: CsvImportOptions
    try { options = csvImportOptions(requestedOptions) }
    catch { throw new ServiceError(422, 'INVALID_CSV_OPTIONS', '工作表行范围配置无效') }
    const sheets = await this.workbookSheets(owner, id)
    if (!sheets.some((sheet) => sheet.name === sheetName)) throw new ServiceError(422, 'SHEET_NOT_FOUND', '指定的工作表不存在')
    const raw = this.db.getResource(owner.ownerKey, id)!
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, raw.storage_relpath!)
    const first = options.dataStartRow
    const last = Math.min(first + 19, options.dataEndRow ?? first + 19)
    const headerRange = `A${options.headerRow}:AD${options.headerRow + (options.headerRowCount ?? 1) - 1}`
    const dataRange = `A${first}:AD${last}`
    let directory: string | null = null
    try {
      const relative = join('owners', owner.workspaceId, 'previews')
      await ensureDurableDirectory(this.dataDir, relative)
      directory = await mkdtemp(join(this.dataDir, relative, 'sheet-'))
      const header = options.header === 'first-row' ? await runQsv(this.binary,
        ['excel', '--sheet', sheetName, '--range', headerRange, path], undefined, 2 * 1024 * 1024, 60_000) : ''
      const data = await runQsv(this.binary, ['excel', '--sheet', sheetName, '--range', dataRange, path], undefined,
        2 * 1024 * 1024, 60_000)
      const combined = join(directory, 'sample.csv')
      await writeFile(combined, `${header}${header.endsWith('\n') || !header ? '' : '\n'}${data}`, { flag: 'wx', mode: 0o600 })
      const preview = await previewCsv(combined, { ...options, encoding: 'utf-8', delimiter: ',', quote: '"',
        headerRow: 1, dataStartRow: options.header === 'first-row' ? (options.headerRowCount ?? 1) + 1 : 1, dataEndRow: null })
      const count = sheets.find((sheet) => sheet.name === sheetName)?.columnCount ?? preview.columnCount
      return { ...preview, columnCount: count, columnsTruncated: count > preview.headers.length,
        sampleRange: `${options.header === 'first-row' ? `${headerRange} + ` : ''}${dataRange}`, sheetName }
    } catch (error) {
      if (error instanceof CsvValidationError) throw new ServiceError(422, 'SHEET_PREVIEW_FAILED', error.message)
      if (error instanceof QsvCommandError || error instanceof QsvOutputLimitError) throw new ServiceError(422, 'SHEET_PREVIEW_FAILED', '所选工作表范围无法预览或超过 2 MiB 限制')
      throw error
    } finally { if (directory) await rm(directory, { recursive: true, force: true }) }
  }

  getJob(owner: Identity, id: string) {
    const row = this.db.getJob(owner.ownerKey, id)
    if (!row) throw new ServiceError(404, 'JOB_NOT_FOUND', '任务不存在')
    if (row.kind === 'batch') return this.getRecipeBatch(owner, id).batch
    const inputIds = JSON.parse(row.input_ids_json) as string[]
    const inputs = inputIds.map((resourceId) => {
      const resource = this.db.getResource(owner.ownerKey, resourceId)
      return resource ? { id: resource.id, name: resource.name, kind: resource.kind,
        status: resource.status, version: resource.version }
        : { id: resourceId, name: null, kind: null, status: 'missing' as const, version: null }
    })
    return { ...jobDto(row), inputs, outputs: this.db.listJobOutputs(owner.ownerKey, id).map(resourceDto) }
  }

  async upload(owner: Identity, stream: Readable, name: string, key: string, expectedBytes: number) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) throw new ServiceError(411, 'CONTENT_LENGTH_REQUIRED', '上传必须提供文件大小')
    let maxBytes: number
    try { validateUploadName(name); maxBytes = this.uploadLimit(name) }
    catch (error) { if (error instanceof UploadValidationError) throw new ServiceError(422, 'INVALID_FILE', error.message); throw error }
    if (expectedBytes > maxBytes) throw new ServiceError(413, 'UPLOAD_TOO_LARGE', '文件超过当前格式大小上限')
    if (this.activeUploads.size >= 16) throw new ServiceError(429, 'UPLOAD_BUSY', '同时上传的文件过多，请稍后重试')
    this.reserve(owner, expectedBytes)
    this.activeUploads.add(stream)
    let received: Awaited<ReturnType<typeof receiveUpload>>
    let releaseSlot: (() => void) | undefined
    try {
      try { received = await receiveUpload(stream, this.dataDir, owner.workspaceId, name) }
      catch (error) {
        if (error instanceof UploadLimitError) throw new ServiceError(413, 'UPLOAD_TOO_LARGE', error.message)
        if (error instanceof UploadValidationError) throw new ServiceError(422, 'INVALID_FILE', error.message)
        throw error
      }
      if (received.bytes !== expectedBytes) {
        await rm(dirname(received.path), { recursive: true, force: true })
        throw new ServiceError(400, 'UPLOAD_SIZE_MISMATCH', '实际文件大小与请求不一致')
      }
      const existing = this.db.findRawByUploadKey(owner.ownerKey, key)
      if (existing) {
        await rm(dirname(received.path), { recursive: true, force: true })
        if (existing.status === 'trashed') throw new ServiceError(409, 'RESOURCE_TRASHED', '相同上传键的原文件在回收站中，请先恢复')
        if (existing.content_hash !== `sha256:${received.sha256}` || metadata(existing).originalName !== name) {
          throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同文件')
        }
        return resourceDto(existing)
      }
      try { releaseSlot = this.reserveResourceSlot(owner, 'raw') }
      catch (error) { await rm(dirname(received.path), { recursive: true, force: true }); throw error }
      const now = Date.now()
      const row: ResourceRow = {
        id: received.id, owner_key: owner.ownerKey, kind: 'raw', status: 'ready', name,
        format: uploadFormat(name), group_id: received.id, version: 1, source_ids_json: '[]', producer_job_id: null,
        storage_relpath: received.relpath, content_hash: `sha256:${received.sha256}`, byte_size: received.bytes,
        row_count: null, column_count: null, metadata_json: JSON.stringify({ originalName: name, parseState: 'pending', uploadKey: key, commitVersion: 1 }),
        created_at: now, updated_at: now, deleted_at: null,
      }
      try {
        await writeCommit(dirname(received.path), {
          version: 1, kind: 'raw', resourceId: row.id, ownerKey: owner.ownerKey,
          workspaceId: owner.workspaceId, relpath: received.relpath, sha256: received.sha256,
          bytes: received.bytes, name, createdAt: now, uploadKey: key,
        })
      } catch {
        await rm(dirname(received.path), { recursive: true, force: true })
        throw new ServiceError(500, 'FILE_COMMIT_FAILED', '文件提交失败')
      }
      try { this.db.insertResource(row) } catch {
        const concurrent = this.db.findRawByUploadKey(owner.ownerKey, key)
        if (concurrent) {
          await rm(dirname(received.path), { recursive: true, force: true })
          if (concurrent.content_hash !== row.content_hash || metadata(concurrent).originalName !== name) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同文件')
          return resourceDto(concurrent)
        }
        throw new ServiceError(500, 'RESOURCE_COMMIT_FAILED', '文件已接收，但资源登记失败')
      }
      return resourceDto(row)
    } finally {
      releaseSlot?.()
      this.activeUploads.delete(stream)
      if (this.activeUploads.size === 0) for (const resolve of this.uploadIdleWaiters.splice(0)) resolve()
      this.release(owner, expectedBytes)
    }
  }

  /** tus 数据已完整到盘后，把它转成与普通上传相同的不可变原文件。 */
  async commitTusUpload(owner: Identity, stagedPath: string, name: string, key: string, expectedBytes: number, expectedHash: string) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    const task = this.commitTusUploadInner(owner, stagedPath, name, key, expectedBytes, expectedHash)
    this.activeTusCommits.add(task)
    try { return await task } finally { this.activeTusCommits.delete(task) }
  }

  private async commitTusUploadInner(owner: Identity, stagedPath: string, name: string, key: string, expectedBytes: number, expectedHash: string) {
    try { validateUploadName(name) }
    catch (error) { if (error instanceof UploadValidationError) throw new ServiceError(422, 'INVALID_FILE', error.message); throw error }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new ServiceError(400, 'INVALID_DIGEST', '文件摘要无效')
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > this.uploadLimit(name)) {
      throw new ServiceError(413, 'UPLOAD_SIZE_INVALID', '文件大小无效或超过当前格式上限')
    }
    const digest = await digestFile(stagedPath)
    if (digest.bytes !== expectedBytes) throw new ServiceError(409, 'UPLOAD_INCOMPLETE', '上传数据尚未完整')
    if (digest.sha256 !== expectedHash) throw new ServiceError(422, 'UPLOAD_DIGEST_MISMATCH', '重新选择的文件与上传数据不一致')
    const existing = this.db.findRawByUploadKey(owner.ownerKey, key)
    if (existing) {
      if (existing.status === 'trashed') throw new ServiceError(409, 'RESOURCE_TRASHED', '相同上传键的原文件在回收站中，请先恢复')
      if (metadata(existing).originalName !== name || existing.content_hash !== `sha256:${digest.sha256}`) {
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同文件')
      }
      return resourceDto(existing)
    }
    const releaseSlot = this.reserveResourceSlot(owner, 'raw')
    try {
      this.reserve(owner, expectedBytes, 0)
      try {
      const id = `res_${randomUUID()}`
      const relpath = resourceRelpath(owner.workspaceId, id, `original.${uploadFormat(name)}`)
      const path = join(this.dataDir, relpath)
      await syncFile(stagedPath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      await rename(stagedPath, path)
      await syncDirectory(dirname(stagedPath))
      await syncDirectory(dirname(path))
      const now = Date.now()
      const row: ResourceRow = {
        id, owner_key: owner.ownerKey, kind: 'raw', status: 'ready', name,
        format: uploadFormat(name), group_id: id, version: 1, source_ids_json: '[]', producer_job_id: null,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes,
        row_count: null, column_count: null,
        metadata_json: JSON.stringify({ originalName: name, parseState: 'pending', uploadKey: key, commitVersion: 1 }),
        created_at: now, updated_at: now, deleted_at: null,
      }
      try {
        await writeCommit(dirname(path), {
          version: 1, kind: 'raw', resourceId: id, ownerKey: owner.ownerKey,
          workspaceId: owner.workspaceId, relpath, sha256: digest.sha256,
          bytes: digest.bytes, name, createdAt: now, uploadKey: key,
        })
      } catch {
        await rm(dirname(path), { recursive: true, force: true })
        throw new ServiceError(500, 'FILE_COMMIT_FAILED', '文件提交失败')
      }
      try { this.db.insertResource(row) } catch {
        const concurrent = this.db.findRawByUploadKey(owner.ownerKey, key)
        if (concurrent) {
          await rm(dirname(path), { recursive: true, force: true })
          if (concurrent.content_hash !== row.content_hash || metadata(concurrent).originalName !== name) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同文件')
          return resourceDto(concurrent)
        }
        throw new ServiceError(500, 'RESOURCE_COMMIT_FAILED', '文件已接收，但资源登记失败')
      }
      return resourceDto(row)
      } finally { this.release(owner, expectedBytes) }
    } finally { releaseSlot() }
  }

  submitImport(owner: Identity, rawId: string, key: string, retryOf: string | null = null, requestedOptions?: CsvImportOptions, sheetName?: string,
    requestedJsonOptions?: JsonImportOptions, requestedColumnTypes?: Record<string, ColumnType>) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const raw = this.db.getResource(owner.ownerKey, rawId)
    if (!raw || raw.kind !== 'raw' || raw.status !== 'ready' || !['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'json', 'jsonl', 'ndjson', 'parquet'].includes(raw.format)) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择可用的 CSV、TSV、Excel、ODS、JSON 或 Parquet 原文件')
    }
    const tableFile = ['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'parquet'].includes(raw.format)
    if (tableFile && sheetName !== undefined) throw new ServiceError(422, 'INVALID_SHEET', '所选文件没有工作表')
    if (!tableFile && (!sheetName || sheetName.length > 255 || /[\x00-\x1f\x7f]/.test(sheetName))) {
      throw new ServiceError(422, 'INVALID_SHEET', '请选择要导入的工作表')
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'import' || (JSON.parse(original.input_ids_json) as string[])[0] !== rawId) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与文件不匹配')
      }
    }
    let options: CsvImportOptions
    try { options = csvImportOptions(requestedOptions ?? (raw.format === 'tsv' ? { ...csvImportOptions(undefined), delimiter: '\t' } : undefined)) }
    catch { throw new ServiceError(422, 'INVALID_CSV_OPTIONS', 'CSV 解析配置无效') }
    let jsonOptions: JsonImportOptions
    try { jsonOptions = jsonImportOptions(requestedJsonOptions) }
    catch { throw new ServiceError(422, 'INVALID_JSON_OPTIONS', 'JSON 导入配置无效') }
    let selectedTypes: Record<string, ColumnType>
    try { selectedTypes = columnTypes(requestedColumnTypes) }
    catch { throw new ServiceError(422, 'INVALID_COLUMN_TYPES', '字段类型配置无效') }
    const spec = JSON.stringify({ operation: 'import', rawResourceId: rawId, rawHash: raw.content_hash, retryOf, csv: options, json: jsonOptions,
      sheetName: sheetName ?? null, columnTypes: selectedTypes })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const priorRetry = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (priorRetry) return { job: jobDto(priorRetry), resource: this.getResource(owner, (JSON.parse(priorRetry.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) {
      throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多，请稍后提交')
    }
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) {
      throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多，请稍后重试')
    }
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(raw.byte_size ?? 0, 1) * 5
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const sourceOriginalName = typeof metadata(raw).originalName === 'string' ? metadata(raw).originalName as string : raw.name
    const dataset: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: sheetName ? `${raw.name} · ${sheetName}` : raw.name,
      format: 'csv', group_id: datasetId, version: 1, source_ids_json: JSON.stringify([rawId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: sourceOriginalName, indexState: 'building', profileState: 'pending', parseConfig: ['json', 'jsonl', 'ndjson'].includes(raw.format) ? jsonOptions : options,
        sheetName: sheetName ?? null, columnTypes: selectedTypes }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'import', name: `导入 ${raw.name}`,
      state: 'queued', retry_of: retryOf, input_ids_json: JSON.stringify([rawId]), spec_json: spec, spec_hash: specHash,
      engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: null, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(dataset, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => {
        process.stderr.write(`导入调度失败：${error instanceof Error ? error.message : '未知错误'}\n`)
      }).finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(dataset) }
  }

  submitFilter(owner: Identity, sourceId: string, columnId: string, mode: 'equals' | 'contains', value: string, key: string,
    retryOf: string | null = null, plan?: ViewPlan) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    const columnIndex = /^c_(\d+)$/.exec(columnId)
    if (!plan && (!columnIndex || Number(columnIndex[1]) >= (source.column_count ?? 0) || !['equals', 'contains'].includes(mode) ||
      typeof value !== 'string' || value.length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))) {
      throw new ServiceError(422, 'INVALID_FILTER', '筛选字段或条件无效')
    }
    if (plan) {
      try { validateViewPlan(plan, source.column_count ?? 0) }
      catch (error) { if (error instanceof ViewPlanError) throw new ServiceError(422, 'INVALID_VIEW_PLAN', error.message); throw error }
    }
    const spec = JSON.stringify(plan ? { operation: 'filter.plan', sourceId, sourceHash: source.content_hash, plan, retryOf } :
      { operation: 'filter.literal', sourceId, sourceHash: source.content_hash, columnId, mode, value, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'filter' || (JSON.parse(original.input_ids_json) as string[])[0] !== sourceId) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与数据集不匹配')
      }
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(source.byte_size ?? 0, 1) * 3
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const displayName = `${source.name.slice(0, 220)} · 筛选`
    const dataset: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: displayName, format: 'csv',
      group_id: datasetId, version: 1, source_ids_json: JSON.stringify([sourceId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${source.name.slice(0, 220)}-filtered.csv`, indexState: 'building', profileState: 'pending', filter: plan ?? { columnId, mode, value } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'filter', name: `筛选 ${source.name.slice(0, 220)}`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify([sourceId]), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(dataset, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(dataset) }
  }

  submitFilterPlan(owner: Identity, sourceId: string, plan: ViewPlan, key: string, retryOf: string | null = null) {
    return this.submitFilter(owner, sourceId, 'c_0', 'equals', '', key, retryOf, plan)
  }

  submitClean(owner: Identity, sourceId: string, columnId: string,
    mode: 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'replace' | 'fill-empty' | 'nfc' | 'nfkc' | 'date-iso', key: string,
    retryOf: string | null = null, find = '', replacement = '', dateFormat: DateInputFormat = 'yyyy-MM-dd', plan?: CleanPlan) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (plan) {
      try { validateCleanPlan(plan, metadata(source).headers as string[]) }
      catch (error) { throw new ServiceError(422, 'INVALID_CLEAN_PLAN', error instanceof Error ? error.message : '清洗步骤无效') }
      if (hasScopedFill(plan) && this.db.getJob(owner.ownerKey, source.producer_job_id ?? '')?.kind !== 'import' &&
        !metadata(source).cellStateReport && metadata(source).cellStateLineage !== true && !this.trialMode) {
        throw new ServiceError(422, 'CELL_STATE_UNAVAILABLE', '该数据集没有可追溯的空值来源')
      }
    }
    const columnIndex = /^c_(\d+)$/.exec(columnId)
    if ((!plan && (!columnIndex || Number(columnIndex[1]) >= (source.column_count ?? 0))) ||
      !['trim', 'squeeze', 'squeeze0', 'lower', 'upper', 'replace', 'fill-empty', 'nfc', 'nfkc', 'date-iso'].includes(mode) ||
      !['yyyy-MM-dd', 'yyyy/MM/dd', 'dd/MM/yyyy', 'MM/dd/yyyy'].includes(dateFormat) ||
      typeof find !== 'string' || typeof replacement !== 'string' || find.length > 512 || replacement.length > 512 ||
      (mode === 'replace' && find.length === 0) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(find + replacement)) {
      throw new ServiceError(422, 'INVALID_CLEAN_RULE', '清洗字段或规则无效')
    }
    const spec = JSON.stringify({ operation: plan ? 'clean.plan' : 'clean.column', sourceId, sourceHash: source.content_hash, columnId, mode, find, replacement, dateFormat, plan, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'clean' || (JSON.parse(original.input_ids_json) as string[])[0] !== sourceId) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与数据集不匹配')
      }
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(source.byte_size ?? 0, 1) * 3
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const dataset: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: `${source.name.slice(0, 220)} · 清洗`, format: 'csv',
      group_id: datasetId, version: 1, source_ids_json: JSON.stringify([sourceId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${source.name.slice(0, 220)}-cleaned.csv`, indexState: 'building', profileState: 'pending', clean: plan ?? { columnId, mode, find, replacement, dateFormat } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'clean', name: `清洗 ${source.name.slice(0, 220)}`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify([sourceId]), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(dataset, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(dataset) }
  }

  submitCleanPlan(owner: Identity, sourceId: string, plan: CleanPlan, key: string, retryOf: string | null = null) {
    return this.submitClean(owner, sourceId, 'c_0', 'trim', key, retryOf, '', '', 'yyyy-MM-dd', plan)
  }

  private async cleanCellStatePath(owner: Identity, source: ResourceRow, plan: CleanPlan) {
    if (metadata(source).cellStateReport) return this.cellStateReportPath(owner, source)
    if (metadata(source).cellStateLineage === true) return undefined
    if (!hasScopedFill(plan) && !metadata(source).jsonConversionReport) return undefined
    const producer = source.producer_job_id ? this.db.getJob(owner.ownerKey, source.producer_job_id) : null
    if (!this.trialMode && producer?.kind !== 'import') {
      if (hasScopedFill(plan)) throw new ServiceError(422, 'CELL_STATE_UNAVAILABLE', '该数据集没有可追溯的空值来源')
      return undefined
    }
    return metadata(source).jsonConversionReport ? (await this.jsonConversionReportPath(owner, source.id)).path : undefined
  }

  private async sourceCellStatePath(owner: Identity, source: ResourceRow) {
    if (metadata(source).cellStateReport) return this.cellStateReportPath(owner, source)
    if (metadata(source).jsonConversionReport) return (await this.jsonConversionReportPath(owner, source.id)).path
    return undefined
  }

  private async cellStateReportPath(owner: Identity, source: ResourceRow) {
    const report = metadata(source).cellStateReport as { file: string; rows: number; bytes: number; sha256: string } | undefined
    if (!report || report.file !== 'cell-states.csv' || !source.storage_relpath) {
      throw new ServiceError(422, 'CELL_STATE_UNAVAILABLE', '空值来源清单不可用')
    }
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, join(dirname(source.storage_relpath), report.file))
    const digest = await digestFile(path)
    if (digest.bytes !== report.bytes || digest.sha256 !== report.sha256) {
      throw new ServiceError(500, 'CELL_STATE_CHANGED', '空值来源清单校验失败')
    }
    return path
  }

  listDatasetVersions(owner: Identity, sourceId: string) {
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset') throw new ServiceError(404, 'DATASET_NOT_FOUND', '数据集不存在')
    return this.db.listResourceVersions(owner.ownerKey, source.group_id).map(resourceDto)
  }

  submitCellEdits(owner: Identity, sourceId: string, expectedRevision: string, patches: CellPatch[], key: string,
    retryOf: string | null = null) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.content_hash || !source.storage_relpath) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (source.content_hash !== expectedRevision) throw new ServiceError(409, 'REVISION_CHANGED', '源数据版本已变化，请重新检查修正草稿')
    let edits: ReturnType<typeof validateCellPatches>
    try { edits = validateCellPatches(sourceId, patches, source.row_count ?? 0, source.column_count ?? 0) }
    catch (error) { throw new ServiceError(422, 'INVALID_CELL_PATCH', error instanceof Error ? error.message : '单元格修正无效') }
    const spec = JSON.stringify({ operation: 'cell.edit', sourceId, sourceHash: source.content_hash, patches, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'edit' || original.input_ids_json !== JSON.stringify([sourceId])) throw new ServiceError(422, 'INVALID_RETRY', '原修正任务与数据集不匹配')
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    const versions = this.db.listResourceVersions(owner.ownerKey, source.group_id)
    const latestUsable = versions.find((item) => item.status === 'ready' || item.status === 'building')
    if (latestUsable?.id !== source.id) throw new ServiceError(409, 'VERSION_CONFLICT', '已有更新的数据版本，请先打开最新版本')
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(source.byte_size ?? 0, 1) * 3
    this.reserve(owner, reservedBytes)
    const now = Date.now(), jobId = `job_${randomUUID()}`, datasetId = `res_${randomUUID()}`
    const dataset: ResourceRow = { id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building',
      name: `${source.name.slice(0, 200)} · 修正版本 ${versions[0]!.version + 1}`, format: 'csv', group_id: source.group_id,
      version: versions[0]!.version + 1, source_ids_json: JSON.stringify([sourceId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${datasetId}.csv`, indexState: 'building', profileState: 'pending',
        edit: { sourceId, patchCount: edits.length, changedCells: null } }), created_at: now, updated_at: now, deleted_at: null }
    const job: JobRow = { id: jobId, owner_key: owner.ownerKey, kind: 'edit', name: `修正 ${source.name.slice(0, 220)}`,
      state: 'queued', retry_of: retryOf, input_ids_json: JSON.stringify([sourceId]), spec_json: spec,
      spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId), created_at: now,
      started_at: null, finished_at: null, updated_at: now }
    try { this.db.createImport(dataset, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain(); this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(dataset) }
  }

  async previewCleanPlan(owner: Identity, sourceId: string, plan: CleanPlan) {
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    const headers = metadata(source).headers as string[]
    try { validateCleanPlan(plan, headers) }
    catch (error) { throw new ServiceError(422, 'INVALID_CLEAN_PLAN', error instanceof Error ? error.message : '清洗步骤无效') }
    if (this.activeCleanPreviews >= 2) throw new ServiceError(429, 'CLEAN_PREVIEW_BUSY', '同时运行的清洗预览过多')
    this.activeCleanPreviews += 1
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), 90_000)
    deadline.unref()
    let directory: string | null = null
    try {
      const relative = join('owners', owner.workspaceId, 'previews')
      await ensureDurableDirectory(this.dataDir, relative)
      directory = await mkdtemp(join(this.dataDir, relative, 'clean-'))
      const inputPath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      const samplePath = join(directory, 'sample.csv')
      const sampled = await writeSqlInputSample(inputPath, samplePath, headers.length, abort.signal)
      const outputPath = join(directory, 'output.csv')
      const statePath = await this.cleanCellStatePath(owner, source, plan)
      const result = await writeCleanPlan(samplePath, outputPath, plan, headers, abort.signal, undefined, statePath, sampled.rows)
      if ((await stat(outputPath)).size > 64 * 1024 * 1024) throw new CleanPlanError('清洗样本结果超过 64 MiB')
      return { ...(await readSqlPreview(outputPath, abort.signal)), scope: '输入的前 200 条记录', sampledRows: sampled.rows,
        sourceRows: source.row_count, steps: result.steps }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(abort.signal.aborted ? 504 : 422, 'CLEAN_PREVIEW_FAILED',
        error instanceof CleanPlanError ? error.message : abort.signal.aborted ? '清洗预览超过 90 秒' : '清洗预览失败，请检查规则和样本数据')
    } finally {
      clearTimeout(deadline)
      if (directory) await rm(directory, { recursive: true, force: true })
      this.activeCleanPreviews -= 1
    }
  }

  submitDedupe(owner: Identity, sourceId: string, columnIds: string[], key: string, retryOf: string | null = null) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (!Array.isArray(columnIds) || columnIds.length < 1 || columnIds.length > 16 || new Set(columnIds).size !== columnIds.length ||
      columnIds.some((id) => { const match = /^c_(\d+)$/.exec(id); return !match || Number(match[1]) >= (source.column_count ?? 0) })) {
      throw new ServiceError(422, 'INVALID_DEDUPE_KEYS', '请选择 1 至 16 个不同的有效字段')
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'dedup' || original.input_ids_json !== JSON.stringify([sourceId])) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与数据集不匹配')
      }
    }
    const spec = JSON.stringify({ operation: 'dedup.first', sourceId, sourceHash: source.content_hash, columnIds, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(source.byte_size ?? 0, 1) * 5
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const dataset: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: `${source.name.slice(0, 220)} · 去重`, format: 'csv',
      group_id: datasetId, version: 1, source_ids_json: JSON.stringify([sourceId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${source.name.slice(0, 220)}-deduped.csv`, indexState: 'building', profileState: 'pending', dedup: { columnIds, keep: 'first' } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'dedup', name: `去重 ${source.name.slice(0, 220)}`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify([sourceId]), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(dataset, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(dataset) }
  }

  async preflightExport(owner: Identity, sourceId: string, format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet',
    safeText: boolean, textOptions?: TextExportOptions, jsonOptions?: JsonExportOptions,
    workbook?: ExportWorkbook, scope?: ExportScope) {
    if (!['csv','tsv','xlsx','ods','json','jsonl','parquet'].includes(format) || typeof safeText !== 'boolean') {
      throw new ServiceError(422, 'INVALID_EXPORT', '导出格式或安全策略无效')
    }
    const sourceIds = workbook?.sourceIds ?? [sourceId]
    if (workbook && (!['xlsx','ods'].includes(format) || scope && sourceIds.length !== 1 || sourceIds[0] !== sourceId || sourceIds.length < 1 || sourceIds.length > 20 ||
      new Set(sourceIds).size !== sourceIds.length || workbook.sheetNames.length !== sourceIds.length ||
      workbook.sheetNames.some((name) => typeof name !== 'string' || !name.trim() || name.length > 31 ||
        /[\\/*\[\]:?\x00-\x1f]/u.test(name) || name.startsWith("'") || name.endsWith("'")) ||
      new Set(workbook.sheetNames.map((name) => name.toLocaleLowerCase())).size !== workbook.sheetNames.length ||
      workbook.rowsPerSheet !== undefined && (sourceIds.length !== 1 || !Number.isSafeInteger(workbook.rowsPerSheet) ||
        workbook.rowsPerSheet < 1 || workbook.rowsPerSheet > 1_048_575))) {
      throw new ServiceError(422, 'INVALID_WORKBOOK', '工作簿输入或工作表名称无效')
    }
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((item) => !item || item.kind !== 'dataset' || item.status !== 'ready' || !item.storage_relpath || !item.content_hash)) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    const ready = sources as ResourceRow[]
    if (scope) {
      try { validateExportScope(scope, ready[0]!.row_count ?? 0, ready[0]!.column_count ?? 0) }
      catch (error) { throw new ServiceError(422, 'INVALID_EXPORT_SCOPE', error instanceof Error ? error.message : '导出范围无效') }
    }
    try {
      if (textOptions) {
        if (!['csv','tsv'].includes(format)) throw new ExportConfigError('当前格式不支持文本配置')
        validateTextExportOptions(textOptions)
      }
      if (jsonOptions) {
        if (!['json','jsonl'].includes(format)) throw new ExportConfigError('当前格式不支持 JSON 配置')
        validateJsonExportOptions(jsonOptions, ready[0]!.column_count ?? 0)
      }
    } catch (error) { throw new ServiceError(422, 'INVALID_EXPORT_OPTIONS', error instanceof Error ? error.message : '导出配置无效') }
    if (this.activeExportPreflights >= 1) throw new ServiceError(429, 'EXPORT_PREFLIGHT_BUSY', '已有导出预检正在运行')
    this.activeExportPreflights += 1
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), 10 * 60 * 1000)
    deadline.unref()
    const notes: string[] = []
    let scannedRows = 0, nullConversions = 0, formulaCandidates = 0
    let problem: string | null = null
    try {
      for (const item of ready) {
        const rows = scope ? scope.endRow - scope.startRow + 1 : item.row_count ?? 0
        const columns = scope ? scope.columnIds.length : item.column_count ?? 0
        if (workbook?.rowsPerSheet && rows > workbook.rowsPerSheet * 20) {
          problem = `${item.name} 需要超过 20 张工作表；请增大每张工作表的行数或选择文本格式`
          break
        }
        if ((format === 'xlsx' && (rows > (workbook?.rowsPerSheet ? workbook.rowsPerSheet * 20 : 1_048_575) || columns > 16_384)) ||
          (format === 'ods' && (rows > (workbook?.rowsPerSheet ? workbook.rowsPerSheet * 20 : 1_048_575) || columns > 1_024))) {
          problem = `${item.name} 超过 ${format.toUpperCase()} 的行列限制（已计入表头）`
          break
        }
        const inputPath = await checkedResourcePath(this.dataDir, owner.workspaceId, item.storage_relpath!)
        if (format === 'xlsx' || format === 'ods') {
          const inspected = await scanWorkbookCells(inputPath, abort.signal, scope)
          if (inspected.rows !== item.row_count || inspected.columns !== item.column_count) throw new ExportScopeError('输入行列数与资源记录不一致')
          scannedRows += scope ? rows : inspected.rows
        } else if (format === 'json' || format === 'jsonl') {
          const inspected = await inspectJsonExport(inputPath, jsonOptions ?? { emptyAsNull: false, types: {} }, scope, abort.signal)
          if (inspected.rows !== item.row_count || inspected.columns !== item.column_count) throw new ExportConfigError('输入行列数与资源记录不一致')
          scannedRows += inspected.checkedRows
          nullConversions += inspected.nullConversions
        } else if (format === 'csv' || format === 'tsv') {
          const inspected = await inspectTextExport(inputPath, textOptions ?? { encoding: 'utf-8', delimiter: format === 'tsv' ? '\t' : ',',
            quote: '"', newline: 'lf', bom: false }, scope, abort.signal)
          if (inspected.rows !== item.row_count || inspected.columns !== item.column_count) throw new ExportConfigError('输入行列数与资源记录不一致')
          scannedRows += inspected.checkedRows
          formulaCandidates += inspected.formulaCandidates
        }
      }
      if (format === 'xlsx' || format === 'ods') notes.push('所有工作表按文本写入；已检查选定范围内每个单元格的长度。')
      if (workbook?.rowsPerSheet) notes.push(`将创建 ${exportSheetNames(workbook, scope ? scope.endRow - scope.startRow + 1 : ready[0]!.row_count ?? 0).length} 张工作表。`)
      if (format === 'parquet') notes.push('所有字段在 Parquet 中写为字符串；编号、长整数和原文本不会转为数值。')
      if (format === 'json' || format === 'jsonl') notes.push(`已检查 ${scannedRows} 行的字段类型转换；${nullConversions} 个空文本将写为 null。`)
      if (format === 'csv' || format === 'tsv') notes.push(safeText
        ? `逐行检查了编码；${formulaCandidates} 个可能被表格软件解释为公式的值将在导出副本中加文本前缀。`
        : `逐行检查了编码；${formulaCandidates} 个值可能被表格软件解释为公式，当前未启用文本保护。`)
      return { ready: problem === null, problem, rows: scope ? scope.endRow - scope.startRow + 1 : ready.reduce((sum, item) => sum + (item.row_count ?? 0), 0),
        columns: scope ? scope.columnIds.length : Math.max(...ready.map((item) => item.column_count ?? 0)), scannedRows,
        sources: ready.map((item) => ({ id: item.id, name: item.name, hash: item.content_hash, rows: item.row_count, columns: item.column_count })),
        notes }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(abort.signal.aborted ? 504 : 422, 'EXPORT_PREFLIGHT_FAILED',
        error instanceof ExportScopeError || error instanceof ExportConfigError ? error.message :
          abort.signal.aborted ? '导出预检超过 10 分钟' : '导出预检失败，请检查输入文件')
    } finally { clearTimeout(deadline); this.activeExportPreflights -= 1 }
  }

  submitExport(owner: Identity, sourceId: string, format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet' | 'zip', safeText: boolean, key: string, retryOf: string | null = null, report = false,
    textOptions?: TextExportOptions, jsonOptions?: JsonExportOptions, workbook?: ExportWorkbook, scope?: ExportScope,
    outputName?: string) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    const inputIds = workbook?.sourceIds ?? [sourceId]
    if (workbook && (!['xlsx', 'ods'].includes(format) || report || scope && inputIds.length !== 1 || inputIds.length < 1 || inputIds.length > 20 ||
      inputIds[0] !== sourceId || new Set(inputIds).size !== inputIds.length ||
      !Array.isArray(workbook.sheetNames) || workbook.sheetNames.length !== inputIds.length ||
      workbook.sheetNames.some((name) => typeof name !== 'string' || !name.trim() || name.length > 31 ||
        /[\\/*\[\]:?\x00-\x1f]/.test(name) || name.startsWith("'") || name.endsWith("'")) ||
      new Set(workbook.sheetNames.map((name) => name.toLocaleLowerCase())).size !== workbook.sheetNames.length ||
      workbook.rowsPerSheet !== undefined && (inputIds.length !== 1 || !Number.isSafeInteger(workbook.rowsPerSheet) ||
        workbook.rowsPerSheet < 1 || workbook.rowsPerSheet > 1_048_575))) {
      throw new ServiceError(422, 'INVALID_WORKBOOK', '工作簿输入或工作表名称无效')
    }
    const sources = inputIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((item) => !item || item.kind !== 'dataset' || item.status !== 'ready' || !item.storage_relpath || !item.content_hash)) {
      throw new ServiceError(422, 'INVALID_INPUT', '工作簿包含不可用的数据集')
    }
    const readySources = sources as ResourceRow[]
    if (scope) {
      if (workbook && inputIds.length !== 1 || report) throw new ServiceError(422, 'INVALID_EXPORT_SCOPE', '当前导出方式不支持行列范围')
      try { validateExportScope(scope, source.row_count ?? 0, source.column_count ?? 0) }
      catch (error) { throw new ServiceError(422, 'INVALID_EXPORT_SCOPE', error instanceof Error ? error.message : '导出范围无效') }
    }
    if (!['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet', 'zip'].includes(format) || typeof safeText !== 'boolean' ||
      (report && (format !== 'zip' && format !== 'xlsx' || !metadata(source).compareSummary)) || !report && format === 'zip') {
      throw new ServiceError(422, 'INVALID_EXPORT', '导出格式或安全策略无效')
    }
    if (outputName !== undefined && (report || typeof outputName !== 'string' || !outputName.trim() ||
      outputName.length > 120 || /[\\/\x00-\x1f\x7f]/u.test(outputName) || outputName.trim() === '.' || outputName.trim() === '..')) {
      throw new ServiceError(422, 'INVALID_EXPORT_NAME', '导出文件名无效，请输入 1 至 120 个字符且不要包含路径分隔符')
    }
    try {
      if (textOptions) {
        if (!['csv','tsv'].includes(format) || report) throw new ExportConfigError('当前格式不支持文本配置')
        validateTextExportOptions(textOptions)
      }
      if (jsonOptions) {
        if (!['json','jsonl'].includes(format) || report) throw new ExportConfigError('当前格式不支持 JSON 配置')
        validateJsonExportOptions(jsonOptions, source.column_count ?? 0)
      }
    } catch (error) { throw new ServiceError(422, 'INVALID_EXPORT_OPTIONS', error instanceof Error ? error.message : '导出配置无效') }
    if (!report && readySources.some((item) => (format === 'xlsx' && ((scope ? scope.endRow - scope.startRow + 1 : item.row_count ?? 0) > (workbook?.rowsPerSheet ? workbook.rowsPerSheet * 20 : 1_048_575) || (scope ? scope.columnIds.length : item.column_count ?? 0) > 16_384)) ||
      (format === 'ods' && ((scope ? scope.endRow - scope.startRow + 1 : item.row_count ?? 0) > (workbook?.rowsPerSheet ? workbook.rowsPerSheet * 20 : 1_048_575) || (scope ? scope.columnIds.length : item.column_count ?? 0) > 1_024)))) {
      throw new ServiceError(422, 'WORKBOOK_LIMIT', '数据超过工作簿行列或 20 张工作表的限制，请调整拆分行数或选择 CSV/TSV')
    }
    const spec = JSON.stringify({ operation: report ? 'compare.report' : 'export.text', sourceId, sourceHash: source.content_hash, format,
      safeText: report ? true : safeText, report, textOptions, jsonOptions, workbook, scope, outputName,
      sourceHashes: workbook ? readySources.map((item) => item.content_hash) : undefined, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'export' || original.input_ids_json !== JSON.stringify(inputIds)) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与数据集不匹配')
      }
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(readySources.reduce((sum, item) => sum + (item.byte_size ?? 0), 0), 1) * (report ? 10 : 3)
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const exportId = `res_${randomUUID()}`
    const customBase = outputName?.trim().replace(new RegExp(`\\.${format}$`, 'iu'), '')
    const fileName = `${customBase || (workbook && workbook.sourceIds.length > 1 ? '多数据集工作簿' : source.name.replace(/\.[^.]+$/, '').slice(0, report ? 205 : 220))}${report ? ' · 核对报告' : ''}.${format}`
    const output: ResourceRow = {
      id: exportId, owner_key: owner.ownerKey, kind: 'export', status: 'building', name: fileName, format,
      group_id: exportId, version: 1, source_ids_json: JSON.stringify(inputIds), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: fileName, safeText: report ? true : safeText, scope: scope ?? 'full', sourceRevision: source.content_hash,
        textOptions, jsonOptions, sheetNames: workbook ? exportSheetNames(workbook,
          scope ? scope.endRow - scope.startRow + 1 : readySources.reduce((sum, item) => sum + (item.row_count ?? 0), 0)) : undefined,
        reportType: report ? 'compare' : undefined }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'export', name: `导出 ${source.name.slice(0, 220)}`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify(inputIds), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: exportId, rowsIn: readySources.reduce((sum, item) => sum + (item.row_count ?? 0), 0), rowsOut: null,
        scope: scope ? 'selected' : 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId: exportId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  submitCombine(owner: Identity, sourceIds: string[], mode: 'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error' | 'relation' | 'set' | 'reshape', key: string,
    retryOf: string | null = null, relationConfig?: RelationConfig, setConfig?: SetConfig, reshapeConfig?: ReshapeConfig) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    if (!Array.isArray(sourceIds) || sourceIds.length < (mode === 'reshape' ? 1 : 2) || sourceIds.length > (mode === 'reshape' ? 1 : 20) || new Set(sourceIds).size !== sourceIds.length ||
      !['strict', 'union', 'intersection', 'horizontal-pad', 'horizontal-error', 'relation', 'set', 'reshape'].includes(mode) ||
      (mode === 'relation' || mode === 'set') && sourceIds.length !== 2) throw new ServiceError(422, 'INVALID_COMBINE', '请选择 2 至 20 个不同的数据集和合并方式')
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((item) => !item || item.kind !== 'dataset' || item.status !== 'ready' || !item.content_hash || !item.storage_relpath)) {
      throw new ServiceError(422, 'INVALID_INPUT', '合并输入必须是本人可用的数据集')
    }
    const readySources = sources as ResourceRow[]
    const headers = readySources.map((source) => metadata(source).headers as string[])
    if (mode === 'strict' && headers.some((row) => JSON.stringify(row) !== JSON.stringify(headers[0]))) {
      throw new ServiceError(422, 'SCHEMA_MISMATCH', '严格合并要求所有数据集的字段名及顺序完全一致')
    }
    if (mode !== 'strict' && headers.some((row) => row.some((name) => !name) || new Set(row).size !== row.length)) {
      throw new ServiceError(422, 'AMBIGUOUS_COLUMNS', '按字段名合并要求每个输入的字段名非空且不重复')
    }
    const allColumns = new Set(headers.flat())
    if (allColumns.size > 4096) throw new ServiceError(422, 'TOO_MANY_COLUMNS', '合并结果超过 4096 列上限')
    const unionMissingFields = mode === 'union' ? headers.map((row) => [...allColumns].filter((name) => !row.includes(name))) : []
    const missingCells = unionMissingFields.reduce((sum, fields, index) => sum + fields.length * (readySources[index]?.row_count ?? 0), 0)
    const maximumRows = Math.max(...readySources.map((source) => source.row_count ?? 0))
    const horizontalMissingCells = mode === 'horizontal-pad' ? headers.reduce((sum, row, index) =>
      sum + row.length * (maximumRows - (readySources[index]?.row_count ?? 0)), 0) : 0
    if (!Number.isSafeInteger(missingCells + horizontalMissingCells) || missingCells + horizontalMissingCells > 10_000_000) {
      throw new ServiceError(422, 'MISSING_STATE_LIMIT', '合并需要标记的补空位置超过 1000 万处，请先筛选输入或改用不补空的方式')
    }
    if (mode === 'intersection' && !headers[0]!.some((name) => headers.slice(1).every((row) => row.includes(name)))) {
      throw new ServiceError(422, 'NO_COMMON_COLUMNS', '所选数据集没有共同字段')
    }
    if (mode.startsWith('horizontal')) {
      if (headers.reduce((sum, row) => sum + row.length, 0) > 4096) throw new ServiceError(422, 'TOO_MANY_COLUMNS', '横向拼接超过 4096 列')
      if (mode === 'horizontal-error' && readySources.some((source) => source.row_count !== readySources[0]!.row_count)) {
        throw new ServiceError(422, 'ROW_COUNT_MISMATCH', '所选数据集行数不同，请选择补空或调整输入')
      }
    }
    if (mode === 'relation') {
      try { validateRelationConfig(relationConfig!, headers[0]!.length, headers[1]!.length) }
      catch (error) { if (error instanceof RelationError) throw new ServiceError(422, 'INVALID_RELATION', error.message); throw error }
      if (headers[0]!.length + headers[1]!.length + 2 > 4096) throw new ServiceError(422, 'TOO_MANY_COLUMNS', '关联结果超过 4096 列')
    }
    if (mode === 'set') {
      try { validateSetConfig(setConfig!, headers[0]!, headers[1]!) }
      catch (error) { if (error instanceof SetOperationError) throw new ServiceError(422, 'INVALID_SET_OPERATION', error.message); throw error }
    }
    if (mode === 'reshape') {
      try { validateReshapeConfig(reshapeConfig!, headers[0]!, readySources[0]!.row_count ?? 0) }
      catch (error) { if (error instanceof ReshapeError) throw new ServiceError(422, 'INVALID_RESHAPE', error.message); throw error }
      if (reshapeConfig?.kind === 'split-column' && reshapeConfig.direction === 'columns' &&
        (readySources[0]!.row_count ?? 0) * reshapeConfig.maxParts > 10_000_000) {
        throw new ServiceError(422, 'MISSING_STATE_LIMIT', '分隔后最多可能补出超过 1000 万处空片段，请减少行数或分段上限')
      }
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'combine' || original.input_ids_json !== JSON.stringify(sourceIds)) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与合并输入不匹配')
      }
    }
    const spec = JSON.stringify({ operation: mode === 'relation' ? 'combine.relation' : mode === 'set' ? 'combine.set' : mode === 'reshape' ? 'reshape' : 'combine.rows', sourceIds,
      sourceHashes: readySources.map((source) => source.content_hash), mode, relationConfig, setConfig, reshapeConfig, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const multiplier = mode === 'reshape' && reshapeConfig?.kind === 'split-column' && reshapeConfig.direction === 'rows'
      ? Math.min(reshapeConfig.maxParts + 2, 34) : mode === 'relation' || mode === 'set' ? 5 : 3
    const largestRowDigits = String(readySources.reduce((sum, source) => sum + (source.row_count ?? 0), 0)).length
    const missingReportBytes = unionMissingFields.reduce((sum, fields, index) => sum + (readySources[index]?.row_count ?? 0) *
      fields.reduce((bytes, field) => bytes + 2 * largestRowDigits + Buffer.byteLength(field, 'utf8') + 64, 0), 0) +
      (mode === 'horizontal-pad' ? headers.reduce((sum, row, index) => sum +
        (maximumRows - (readySources[index]?.row_count ?? 0)) * row.reduce((bytes, field) =>
          bytes + 2 * largestRowDigits + Buffer.byteLength(field, 'utf8') + 72, 0), 0) : 0) +
      (mode === 'reshape' && reshapeConfig?.kind === 'split-column' && reshapeConfig.direction === 'columns'
        ? (readySources[0]?.row_count ?? 0) * reshapeConfig.maxParts *
          (2 * largestRowDigits + Buffer.byteLength(headers[0]?.[Number(reshapeConfig.columnId.slice(2))] ?? '', 'utf8') + 96) : 0)
    const reservedBytes = readySources.reduce((sum, source) => sum + (source.byte_size ?? 0), 0) * multiplier + missingReportBytes
    this.reserve(owner, Math.max(reservedBytes, 1))
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const name = mode === 'reshape' ? `${readySources[0]!.name.slice(0, 210)} · 重组` : `${readySources[0]!.name.slice(0, 210)} 等 ${readySources.length} 份 · ${mode === 'relation' ? '关联' : mode === 'set' ? '集合运算' : mode.startsWith('horizontal') ? '横向拼接' : '纵向合并'}`
    const output: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name, format: 'csv',
      group_id: datasetId, version: 1, source_ids_json: JSON.stringify(sourceIds), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${datasetId}.csv`, indexState: 'building', profileState: 'pending', combine: { mode, sourceIds } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const rowsIn = readySources.reduce((sum, source) => sum + (source.row_count ?? 0), 0)
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'combine', name: mode === 'reshape' ? `重组 ${readySources[0]!.name.slice(0, 220)}` : `${mode === 'relation' ? '关联' : mode === 'set' ? '集合运算' : mode.startsWith('horizontal') ? '横向拼接' : '纵向合并'} ${readySources.length} 份数据`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify(sourceIds), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, Math.max(reservedBytes, 1)); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes: Math.max(reservedBytes, 1) })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  async previewRelation(owner: Identity, sourceIds: string[], config: RelationConfig) {
    if (!Array.isArray(sourceIds) || sourceIds.length !== 2 || sourceIds[0] === sourceIds[1]) {
      throw new ServiceError(422, 'INVALID_RELATION_INPUT', '请选择两份不同的数据集')
    }
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((item) => !item || item.kind !== 'dataset' || item.status !== 'ready' || !item.storage_relpath || !item.content_hash)) {
      throw new ServiceError(422, 'INVALID_RELATION_INPUT', '关联输入必须是本人可用的数据集')
    }
    const [left, right] = sources as ResourceRow[]
    try { validateRelationConfig(config, left!.column_count ?? 0, right!.column_count ?? 0) }
    catch (error) { throw new ServiceError(422, 'INVALID_RELATION', error instanceof Error ? error.message : '关联规则无效') }
    const relative = join('owners', owner.workspaceId, 'previews')
    await ensureDurableDirectory(this.dataDir, relative)
    const directory = await mkdtemp(join(this.dataDir, relative, 'relation-'))
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    try {
      const leftPath = await checkedResourcePath(this.dataDir, owner.workspaceId, left!.storage_relpath!)
      const rightPath = await checkedResourcePath(this.dataDir, owner.workspaceId, right!.storage_relpath!)
      const result = await prepareRelation(leftPath, rightPath, join(directory, 'left.csv'), join(directory, 'right.csv'),
        join(directory, 'keys.sqlite'), config, left!.row_count ?? 0, right!.row_count ?? 0, abort.signal)
      let sample: Awaited<ReturnType<typeof sampleRelation>> | null = null
      let sampleWarning: string | null = null
      try { sample = await sampleRelation(leftPath, rightPath, config, metadata(left!).headers as string[],
        metadata(right!).headers as string[], abort.signal) }
      catch (error) {
        if (!(error instanceof RelationError)) throw error
        sampleWarning = error.message
      }
      return { ...result, sample, sampleWarning }
    } catch (error) {
      if (error instanceof RelationError) throw new ServiceError(422, 'RELATION_PREFLIGHT', error.message)
      throw error
    } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }) }
  }

  private validateCompareInputs(owner: Identity, leftId: string, rightId: string, config: CompareConfig) {
    const left = this.db.getResource(owner.ownerKey, leftId)
    const right = this.db.getResource(owner.ownerKey, rightId)
    if (!left || !right || left.kind !== 'dataset' || right.kind !== 'dataset' || left.status !== 'ready' || right.status !== 'ready' ||
      !left.storage_relpath || !right.storage_relpath || !left.content_hash || !right.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择两份本人可用的数据集')
    }
    const validColumn = (id: string, count: number) => { const match = /^c_(\d+)$/.exec(id); return Boolean(match && Number(match[1]) < count) }
    if (!config || !Array.isArray(config.leftKeyIds) || !Array.isArray(config.rightKeyIds) ||
      config.leftKeyIds.length < 1 || config.leftKeyIds.length > 4 || config.leftKeyIds.length !== config.rightKeyIds.length ||
      new Set(config.leftKeyIds).size !== config.leftKeyIds.length || new Set(config.rightKeyIds).size !== config.rightKeyIds.length ||
      config.leftKeyIds.some((id) => !validColumn(id, left.column_count ?? 0)) ||
      config.rightKeyIds.some((id) => !validColumn(id, right.column_count ?? 0)) ||
      !Array.isArray(config.fields) || config.fields.length < 1 || config.fields.length > 16 ||
      config.fields.some((field) => !field || !validColumn(field.leftColumnId, left.column_count ?? 0) ||
        !validColumn(field.rightColumnId, right.column_count ?? 0) || !['text', 'decimal', 'calendar-date', 'instant'].includes(field.mode) ||
        (field.mode === 'decimal' && (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(field.tolerance ?? '0') ||
          !/^(?:0(?:\.\d{1,18})?|1(?:\.0{1,18})?)$/.test(field.relativeTolerance ?? '0'))) ||
        (field.mode === 'calendar-date' && (!Number.isSafeInteger(field.dayTolerance ?? 0) || (field.dayTolerance ?? 0) < 0 || (field.dayTolerance ?? 0) > 365)) ||
        (field.mode === 'instant' && (!Number.isSafeInteger(field.timeToleranceSeconds ?? 0) ||
          (field.timeToleranceSeconds ?? 0) < 0 || (field.timeToleranceSeconds ?? 0) > 604800 ||
          field.leftTimeZone !== undefined && !validIanaTimeZone(field.leftTimeZone) ||
          field.rightTimeZone !== undefined && !validIanaTimeZone(field.rightTimeZone))) ||
        (field.mode === 'text' && (field.textTrim !== undefined && typeof field.textTrim !== 'boolean' ||
          field.textIgnoreCase !== undefined && typeof field.textIgnoreCase !== 'boolean' ||
          field.unicode !== undefined && !['none', 'NFC', 'NFKC'].includes(field.unicode)))) ||
      typeof config.trimKeys !== 'boolean' || typeof config.ignoreKeyCase !== 'boolean' ||
      [config.leftLabel, config.rightLabel].some((label) => label !== undefined &&
        (typeof label !== 'string' || !label.trim() || label.length > 100 || /[\x00-\x1f\x7f]/u.test(label))) ||
      config.emptyValuePolicy !== undefined && !['mode-default', 'match-both', 'error'].includes(config.emptyValuePolicy) ||
      config.parseFailurePolicy !== undefined && !['isolate', 'abort'].includes(config.parseFailurePolicy) ||
      [config.contextLeftIds, config.contextRightIds].some((ids, side) => ids !== undefined &&
        (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length ||
          ids.some((id) => !validColumn(id, side === 0 ? left.column_count ?? 0 : right.column_count ?? 0)))) ||
      config.duplicatePolicy !== undefined && !['isolate', 'abort', 'aggregate'].includes(config.duplicatePolicy) ||
      (config.duplicatePolicy === 'aggregate' && (!Array.isArray(config.aggregateMethods) ||
        config.aggregateMethods.length !== config.fields.length ||
        config.aggregateMethods.some((method) => !['sum', 'count'].includes(method)) ||
        config.fields.some((field) => field.mode !== 'decimal'))) ||
      (config.duplicatePolicy !== 'aggregate' && config.aggregateMethods !== undefined)) {
      throw new ServiceError(422, 'INVALID_COMPARE_CONFIG', '核对字段、键或十进制容差配置无效')
    }
    return { left, right }
  }

  submitComparePreflight(owner: Identity, leftId: string, rightId: string, config: CompareConfig, key: string) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const { left, right } = this.validateCompareInputs(owner, leftId, rightId, config)
    const spec = JSON.stringify({ operation: 'compare.preflight', leftId, rightId, leftHash: left.content_hash,
      rightHash: right.content_hash, config })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing) }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) {
      throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    }
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) {
      throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    }
    const reservedBytes = Math.max((left.byte_size ?? 0) + (right.byte_size ?? 0), 1) * 8
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'compare_preflight', name: `预检 ${left.name.slice(0, 95)} / ${right.name.slice(0, 95)}`,
      state: 'queued', retry_of: null, input_ids_json: JSON.stringify([leftId, rightId]), spec_json: spec, spec_hash: specHash,
      engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: null, rowsIn: (left.row_count ?? 0) + (right.row_count ?? 0), rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.insertJob(job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId: '', reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job) }
  }

  submitCompare(owner: Identity, leftId: string, rightId: string, config: CompareConfig, key: string, retryOf: string | null = null,
    preflightJobId: string | null = null) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const { left, right } = this.validateCompareInputs(owner, leftId, rightId, config)
    if (preflightJobId) {
      const preflight = this.db.getJob(owner.ownerKey, preflightJobId)
      const result = preflight && JSON.parse(preflight.summary_json) as { preflight?: {
        leftId: string; rightId: string; leftHash: string; rightHash: string; configHash: string; wouldAbort: boolean } }
      const checked = result?.preflight
      if (!preflight || preflight.kind !== 'compare_preflight' || preflight.state !== 'succeeded' || !checked ||
        checked.leftId !== leftId || checked.rightId !== rightId || checked.leftHash !== left.content_hash ||
        checked.rightHash !== right.content_hash || checked.configHash !== hash(JSON.stringify(config)) || checked.wouldAbort) {
        throw new ServiceError(409, 'PREFLIGHT_STALE', '全量预检与当前输入或规则不一致，请重新预检')
      }
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'compare' || original.input_ids_json !== JSON.stringify([leftId, rightId])) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与核对输入不匹配')
      }
    }
    const spec = JSON.stringify({ operation: 'compare.pairs', leftId, rightId, leftHash: left.content_hash, rightHash: right.content_hash,
      config, retryOf, preflightJobId })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max((left.byte_size ?? 0) + (right.byte_size ?? 0), 1) * 8
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const output: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: `核对结果 · ${left.name.slice(0, 95)} / ${right.name.slice(0, 95)}`,
      format: 'csv', group_id: datasetId, version: 1, source_ids_json: JSON.stringify([leftId, rightId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${datasetId}.csv`, indexState: 'building', profileState: 'pending', compare: { config } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'compare', name: `核对 ${left.name.slice(0, 95)} / ${right.name.slice(0, 95)}`,
      state: 'queued', retry_of: retryOf, input_ids_json: JSON.stringify([leftId, rightId]), spec_json: spec,
      spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: (left.row_count ?? 0) + (right.row_count ?? 0), rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  async previewSql(owner: Identity, sourceIds: string[], sql: string, parameters?: SqlParameters) {
    if (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 4 || new Set(sourceIds).size !== sourceIds.length) {
      throw new ServiceError(422, 'INVALID_SQL_INPUT', '请选择 1 至 4 份不同的数据集')
    }
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((item) => !item || item.kind !== 'dataset' || item.status !== 'ready' || !item.storage_relpath || !item.content_hash)) {
      throw new ServiceError(422, 'INVALID_SQL_INPUT', 'SQL 样本输入必须是本人可用的数据集')
    }
    const readySources = sources as ResourceRow[]
    const headers = readySources.map((source) => metadata(source).headers as string[])
    if (headers.some((names) => !Array.isArray(names) || names.some((name) => !name) || new Set(names).size !== names.length)) {
      throw new ServiceError(422, 'AMBIGUOUS_COLUMNS', 'SQL 输入的字段名必须非空且不重复')
    }
    const aliases = sourceIds.map((_, index) => `t${index + 1}`)
    let normalizedSql: string
    try { normalizedSql = validateReadOnlySql(bindSqlParameters(sql, parameters), aliases) }
    catch (error) { throw new ServiceError(422, 'INVALID_SQL', error instanceof SqlValidationError || error instanceof SqlParameterError ? error.message : 'SQL 不受支持') }
    if (this.activeSqlPreviews >= 2) throw new ServiceError(429, 'SQL_PREVIEW_BUSY', '同时运行的 SQL 样本预览过多')
    this.activeSqlPreviews += 1
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), 90_000)
    deadline.unref()
    let directory: string | null = null
    try {
      const relative = join('owners', owner.workspaceId, 'previews')
      await ensureDurableDirectory(this.dataDir, relative)
      directory = await mkdtemp(join(this.dataDir, relative, 'sql-'))
      const sampledRows: number[] = []
      const inputPaths: string[] = []
      for (let index = 0; index < readySources.length; index += 1) {
        const source = readySources[index]!
        const inputPath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath!)
        const samplePath = join(directory, `t${index + 1}.csv`)
        const sampled = await writeSqlInputSample(inputPath, samplePath, headers[index]!.length, abort.signal)
        sampledRows.push(sampled.rows)
        await writeFile(`${samplePath}.pschema.json`, JSON.stringify({ fields: Object.fromEntries(headers[index]!.map((name) => [name, 'String'])), metadata: null }),
          { flag: 'wx', mode: 0o600 })
        inputPaths.push(samplePath)
      }
      const outputPath = join(directory, 'preview.csv')
      const boundedSql = `SELECT * FROM (${normalizedSql.replace(/;\s*$/u, '')}) AS qsv_preview LIMIT 201`
      await runQsv(this.binary, ['sqlp', '--cache-schema', '--format', 'csv', '--output', outputPath, ...inputPaths, boundedSql],
        abort.signal, 256 * 1024, 90_000)
      if ((await stat(outputPath)).size > 64 * 1024 * 1024) throw new SqlPreviewError('SQL 样本结果超过 64 MiB 预览预算')
      const preview = await readSqlPreview(outputPath, abort.signal)
      return { ...preview, scope: '每份输入的前 200 条记录', sampledRows,
        sourceRows: readySources.map((source) => source.row_count), resultLimit: 200 }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(abort.signal.aborted ? 504 : 422, 'SQL_PREVIEW_FAILED',
        error instanceof SqlPreviewError ? error.message : abort.signal.aborted ? 'SQL 样本预览超过 90 秒' : 'SQL 样本预览失败，请检查查询和字段')
    } finally {
      clearTimeout(deadline)
      if (directory) await rm(directory, { recursive: true, force: true })
      this.activeSqlPreviews -= 1
    }
  }

  submitSql(owner: Identity, sourceIds: string[], sql: string, key: string, retryOf: string | null = null, parameters?: SqlParameters) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    if (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 4 || new Set(sourceIds).size !== sourceIds.length) {
      throw new ServiceError(422, 'INVALID_SQL_INPUT', '请选择 1 至 4 份不同的数据集')
    }
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((item) => !item || item.kind !== 'dataset' || item.status !== 'ready' || !item.storage_relpath || !item.content_hash)) {
      throw new ServiceError(422, 'INVALID_SQL_INPUT', 'SQL 输入必须是本人可用的数据集')
    }
    const readySources = sources as ResourceRow[]
    if (readySources.some((source) => { const headers = metadata(source).headers as string[];
      return !Array.isArray(headers) || headers.some((name) => !name) || new Set(headers).size !== headers.length })) {
      throw new ServiceError(422, 'AMBIGUOUS_COLUMNS', 'SQL 输入的字段名必须非空且不重复')
    }
    let normalizedSql: string
    try { normalizedSql = validateReadOnlySql(bindSqlParameters(sql, parameters), sourceIds.map((_, index) => `t${index + 1}`)) }
    catch (error) { throw new ServiceError(422, 'INVALID_SQL', error instanceof SqlValidationError || error instanceof SqlParameterError ? error.message : 'SQL 不受支持') }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'sql' || original.input_ids_json !== JSON.stringify(sourceIds)) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与 SQL 输入不匹配')
      }
    }
    const spec = JSON.stringify({ operation: 'sql.select', sourceIds, sourceHashes: readySources.map((source) => source.content_hash), sql, parameters, normalizedSql, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(readySources.reduce((sum, source) => sum + (source.byte_size ?? 0), 0), 1) * 4
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const output: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: `SQL 结果 · ${readySources[0]!.name.slice(0, 210)}`,
      format: 'csv', group_id: datasetId, version: 1, source_ids_json: JSON.stringify(sourceIds), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${datasetId}.csv`, indexState: 'building', profileState: 'pending', sql: normalizedSql }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const rowsIn = readySources.reduce((sum, source) => sum + (source.row_count ?? 0), 0)
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'sql', name: '执行 SQL 查询', state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify(sourceIds), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  submitAnalyze(owner: Identity, sourceId: string, key: string, retryOf: string | null = null,
    aggregate?: AggregateConfig, pivot?: PivotConfig, frequencyColumnId?: string) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (aggregate) {
      try { validateAggregateConfig(aggregate, source.column_count ?? 0, metadata(source).headers as string[]) }
      catch (error) { if (error instanceof AggregateError) throw new ServiceError(422, 'INVALID_AGGREGATE', error.message); throw error }
    }
    if (pivot) {
      try { validatePivotConfig(pivot, metadata(source).headers as string[]) }
      catch (error) { if (error instanceof PivotError) throw new ServiceError(422, 'INVALID_PIVOT', error.message); throw error }
    }
    if (frequencyColumnId !== undefined && (aggregate || pivot || !/^c_(\d+)$/u.test(frequencyColumnId) ||
      Number(frequencyColumnId.slice(2)) >= (source.column_count ?? 0))) {
      throw new ServiceError(422, 'INVALID_FREQUENCY', '请选择可用的频率字段')
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'analyze' || original.input_ids_json !== JSON.stringify([sourceId])) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与数据集不匹配')
      }
    }
    const spec = JSON.stringify(frequencyColumnId ? { operation: 'analyze.frequency', sourceId, sourceHash: source.content_hash,
      frequencyColumnId, retryOf } : pivot ? { operation: 'analyze.pivot', sourceId, sourceHash: source.content_hash, pivot, retryOf } :
      aggregate ? { operation: 'analyze.group', sourceId, sourceHash: source.content_hash, aggregate, retryOf } :
      { operation: 'analyze.stats', sourceId, sourceHash: source.content_hash, cardinality: 'approximate', retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = frequencyColumnId ? (source.byte_size ?? 0) + frequencyScratchLimit(source.byte_size ?? 0) :
      Math.max(source.byte_size ?? 0, 1) * 2
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const output: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: `${source.name.slice(0, 220)} · ${frequencyColumnId ? '值频率' : pivot ? '透视表' : aggregate ? '分组汇总' : '字段统计'}`,
      format: 'csv', group_id: datasetId, version: 1, source_ids_json: JSON.stringify([sourceId]), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${source.name.slice(0, 220)}-${frequencyColumnId ? 'frequency' : 'stats'}.csv`, indexState: 'building', profileState: 'pending',
        analysis: frequencyColumnId ? { scope: 'full', kind: 'frequency', columnId: frequencyColumnId,
          columnName: (metadata(source).headers as string[])[Number(frequencyColumnId.slice(2))], topN: 20,
          sourceRows: source.row_count } : pivot ? { scope: 'full', kind: 'pivot', pivot, sourceRows: source.row_count } :
          aggregate ? { scope: 'full', kind: 'group', aggregate, sourceRows: source.row_count } :
          { scope: 'full', kind: 'fields', cardinality: 'approximate', sourceRows: source.row_count } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'analyze', name: `${frequencyColumnId ? '全表值频率' : pivot ? '透视' : aggregate ? '分组汇总' : '统计'} ${source.name.slice(0, 220)}`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify([sourceId]), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  submitGroupAnalyze(owner: Identity, sourceId: string, aggregate: AggregateConfig, key: string, retryOf: string | null = null) {
    return this.submitAnalyze(owner, sourceId, key, retryOf, aggregate)
  }

  submitPivotAnalyze(owner: Identity, sourceId: string, pivot: PivotConfig, key: string, retryOf: string | null = null) {
    return this.submitAnalyze(owner, sourceId, key, retryOf, undefined, pivot)
  }

  submitFrequencyAnalyze(owner: Identity, sourceId: string, columnId: string, key: string, retryOf: string | null = null) {
    return this.submitAnalyze(owner, sourceId, key, retryOf, undefined, undefined, columnId)
  }

  submitQuality(owner: Identity, sourceId: string, rules: QualityRule[], key: string, retryOf: string | null = null,
    outputMode: QualityOutputMode = 'report') {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (!['report', 'valid', 'invalid'].includes(outputMode)) throw new ServiceError(422, 'INVALID_OUTPUT_MODE', '质量检查输出方式无效')
    const validColumn = (id: unknown) => { const match = typeof id === 'string' ? /^c_(\d+)$/.exec(id) : null
      return Boolean(match && Number(match[1]) < (source.column_count ?? 0)) }
    if (!Array.isArray(rules) || rules.length < 1 || rules.length > 32 || rules.some((rule) => {
      if (rule?.kind === 'unique') return !Array.isArray(rule.columnIds) || rule.columnIds.length < 1 || rule.columnIds.length > 16 ||
        new Set(rule.columnIds).size !== rule.columnIds.length || rule.columnIds.some((id) => !validColumn(id))
      const match = /^c_(\d+)$/.exec(rule?.columnId ?? '')
      return !match || Number(match[1]) >= (source.column_count ?? 0) || !['required', 'length', 'enum', 'type', 'range', 'date-order', 'pattern', 'arithmetic', 'reference'].includes(rule.kind) ||
        (rule.kind === 'length' && (!Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) || rule.min < 0 || rule.max > 100000 || rule.min > rule.max)) ||
        (rule.kind === 'enum' && (!Array.isArray(rule.values) || rule.values.length < 1 || rule.values.length > 100 ||
          rule.values.some((value) => typeof value !== 'string' || value.length > 512))) ||
        (rule.kind === 'type' && !['integer', 'decimal', 'date'].includes(rule.dataType)) ||
        (rule.kind === 'range' && (typeof rule.min !== 'string' || typeof rule.max !== 'string' || !validDecimalRange(rule.min, rule.max))) ||
        (rule.kind === 'date-order' && (!validColumn(rule.otherColumnId) || rule.otherColumnId === rule.columnId)) ||
        (rule.kind === 'pattern' && !validSafePattern(rule.pattern)) ||
        (rule.kind === 'arithmetic' && (!validColumn(rule.leftColumnId) || !validColumn(rule.rightColumnId) ||
          !validTolerance(rule.tolerance))) ||
        (rule.kind === 'reference' && (typeof rule.referenceId !== 'string' || !/^res_[0-9a-f-]{36}$/u.test(rule.referenceId) ||
          typeof rule.referenceColumnId !== 'string' || !/^c_\d+$/u.test(rule.referenceColumnId)))
    })) throw new ServiceError(422, 'INVALID_QUALITY_RULE', '质量检查规则无效')
    const referenceIds = [...new Set(rules.filter((rule): rule is Extract<QualityRule, { kind: 'reference' }> => rule.kind === 'reference')
      .map((rule) => rule.referenceId))]
    if (referenceIds.length > 4) throw new ServiceError(422, 'TOO_MANY_REFERENCES', '一次检查最多绑定 4 份参考数据')
    const referenceSources = referenceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (referenceSources.some((row) => !row || row.kind !== 'dataset' || row.status !== 'ready' || !row.content_hash || !row.storage_relpath) ||
      rules.some((rule) => rule.kind === 'reference' && Number(rule.referenceColumnId.slice(2)) >=
        (referenceSources[referenceIds.indexOf(rule.referenceId)]?.column_count ?? 0))) {
      throw new ServiceError(422, 'INVALID_REFERENCE', '参考数据或参考字段不可用')
    }
    const inputIds = [sourceId, ...referenceIds.filter((id) => id !== sourceId)]
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'quality' || original.input_ids_json !== JSON.stringify(inputIds)) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与数据集不匹配')
      }
    }
    const spec = JSON.stringify({ operation: 'quality.rules', sourceId, sourceHash: source.content_hash, rules,
      references: referenceSources.map((row) => ({ id: row!.id, contentHash: row!.content_hash })), outputMode, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(source.byte_size ?? 0, 1) * 10 + referenceSources.reduce((sum, row) => sum + (row?.byte_size ?? 0) * 3, 0)
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const datasetId = `res_${randomUUID()}`
    const output: ResourceRow = {
      id: datasetId, owner_key: owner.ownerKey, kind: 'dataset', status: 'building', name: `${source.name.slice(0, 220)} · ${outputMode === 'report' ? '质量报告' : outputMode === 'valid' ? '有效记录' : '异常记录'}`,
      format: 'csv', group_id: datasetId, version: 1, source_ids_json: JSON.stringify(inputIds), producer_job_id: jobId,
      storage_relpath: null, content_hash: null, byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${source.name.slice(0, 220)}-quality.csv`, indexState: 'building', profileState: 'pending', quality: { rules, sourceRows: source.row_count, outputMode } }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: owner.ownerKey, kind: 'quality', name: `质量检查 ${source.name.slice(0, 220)}`, state: 'queued', retry_of: retryOf,
      input_ids_json: JSON.stringify(inputIds), spec_json: spec, spec_hash: specHash, engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now,
    }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  async previewQuality(owner: Identity, sourceId: string, rules: QualityRule[]) {
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath ||
      !Array.isArray(rules) || rules.length < 1 || rules.length > 32 ||
      rules.some((rule) => !rule || !['required', 'length', 'enum', 'type', 'range', 'date-order', 'unique', 'pattern', 'arithmetic', 'reference'].includes(rule.kind) ||
        (rule.kind === 'unique' ? !Array.isArray(rule.columnIds) || rule.columnIds.some((id) => !/^c_\d+$/u.test(id) || Number(id.slice(2)) >= (source.column_count ?? 0)) :
          !/^c_\d+$/u.test(rule.columnId) || Number(rule.columnId.slice(2)) >= (source.column_count ?? 0)))) {
      throw new ServiceError(422, 'INVALID_QUALITY_PREVIEW', '样本检查的数据集或规则无效')
    }
    const references: Record<string, { path: string; rowCount: number; columnCount: number }> = {}
    for (const rule of rules) {
      if (rule.kind !== 'reference') continue
      const target = this.db.getResource(owner.ownerKey, rule.referenceId)
      if (!target || target.kind !== 'dataset' || target.status !== 'ready' || !target.storage_relpath ||
        !/^c_\d+$/u.test(rule.referenceColumnId) || Number(rule.referenceColumnId.slice(2)) >= (target.column_count ?? 0)) {
        throw new ServiceError(422, 'INVALID_REFERENCE', '样本检查的固定参考数据不可用')
      }
      references[target.id] = { path: await checkedResourcePath(this.dataDir, owner.workspaceId, target.storage_relpath),
        rowCount: target.row_count ?? 0, columnCount: target.column_count ?? 0 }
    }
    const relative = join('owners', owner.workspaceId, 'previews')
    await ensureDurableDirectory(this.dataDir, relative)
    const directory = await mkdtemp(join(this.dataDir, relative, 'quality-'))
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), 90_000)
    deadline.unref()
    try {
      const path = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      const samplePath = join(directory, 'sample.csv')
      const sampled = await writeSqlInputSample(path, samplePath, source.column_count ?? 0, abort.signal)
      const reportPath = join(directory, 'report.csv')
      const summary = await writeQualityReport(samplePath, reportPath, rules, abort.signal, references)
      const preview = await previewCsv(reportPath, csvImportOptions(undefined), abort.signal)
      return { summary, preview, sampledRows: sampled.rows, scope: '仅输入的前 200 条记录；唯一键也只在样本内计算' }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(422, 'QUALITY_PREVIEW_FAILED', '样本检查失败，请检查规则、字段和参考数据')
    } finally { clearTimeout(deadline); await rm(directory, { recursive: true, force: true }) }
  }

  async preflightSplit(owner: Identity, sourceId: string, config: SplitConfig) {
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (config.mode === 'rows') {
      if (!Number.isSafeInteger(config.size) || config.size < 1 || config.size > 100_000_000) {
        throw new ServiceError(422, 'INVALID_SPLIT', '每份记录数无效')
      }
      const fileCount = Math.max(1, Math.ceil((source.row_count ?? 0) / config.size))
      if (fileCount > 1000) throw new ServiceError(422, 'SPLIT_LIMIT', '拆分文件数量超过 1000 份上限')
      return { fileCount, sourceRows: source.row_count ?? 0, sourceHash: source.content_hash, exact: true }
    }
    if (config.mode !== 'value' || !/^c_(\d+)$/u.test(config.columnId) ||
      Number(config.columnId.slice(2)) >= (source.column_count ?? 0)) {
      throw new ServiceError(422, 'INVALID_SPLIT', '拆分字段无效')
    }
    if (this.activeSplitPreflights >= 2) throw new ServiceError(429, 'SPLIT_PREFLIGHT_BUSY', '正在检查的拆分任务过多，请稍后再试')
    this.activeSplitPreflights += 1
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), 10 * 60 * 1000)
    deadline.unref()
    try {
      const input = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      return { ...await countSplitFiles(input, Number(config.columnId.slice(2)), source.row_count ?? 0, abort.signal),
        sourceHash: source.content_hash, exact: true }
    } catch (error) {
      if (error instanceof ServiceError) throw error
      throw new ServiceError(abort.signal.aborted ? 504 : 422, 'SPLIT_PREFLIGHT_FAILED',
        error instanceof SplitError ? error.message : abort.signal.aborted ? '拆分预检超过 10 分钟' : '拆分预检失败，请检查输入文件')
    } finally { clearTimeout(deadline); this.activeSplitPreflights -= 1 }
  }

  submitSplit(owner: Identity, sourceId: string, config: SplitConfig, key: string, retryOf: string | null = null) {
    if (this.stopping) throw new ServiceError(503, 'SERVICE_STOPPING', '服务正在停止')
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready' || !source.storage_relpath || !source.content_hash) {
      throw new ServiceError(422, 'INVALID_INPUT', '请选择本人可用的数据集')
    }
    if (!config || (config.mode !== 'rows' && config.mode !== 'value') ||
      (config.includeHeader !== undefined && typeof config.includeHeader !== 'boolean') ||
      (config.includeHeader === false && (source.row_count ?? 0) === 0) ||
      (config.mode === 'rows' && (!Number.isSafeInteger(config.size) || config.size < 1 || config.size > 100_000_000 ||
        Math.ceil((source.row_count ?? 0) / config.size) > 1000)) ||
      (config.mode === 'value' && (!/^c_(\d+)$/.test(config.columnId) || Number(config.columnId.slice(2)) >= (source.column_count ?? 0)))) {
      throw new ServiceError(422, 'INVALID_SPLIT', '拆分参数无效或结果可能超过 1000 份')
    }
    if (retryOf) {
      const original = this.db.getJob(owner.ownerKey, retryOf)
      if (!original || original.kind !== 'split' || original.input_ids_json !== JSON.stringify([sourceId])) {
        throw new ServiceError(422, 'INVALID_RETRY', '原任务与输入不匹配')
      }
    }
    const spec = JSON.stringify({ operation: 'split', sourceId, sourceHash: source.content_hash, config, retryOf })
    const specHash = `sha256:${hash(spec)}`
    const existing = this.db.findJobByKey(owner.ownerKey, key)
    if (existing) {
      if (existing.spec_hash !== specHash) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求')
      return { job: jobDto(existing), resource: this.getResource(owner, (JSON.parse(existing.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (retryOf) {
      const prior = this.db.findJobByRetryOf(owner.ownerKey, retryOf)
      if (prior) return { job: jobDto(prior), resource: this.getResource(owner, (JSON.parse(prior.summary_json) as { outputId?: string }).outputId ?? '') }
    }
    if (this.db.countActiveJobs(owner.ownerKey) >= this.limits.maxActiveOwnerJobs || this.db.countActiveJobs() >= this.limits.maxActiveGlobalJobs) throw new ServiceError(429, 'JOB_QUEUE_FULL', '等待处理的任务过多')
    if (this.db.countRecentJobs(owner.ownerKey, Date.now() - 60 * 60 * 1000) >= 120) throw new ServiceError(429, 'JOB_RATE_LIMIT', '一小时内提交的任务过多')
    this.checkResourceCapacity(owner, 'dataset')
    const reservedBytes = Math.max(source.byte_size ?? 0, 1) * 3
    this.reserve(owner, reservedBytes)
    const now = Date.now()
    const jobId = `job_${randomUUID()}`
    const exportId = `res_${randomUUID()}`
    const output: ResourceRow = { id: exportId, owner_key: owner.ownerKey, kind: 'export', status: 'building',
      name: `${source.name.slice(0, 220)} · 拆分文件`, format: 'zip', group_id: exportId, version: 1,
      source_ids_json: JSON.stringify([sourceId]), producer_job_id: jobId, storage_relpath: null, content_hash: null,
      byte_size: null, row_count: null, column_count: null,
      metadata_json: JSON.stringify({ originalName: `${source.name.slice(0, 220)}-split.zip`, split: { config, sourceRows: source.row_count } }),
      created_at: now, updated_at: now, deleted_at: null }
    const job: JobRow = { id: jobId, owner_key: owner.ownerKey, kind: 'split', name: `拆分 ${source.name.slice(0, 220)}`,
      state: 'queued', retry_of: retryOf, input_ids_json: JSON.stringify([sourceId]), spec_json: spec, spec_hash: specHash,
      engine_version: this.engineVersion, idempotency_key: key,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '排队中' }),
      summary_json: JSON.stringify({ outputId: exportId, rowsIn: source.row_count, rowsOut: null, scope: 'full' }),
      error_json: null, work_relpath: join('owners', owner.workspaceId, 'jobs', jobId),
      created_at: now, started_at: null, finished_at: null, updated_at: now }
    try { this.db.createImport(output, job) } catch (error) { this.release(owner, reservedBytes); throw error }
    this.pending.push({ owner, jobId, datasetId: exportId, reservedBytes })
    if (!this.drainTask) {
      const task = this.drain()
      this.drainTask = task
      void task.catch((error: unknown) => { process.stderr.write(`任务调度失败：${error instanceof Error ? error.message : '未知错误'}\n`) })
        .finally(() => { if (this.drainTask === task) this.drainTask = null })
    }
    return { job: jobDto(job), resource: resourceDto(output) }
  }

  async shutdown() {
    this.stopping = true
    for (const upload of this.activeUploads) upload.destroy()
    for (const controller of this.running.values()) controller.abort('shutdown')
    let failure: unknown = null
    for (const queued of this.pending.splice(0)) {
      try {
        this.db.setJobState(queued.owner.ownerKey, queued.jobId, 'interrupted',
          { mode: 'stage', percent: null, stage: '服务停止，任务已中断' },
          { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true })
        const resource = this.db.getResource(queued.owner.ownerKey, queued.datasetId)
        if (resource?.status === 'building') this.db.updateResource(queued.owner.ownerKey, queued.datasetId, {
          status: 'failed', row_count: null, column_count: null, storage_relpath: null,
          content_hash: null, byte_size: null,
          metadata_json: JSON.stringify({ ...metadata(resource), indexState: 'none', profileState: 'pending' }),
        })
      } catch (error) { failure ??= error }
      finally { this.release(queued.owner, queued.reservedBytes) }
    }
    if (this.activeUploads.size > 0) {
      await new Promise<void>((resolve) => this.uploadIdleWaiters.push(resolve))
    }
    const commits = await Promise.allSettled(this.activeTusCommits)
    for (const result of commits) if (result.status === 'rejected') failure ??= result.reason
    try { await this.drainTask } catch (error) { failure ??= error }
    if (failure) throw failure
  }

  cancelJob(owner: Identity, id: string) {
    const row = this.db.getJob(owner.ownerKey, id)
    if (!row) throw new ServiceError(404, 'JOB_NOT_FOUND', '任务不存在')
    if (row.state === 'queued') {
      const index = this.pending.findIndex((item) => item.jobId === id && item.owner.ownerKey === owner.ownerKey)
      if (index >= 0) {
        const [pending] = this.pending.splice(index, 1)
        if (pending) this.release(owner, pending.reservedBytes)
      }
      const outputId = (JSON.parse(row.summary_json) as { outputId?: string }).outputId
      if (outputId) {
        const resource = this.db.getResource(owner.ownerKey, outputId)
        if (resource?.status === 'building') this.db.updateResource(owner.ownerKey, outputId, {
          status: 'failed', row_count: null, column_count: null, storage_relpath: null,
          content_hash: null, byte_size: null,
          metadata_json: JSON.stringify({ ...metadata(resource), indexState: 'none', profileState: 'pending' }),
        })
      }
      this.db.setJobState(owner.ownerKey, id, 'cancelled', { mode: 'stage', percent: null, stage: '排队中取消' })
    } else if (row.state === 'running') {
      this.db.setJobState(owner.ownerKey, id, 'cancel_requested', { mode: 'stage', percent: null, stage: '正在停止' })
      this.running.get(id)?.abort('user')
    }
    return this.getJob(owner, id)
  }

  async downloadPath(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.status !== 'ready' || !row.storage_relpath) throw new ServiceError(404, 'DOWNLOAD_NOT_FOUND', '文件尚不可下载')
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, row.storage_relpath)
    const originalName = metadata(row).originalName
    const name = typeof originalName === 'string' ? originalName : row.name
    const downloadName = row.kind === 'raw' || row.kind === 'export' ? name : `${name.replace(/\.[^.]+$/, '')}.csv`
    return { path, name: downloadName, bytes: row.byte_size, format: row.kind === 'raw' || row.kind === 'export' ? row.format : 'csv' }
  }

  async cleanReportPath(owner: Identity, id: string, step: number, kind: 'errors' | 'duplicates' | 'empty-rows') {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || row.status !== 'ready' || !row.storage_relpath ||
      !Number.isSafeInteger(step) || step < 1 || step > 24 || !['errors', 'duplicates', 'empty-rows'].includes(kind)) {
      throw new ServiceError(404, 'CLEAN_REPORT_NOT_FOUND', '清洗报告不存在')
    }
    const cleanResult = metadata(row).cleanResult as { reports?: { step: number; kind: string; file: string; rows: number; bytes: number; sha256: string }[] } | undefined
    const file = `clean-step-${step}-${kind}.csv`
    const report = cleanResult?.reports?.find((entry) => entry.step === step && entry.kind === kind && entry.file === file)
    if (!report) throw new ServiceError(404, 'CLEAN_REPORT_NOT_FOUND', '清洗报告不存在')
    const relpath = join(dirname(row.storage_relpath), file)
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, relpath)
    const digest = await digestFile(path)
    if (digest.bytes !== report.bytes || digest.sha256 !== report.sha256) {
      throw new ServiceError(500, 'CLEAN_REPORT_CHANGED', '清洗报告校验失败')
    }
    return { path, name: file, bytes: report.bytes }
  }

  async relationReportPath(owner: Identity, id: string, side: 'left' | 'right') {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || row.status !== 'ready' || !row.storage_relpath || !['left', 'right'].includes(side)) {
      throw new ServiceError(404, 'RELATION_REPORT_NOT_FOUND', '关联未匹配清单不存在')
    }
    const reports = metadata(row).relationReports as { side: string; file: string; rows: number; bytes: number; sha256: string }[] | undefined
    const file = `relation-unmatched-${side}.csv`
    const report = reports?.find((entry) => entry.side === side && entry.file === file)
    if (!report) throw new ServiceError(404, 'RELATION_REPORT_NOT_FOUND', '关联未匹配清单不存在')
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, join(dirname(row.storage_relpath), file))
    const digest = await digestFile(path)
    if (digest.bytes !== report.bytes || digest.sha256 !== report.sha256) {
      throw new ServiceError(500, 'RELATION_REPORT_CHANGED', '关联未匹配清单校验失败')
    }
    return { path, name: file, bytes: report.bytes }
  }

  async jsonImportReportPath(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || row.status !== 'ready' || !row.storage_relpath) {
      throw new ServiceError(404, 'JSON_REPORT_NOT_FOUND', 'JSON 异常记录清单不存在')
    }
    const report = metadata(row).jsonImportReport as { file: string; rows: number; bytes: number; sha256: string } | undefined
    if (!report || report.file !== 'json-errors.csv') throw new ServiceError(404, 'JSON_REPORT_NOT_FOUND', 'JSON 异常记录清单不存在')
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, join(dirname(row.storage_relpath), report.file))
    const digest = await digestFile(path)
    if (digest.bytes !== report.bytes || digest.sha256 !== report.sha256) throw new ServiceError(500, 'JSON_REPORT_CHANGED', 'JSON 异常记录清单校验失败')
    return { path, name: report.file, bytes: report.bytes }
  }

  async jsonConversionReportPath(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || row.status !== 'ready' || !row.storage_relpath) {
      throw new ServiceError(404, 'JSON_CONVERSION_REPORT_NOT_FOUND', 'JSON 转换清单不存在')
    }
    const report = metadata(row).jsonConversionReport as { file: string; rows: number; bytes: number; sha256: string } | undefined
    if (!report || report.file !== 'json-conversions.csv') {
      throw new ServiceError(404, 'JSON_CONVERSION_REPORT_NOT_FOUND', 'JSON 转换清单不存在')
    }
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, join(dirname(row.storage_relpath), report.file))
    const digest = await digestFile(path)
    if (digest.bytes !== report.bytes || digest.sha256 !== report.sha256) {
      throw new ServiceError(500, 'JSON_CONVERSION_REPORT_CHANGED', 'JSON 转换清单校验失败')
    }
    return { path, name: report.file, bytes: report.bytes }
  }

  async csvImportReportPath(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || row.status !== 'ready' || !row.storage_relpath) {
      throw new ServiceError(404, 'CSV_REPORT_NOT_FOUND', 'CSV 异常记录清单不存在')
    }
    const report = metadata(row).csvImportReport as { file: string; rows: number; bytes: number; sha256: string } | undefined
    if (!report || report.file !== 'csv-errors.csv') throw new ServiceError(404, 'CSV_REPORT_NOT_FOUND', 'CSV 异常记录清单不存在')
    const path = await checkedResourcePath(this.dataDir, owner.workspaceId, join(dirname(row.storage_relpath), report.file))
    const digest = await digestFile(path)
    if (digest.bytes !== report.bytes || digest.sha256 !== report.sha256) throw new ServiceError(500, 'CSV_REPORT_CHANGED', 'CSV 异常记录清单校验失败')
    return { path, name: report.file, bytes: report.bytes }
  }

  getSchema(owner: Identity, id: string) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || row.status !== 'ready') throw new ServiceError(404, 'DATASET_NOT_READY', '数据集尚不可用')
    const headers = metadata(row).headers as string[]
    const types = metadata(row).columnTypes as Record<string, ColumnType> | undefined
    return { resourceId: id, revision: row.content_hash, rowCount: row.row_count, indexState: 'ready', columns: headers.map((name, index) => ({ id: `c_${index}`, name, originalName: name, type: types?.[`c_${index}`] ?? 'string' })) }
  }

  /** 索引尚在建立时，仅从已经完整写入的规范化文件读取开头样本。 */
  async previewImportResult(owner: Identity, id: string, signal?: AbortSignal) {
    const row = this.db.getResource(owner.ownerKey, id)
    if (!row || row.kind !== 'dataset' || !['building', 'ready'].includes(row.status) || !row.producer_job_id) {
      throw new ServiceError(404, 'IMPORT_RESULT_NOT_FOUND', '导入结果不存在')
    }
    const job = this.db.getJob(owner.ownerKey, row.producer_job_id)
    if (!job || job.kind !== 'import') throw new ServiceError(404, 'IMPORT_RESULT_NOT_FOUND', '导入结果不存在')
    const relpath = row.storage_relpath ?? resourceRelpath(owner.workspaceId, id, 'data.csv')
    let path: string
    try { path = await checkedResourcePath(this.dataDir, owner.workspaceId, relpath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && row.status === 'building') {
        return { available: false as const, stage: '正在解析文件，首批数据尚未写入' }
      }
      throw error
    }
    const preview = await readSqlPreview(path, signal)
    return { available: true as const, stage: row.status === 'ready' ? '数据集已可用' : '文件已解析，索引仍在建立',
      preview: { ...preview, sampleRange: '已解析结果的前 200 条记录' } }
  }

  async createView(owner: Identity, resourceId: string) {
    const source = this.db.getResource(owner.ownerKey, resourceId)
    if (!source || source.kind !== 'dataset' || source.status !== 'ready') throw new ServiceError(422, 'DATASET_NOT_READY', '请选择可用数据集')
    const existing = this.db.findView(owner.ownerKey, resourceId, source.content_hash)
    if (existing) return { id: existing.id, resourceId, revision: source.content_hash, totalRows: source.row_count, totalKnown: true, state: 'ready', computedAt: existing.created_at }
    this.checkResourceCapacity(owner, 'view')
    const now = Date.now()
    const id = `res_${randomUUID()}`
    const row: ResourceRow = {
      id, owner_key: owner.ownerKey, kind: 'view', status: 'ready', name: `${source.name} · 视图`, format: 'csv',
      group_id: id, version: 1, source_ids_json: JSON.stringify([resourceId]), producer_job_id: null,
      storage_relpath: null, content_hash: source.content_hash, byte_size: null, row_count: source.row_count,
      column_count: source.column_count, metadata_json: JSON.stringify({ sourceId: resourceId, revision: source.content_hash, filters: [], sorts: [] }),
      created_at: now, updated_at: now, deleted_at: null,
    }
    this.db.insertResource(row)
    return { id, resourceId, revision: source.content_hash, totalRows: source.row_count, totalKnown: true, state: 'ready', computedAt: now }
  }

  async rows(owner: Identity, viewId: string, offset: number, limit: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) {
      throw new ServiceError(400, 'INVALID_RANGE', '行范围无效')
    }
    const view = this.db.getResource(owner.ownerKey, viewId)
    if (!view || view.kind !== 'view' || view.status !== 'ready') throw new ServiceError(404, 'VIEW_NOT_FOUND', '视图不存在')
    const sourceId = metadata(view).sourceId
    if (typeof sourceId !== 'string') throw new ServiceError(500, 'VIEW_INVALID', '视图来源无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.status !== 'ready' || !source.storage_relpath || source.content_hash !== view.content_hash) {
      throw new ServiceError(409, 'VIEW_STALE', '视图来源已变化')
    }
    const key = JSON.stringify([owner.ownerKey, viewId, source.content_hash, offset, limit, this.engineVersion])
    const hit = this.rowCache.get(key)
    if (hit) {
      this.rowCache.delete(key)
      this.rowCache.set(key, hit)
      return hit.block
    }
    if (this.activeRowReads >= MAX_ACTIVE_ROW_READS) throw new ServiceError(429, 'ROW_READ_BUSY', '同时读取的行段过多，请稍后重试')
    this.activeRowReads += 1
    try {
      const path = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      const columnCount = Math.max(source.column_count ?? 1, 1)
      let count = Math.min(limit, Math.max(1, Math.floor(8192 / columnCount)))
      let previewBytes = MAX_CELL_PREVIEW_BYTES
      while (true) {
        let output: string
        try {
          output = await runQsv(this.binary, ['slice', '--start', String(offset), '--len', String(count), path], signal, SOURCE_BLOCK_BYTES, 60_000)
        } catch (error) {
          if (error instanceof QsvOutputLimitError && count > 1) { count = Math.max(1, Math.floor(count / 2)); continue }
          if (error instanceof QsvOutputLimitError) throw new ServiceError(413, 'ROW_TOO_LARGE', '单行数据超出读取上限')
          throw error
        }
        const records = parse(output, { bom: true, relax_quotes: false, skip_empty_lines: false }) as string[][]
        const headers = records.shift() ?? []
        const columns = headers.map((_name, index) => `c_${index}`)
        const rowIds = records.map((_row, index) => `${sourceId}:${offset + index}`)
        const truncatedCells: RowBlock['truncatedCells'] = []
        const rows = records.map((record, rowIndex) => record.map((cell, columnIndex) => {
          const result = previewValue(cell ?? '', previewBytes)
          if (result.truncated) truncatedCells.push({ rowId: rowIds[rowIndex]!, columnId: `c_${columnIndex}`, originalBytes: result.originalBytes })
          return result.value
        }))
        const nextOffset = offset + rows.length
        const block: RowBlock = { viewId, revision: view.content_hash, offset, limit: count, nextOffset, columns,
          rowIds, sourceRowNumbers: rows.map((_row, index) => offset + index + 1), rows,
          totalRows: source.row_count, totalKnown: true, hasMore: nextOffset < (source.row_count ?? 0), truncatedCells }
        const bytes = Buffer.byteLength(JSON.stringify(block))
        if (bytes > ROW_BLOCK_BYTES && count > 1) { count = Math.max(1, Math.floor(count / 2)); continue }
        if (bytes > ROW_BLOCK_BYTES && previewBytes > 256) { previewBytes = Math.max(256, Math.floor(previewBytes / 2)); continue }
        if (bytes > ROW_BLOCK_BYTES) throw new ServiceError(413, 'ROW_BLOCK_TOO_LARGE', '行段数据超出读取上限')
        this.rowCache.set(key, { block, bytes })
        this.rowCacheSize += bytes
        while (this.rowCacheSize > ROW_CACHE_BYTES || this.rowCache.size > 2048) {
          const oldest = this.rowCache.keys().next().value
          if (!oldest) break
          this.rowCacheSize -= this.rowCache.get(oldest)!.bytes
          this.rowCache.delete(oldest)
        }
        return block
      }
    } finally { this.activeRowReads -= 1 }
  }

  async cell(owner: Identity, viewId: string, rowIndex: number, columnId: string, signal?: AbortSignal) {
    if (!Number.isSafeInteger(rowIndex) || rowIndex < 0 || !/^c_\d+$/.test(columnId)) throw new ServiceError(400, 'INVALID_CELL', '单元格位置无效')
    const view = this.db.getResource(owner.ownerKey, viewId)
    if (!view || view.kind !== 'view' || view.status !== 'ready') throw new ServiceError(404, 'VIEW_NOT_FOUND', '视图不存在')
    const sourceId = metadata(view).sourceId
    if (typeof sourceId !== 'string') throw new ServiceError(500, 'VIEW_INVALID', '视图来源无效')
    const source = this.db.getResource(owner.ownerKey, sourceId)
    if (!source || source.status !== 'ready' || !source.storage_relpath || source.content_hash !== view.content_hash) throw new ServiceError(409, 'VIEW_STALE', '视图来源已变化')
    const columnIndex = Number(columnId.slice(2))
    if (rowIndex >= (source.row_count ?? 0) || !Number.isSafeInteger(columnIndex) || columnIndex >= (source.column_count ?? 0)) throw new ServiceError(404, 'CELL_NOT_FOUND', '单元格不存在')
    if (this.activeRowReads >= MAX_ACTIVE_ROW_READS) throw new ServiceError(429, 'ROW_READ_BUSY', '同时读取的行段过多，请稍后重试')
    this.activeRowReads += 1
    try {
      const path = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      let output: string
      try { output = await runQsv(this.binary, ['slice', '--start', String(rowIndex), '--len', '1', path], signal, SOURCE_BLOCK_BYTES, 60_000) }
      catch (error) {
        if (error instanceof QsvOutputLimitError) throw new ServiceError(413, 'ROW_TOO_LARGE', '单行数据超出读取上限')
        throw error
      }
      const records = parse(output, { bom: true, relax_quotes: false, skip_empty_lines: false }) as string[][]
      const value = records[1]?.[columnIndex]
      if (value === undefined) throw new ServiceError(404, 'CELL_NOT_FOUND', '单元格不存在')
      return { viewId, revision: view.content_hash, rowId: `${sourceId}:${rowIndex}`, rowNumber: rowIndex + 1, columnId, value, bytes: Buffer.byteLength(value) }
    } finally { this.activeRowReads -= 1 }
  }

  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (!this.stopping && this.pending.length > 0) {
        const next = this.pending.shift()!
        try {
          const job = this.db.getJob(next.owner.ownerKey, next.jobId)
          if (job?.kind === 'split') await this.runSplit(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'quality') await this.runQuality(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'analyze') await this.runAnalyze(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'sql') await this.runSql(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'compare_preflight') await this.runComparePreflight(next.owner, next.jobId)
          else if (job?.kind === 'compare') await this.runCompare(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'combine') await this.runCombine(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'export') await this.runExport(next.owner, next.jobId, next.datasetId)
          else if (job?.kind === 'filter' || job?.kind === 'clean' || job?.kind === 'dedup' || job?.kind === 'edit') await this.runSingleSourceOperation(next.owner, next.jobId, next.datasetId)
          else await this.runImport(next.owner, next.jobId, next.datasetId)
        }
        finally {
          this.release(next.owner, next.reservedBytes)
          const finished = this.db.getJob(next.owner.ownerKey, next.jobId)
          if (finished?.parent_job_id) {
            try { this.getRecipeBatch(next.owner, finished.parent_job_id) }
            catch (error) { process.stderr.write(`批量任务状态更新失败：${error instanceof Error ? error.message : '未知错误'}\n`) }
          }
        }
      }
    } finally { this.draining = false }
  }

  private async runSplit(owner: Identity, jobId: string, exportId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, exportId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { sourceId: string; sourceHash: string; config: SplitConfig }
    const source = this.db.getResource(owner.ownerKey, spec.sourceId)
    if (!source || source.status !== 'ready' || !source.storage_relpath || source.content_hash !== spec.sourceHash) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '拆分输入已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, exportId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, exportId, 'export.zip')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    const directory = dirname(path)
    const chunks = join(directory, 'chunks')
    let durableCommit = false
    try {
      const input = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '按完整记录拆分' }, null, { outputId: exportId })
      const manifest = await writeSplitFiles(input, chunks, spec.config, source.row_count ?? 0, abort.signal)
      for (const entry of manifest.files) {
        if (manifest.includeHeader) {
          const inspected = await inspectCsv(join(chunks, entry.name), abort.signal)
          if (inspected.rowCount !== entry.rows || JSON.stringify(inspected.headers) !== JSON.stringify(metadata(source).headers)) {
            throw new SplitError('拆分文件与源数据的字段或行数不一致')
          }
        }
        await syncFile(join(chunks, entry.name))
      }
      await syncDirectory(chunks)
      const manifestPath = join(directory, 'manifest.json')
      const manifestText = JSON.stringify(manifest)
      if (Buffer.byteLength(manifestText, 'utf8') > 8 * 1024 * 1024) throw new SplitError('拆分清单超过 8 MiB 限制')
      await writeFile(manifestPath, manifestText, { flag: 'wx', mode: 0o600 })
      await syncFile(manifestPath)
      await syncDirectory(directory)
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '打包拆分文件' }, null, { outputId: exportId })
      await writeSplitZip(chunks, manifest, partial, abort.signal)
      await syncFile(partial)
      if (abort.signal.aborted) throw new SplitError('拆分已取消')
      await rename(partial, path)
      await syncDirectory(directory)
      const zipDigest = await digestFile(path, abort.signal)
      const manifestDigest = await digestFile(manifestPath, abort.signal)
      await writeCommit(directory, { version: 1, kind: 'export', resourceId: exportId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: zipDigest.sha256, bytes: zipDigest.bytes,
        name: String(metadata(output).originalName), createdAt: output.created_at, jobId, sourceId: source.id,
        sourceHash: source.content_hash!, engineVersion: this.engineVersion, format: 'zip', rowCount: manifest.sourceRows,
        splitManifest: { sha256: manifestDigest.sha256, bytes: manifestDigest.bytes } })
      durableCommit = true
      if (abort.signal.aborted) throw new SplitError('拆分已取消')
      const details = JSON.stringify({ ...metadata(output), split: { config: spec.config, sourceRows: manifest.sourceRows,
        fileCount: manifest.files.length }, commitVersion: 1 })
      this.db.completeImport(owner.ownerKey, exportId, { status: 'ready', row_count: manifest.sourceRows,
        column_count: source.column_count, storage_relpath: relpath, content_hash: `sha256:${zipDigest.sha256}`,
        byte_size: zipDigest.bytes, metadata_json: details }, jobId, manifest.sourceRows, source.row_count ?? 0)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '拆分文件已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对。 */ }
        return
      }
      await rm(directory, { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, exportId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: '拆分超过 30 分钟，已停止', retryable: true }
          : { code: 'SPLIT_FAILED', message: error instanceof SplitError || error instanceof CsvValidationError ? error.message : '拆分失败', retryable: false },
        { outputId: exportId, rowsIn: source.row_count, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runQuality(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { sourceId: string; sourceHash: string; rules: QualityRule[];
      references?: { id: string; contentHash: string }[]; outputMode?: QualityOutputMode }
    const source = this.db.getResource(owner.ownerKey, spec.sourceId)
    if (!source || source.status !== 'ready' || !source.storage_relpath || source.content_hash !== spec.sourceHash) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '质量检查输入已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const references = (spec.references ?? []).map((item) => ({ snapshot: item, resource: this.db.getResource(owner.ownerKey, item.id) }))
    if (references.some(({ snapshot, resource }) => !resource || resource.status !== 'ready' ||
      !resource.storage_relpath || resource.content_hash !== snapshot.contentHash)) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'REFERENCE_CHANGED', message: '固定参考数据已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    let durableCommit = false
    try {
      const sourcePath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      const referenceInputs: Record<string, { path: string; rowCount: number; columnCount: number }> = {}
      for (const { resource } of references) {
        referenceInputs[resource!.id] = { path: await checkedResourcePath(this.dataDir, owner.workspaceId, resource!.storage_relpath!),
          rowCount: resource!.row_count ?? 0, columnCount: resource!.column_count ?? 0 }
      }
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '检查全部记录' }, null, { outputId: datasetId })
      const statePath = spec.outputMode === 'valid' || spec.outputMode === 'invalid'
        ? await this.sourceCellStatePath(owner, source) : undefined
      const rowMap = statePath ? join(dirname(path), 'quality-row-map.csv') : undefined
      const summary = await writeQualityReport(sourcePath, partial, spec.rules, abort.signal, referenceInputs,
        spec.outputMode ?? 'report', rowMap)
      if (summary.checkedRows !== source.row_count) throw new QsvCommandError('质量检查输入行数无法核对')
      const inspected = await inspectCsv(partial, abort.signal)
      if (inspected.rowCount !== summary.outputRows) throw new CsvValidationError('质量检查输出数量无法核对')
      const mappedStateReport = statePath && rowMap
        ? await mapCellStates(statePath, rowMap, join(dirname(path), 'cell-states.csv'),
          summary.outputRows, source.row_count ?? 0, abort.signal) : undefined
      if (rowMap) await rm(rowMap, { force: true })
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立报告索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const counted = Number((await runQsv(this.binary, ['count', path], abort.signal)).trim())
      if (counted !== summary.outputRows) throw new QsvCommandError('质量检查输出行数无法核对')
      let cellStateReport: { file: string; rows: number; bytes: number; sha256: string } | undefined
      if (mappedStateReport) {
        const stateReportPath = join(dirname(path), mappedStateReport.file)
        await syncFile(stateReportPath)
        const stateDigest = await digestFile(stateReportPath, abort.signal)
        cellStateReport = { ...mappedStateReport, bytes: stateDigest.bytes, sha256: stateDigest.sha256 }
        await syncDirectory(dirname(path))
      }
      const details = JSON.stringify({ ...metadata(output), headers: inspected.headers, indexState: 'ready', commitVersion: 1,
        qualitySummary: summary,
        columnTypes: (spec.outputMode ?? 'report') === 'report' ? {} : columnTypes(metadata(source).columnTypes),
        ...(cellStateReport ? { cellStateReport } : {}),
        ...((spec.outputMode === 'valid' || spec.outputMode === 'invalid') &&
          (cellStateReport || metadata(source).cellStateLineage === true ||
            this.db.getJob(owner.ownerKey, source.producer_job_id ?? '')?.kind === 'import') ? { cellStateLineage: true } : {}) })
      if (Buffer.byteLength(details, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('质量报告元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      await writeCommit(dirname(path), { version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: String(metadata(output).originalName), createdAt: output.created_at, jobId, sourceId: source.id,
        sourceHash: source.content_hash!, engineVersion: this.engineVersion, rowCount: summary.outputRows, headers: inspected.headers,
        qualitySummary: summary, indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes,
        metadataSnapshot: JSON.parse(details) as Record<string, unknown> })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.completeImport(owner.ownerKey, datasetId, { status: 'ready', row_count: summary.outputRows, column_count: inspected.headers.length,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, metadata_json: details },
      jobId, summary.outputRows, summary.checkedRows)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '质量报告已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: '质量检查超过 30 分钟，已停止', retryable: true }
          : { code: 'QUALITY_FAILED', message: '质量检查失败，请检查规则和数据规模', retryable: false },
        { outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runAnalyze(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { sourceId: string; sourceHash: string; aggregate?: AggregateConfig;
      pivot?: PivotConfig; frequencyColumnId?: string }
    const source = this.db.getResource(owner.ownerKey, spec.sourceId)
    if (!source || source.status !== 'ready' || !source.storage_relpath || source.content_hash !== spec.sourceHash) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '统计输入已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    let durableCommit = false
    try {
      const sourcePath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '统计全部记录' }, null, { outputId: datasetId })
      let expectedRows = source.column_count
      let distinctValues: number | undefined
      if (spec.frequencyColumnId) {
        const result = await writeFrequencyTop(sourcePath, partial, spec.frequencyColumnId,
          metadata(source).headers as string[], source.row_count ?? 0,
          frequencyScratchLimit(source.byte_size ?? 0), abort.signal)
        expectedRows = result.rowsOut
        distinctValues = result.distinctValues
      } else if (spec.pivot) {
        const result = await writePivot(sourcePath, partial, spec.pivot, metadata(source).headers as string[], source.row_count ?? 0, abort.signal)
        expectedRows = result.rowsOut
      } else if (spec.aggregate) {
        const grouped = await writeGroupedAggregate(sourcePath, partial, spec.aggregate, source.row_count ?? 0, abort.signal)
        expectedRows = grouped.rowsOut
      } else {
        await runQsv(this.binary, ['stats', '--cardinality', '--cardinality-method', 'approx', '--cache-threshold', '0',
          '--jobs', '1', '--output', partial, sourcePath], abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        const extended = join(dirname(path), 'stats-with-source-states.csv')
        const statePath = await this.sourceCellStatePath(owner, source)
        const traceable = Boolean(statePath || metadata(source).cellStateLineage === true ||
          this.db.getJob(owner.ownerKey, source.producer_job_id ?? '')?.kind === 'import')
        await appendCellStateCountsToStats(partial, extended, statePath,
          metadata(source).headers as string[], source.row_count ?? 0, abort.signal, !traceable)
        await rm(partial, { force: true })
        await rename(extended, partial)
      }
      const inspected = await inspectCsv(partial, abort.signal)
      if (inspected.rowCount !== expectedRows) throw new QsvCommandError('统计结果记录数与预期不一致')
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立统计结果索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const counted = Number((await runQsv(this.binary, ['count', path], abort.signal)).trim())
      if (counted !== inspected.rowCount) throw new QsvCommandError('统计结果行数无法核对')
      const outputMetadata = metadata(output)
      const details = JSON.stringify({ ...outputMetadata, headers: inspected.headers, indexState: 'ready', commitVersion: 1,
        analysis: distinctValues === undefined ? outputMetadata.analysis : { ...(outputMetadata.analysis as Record<string, unknown>), distinctValues } })
      if (Buffer.byteLength(details, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('统计结果元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      await writeCommit(dirname(path), { version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: String(metadata(output).originalName), createdAt: output.created_at, jobId, sourceId: source.id,
        sourceHash: source.content_hash!, engineVersion: this.engineVersion, rowCount: inspected.rowCount, headers: inspected.headers,
        indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes, metadataSnapshot: JSON.parse(details) as Record<string, unknown> })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.completeImport(owner.ownerKey, datasetId, { status: 'ready', row_count: inspected.rowCount, column_count: inspected.headers.length,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, metadata_json: details },
      jobId, inspected.rowCount, source.row_count ?? 0)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '统计结果已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: '统计超过 30 分钟，已停止', retryable: true }
          : { code: 'ANALYZE_FAILED', message: error instanceof AggregateError || error instanceof FrequencyError ? error.message : '全表统计失败', retryable: false },
        { outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runSql(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { sourceIds: string[]; sourceHashes: string[]; normalizedSql: string }
    const sources = spec.sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((source, index) => !source || source.status !== 'ready' || !source.storage_relpath || source.content_hash !== spec.sourceHashes[index])) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: 'SQL 输入已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const readySources = sources as ResourceRow[]
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    let durableCommit = false
    const rowsIn = readySources.reduce((sum, source) => sum + (source.row_count ?? 0), 0)
    try {
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      const inputPaths: string[] = []
      for (let i = 0; i < readySources.length; i += 1) {
        const source = readySources[i]!
        const checked = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath!)
        const input = join(dirname(path), `t${i + 1}.csv`)
        await link(checked, input)
        const headers = metadata(source).headers as string[]
        await writeFile(`${input}.pschema.json`, JSON.stringify({ fields: Object.fromEntries(headers.map((name) => [name, 'String'])), metadata: null }),
          { flag: 'wx', mode: 0o600 })
        inputPaths.push(input)
      }
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '扫描输入并执行 SQL' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['sqlp', '--cache-schema', '--format', 'csv', '--output', partial, ...inputPaths, spec.normalizedSql],
        abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      for (const input of inputPaths) { await rm(input, { force: true }); await rm(`${input}.pschema.json`, { force: true }) }
      const inspected = await inspectCsv(partial, abort.signal)
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立查询结果索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const counted = Number((await runQsv(this.binary, ['count', path], abort.signal)).trim())
      if (counted !== inspected.rowCount) throw new QsvCommandError('SQL 结果行数无法核对')
      const details = JSON.stringify({ ...metadata(output), headers: inspected.headers, indexState: 'ready', commitVersion: 1 })
      if (Buffer.byteLength(details, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('SQL 结果元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      await writeCommit(dirname(path), { version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: String(metadata(output).originalName), createdAt: output.created_at, jobId,
        sourceId: readySources[0]!.id, sourceHash: readySources[0]!.content_hash!,
        additionalSources: readySources.slice(1).map((source) => ({ id: source.id, hash: source.content_hash! })),
        engineVersion: this.engineVersion, rowCount: inspected.rowCount, headers: inspected.headers,
        indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.completeImport(owner.ownerKey, datasetId, { status: 'ready', row_count: inspected.rowCount, column_count: inspected.headers.length,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, metadata_json: details },
      jobId, inspected.rowCount, rowsIn)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: 'SQL 结果已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: 'SQL 查询超过 30 分钟，已停止', retryable: true }
          : { code: 'SQL_FAILED', message: 'SQL 查询失败，请检查字段、函数和查询规模', retryable: false },
        { outputId: datasetId, rowsIn, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runComparePreflight(owner: Identity, jobId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    if (!job || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { leftId: string; rightId: string; leftHash: string; rightHash: string; config: CompareConfig }
    const left = this.db.getResource(owner.ownerKey, spec.leftId)
    const right = this.db.getResource(owner.ownerKey, spec.rightId)
    if (!left || !right || left.status !== 'ready' || right.status !== 'ready' || !left.storage_relpath || !right.storage_relpath ||
      left.content_hash !== spec.leftHash || right.content_hash !== spec.rightHash) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '预检输入已不可用', retryable: false })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const directory = join(this.dataDir, job.work_relpath)
    try {
      const leftPath = await checkedResourcePath(this.dataDir, owner.workspaceId, left.storage_relpath)
      const rightPath = await checkedResourcePath(this.dataDir, owner.workspaceId, right.storage_relpath)
      await ensureDurableDirectory(this.dataDir, job.work_relpath)
      const preparedLeft = join(directory, 'left-prepared.csv')
      const preparedRight = join(directory, 'right-prepared.csv')
      const sortedLeft = join(directory, 'left-sorted.csv')
      const sortedRight = join(directory, 'right-sorted.csv')
      const detailPath = join(directory, 'preflight.csv')
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '检查全部匹配键' })
      const leftRows = await prepareCompareInput(leftPath, preparedLeft, spec.config.leftKeyIds,
        spec.config.trimKeys, spec.config.ignoreKeyCase, abort.signal)
      const rightRows = await prepareCompareInput(rightPath, preparedRight, spec.config.rightKeyIds,
        spec.config.trimKeys, spec.config.ignoreKeyCase, abort.signal)
      if (leftRows !== left.row_count || rightRows !== right.row_count) throw new CompareError('预检输入行数不一致')
      await runQsv(this.binary, ['index', preparedLeft], abort.signal)
      await runQsv(this.binary, ['index', preparedRight], abort.signal)
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '排序并检查重复键' })
      await runQsv(this.binary, ['extsort', '--select', '1', '--tmp-dir', directory, preparedLeft, sortedLeft],
        abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      await runQsv(this.binary, ['extsort', '--select', '1', '--tmp-dir', directory, preparedRight, sortedRight],
        abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      const leftKeys = await inspectSortedKeys(sortedLeft, spec.config.leftKeyIds, leftRows, abort.signal)
      const rightKeys = await inspectSortedKeys(sortedRight, spec.config.rightKeyIds, rightRows, abort.signal)
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '计算预计分类和差异样本' })
      const duplicateWouldAbort = spec.config.duplicatePolicy === 'abort' &&
        leftKeys.duplicateGroups + rightKeys.duplicateGroups > 0
      const summary = await compareSortedInputs(sortedLeft, sortedRight, detailPath,
        { ...spec.config, duplicatePolicy: duplicateWouldAbort ? 'isolate' : spec.config.duplicatePolicy, parseFailurePolicy: 'isolate' },
        metadata(left).headers as string[], metadata(right).headers as string[], leftRows, rightRows, abort.signal)
      const wouldAbort = duplicateWouldAbort || spec.config.parseFailurePolicy === 'abort' && summary.pairErrors > 0
      const sample: { detailRow: number; category: string; key: string; field: string; leftValue: string; rightValue: string; reason: string }[] = []
      const source = createReadStream(detailPath, { signal: abort.signal })
      const parser = parseCsvStream({ bom: true, relax_quotes: false, relax_column_count: false,
        max_record_size: 8 * 1024 * 1024 })
      source.on('error', (error) => parser.destroy(error))
      source.pipe(parser)
      try {
        let detailRow = 0
        for await (const cells of parser as AsyncIterable<string[]>) {
          if (detailRow === 0) { detailRow = 1; continue }
          if (cells[0] !== 'equal') sample.push({ detailRow: detailRow, category: cells[0] ?? '', key: (cells[2] ?? '').slice(0, 160),
            field: (cells[5] ?? '').slice(0, 160), leftValue: (cells[6] ?? '').slice(0, 160),
            rightValue: (cells[7] ?? '').slice(0, 160), reason: (cells[11] ?? '').slice(0, 240) })
          if (sample.length >= 12) break
          detailRow += 1
        }
      } finally { source.destroy(); parser.destroy() }
      this.db.setJobState(owner.ownerKey, jobId, 'succeeded', { mode: 'stage', percent: null, stage: '全量预检完成' }, null,
        { outputId: null, rowsIn: leftRows + rightRows, rowsOut: null, scope: 'full',
          preflight: { leftId: left.id, rightId: right.id, leftHash: left.content_hash, rightHash: right.content_hash,
            configHash: hash(JSON.stringify(spec.config)), leftKeys, rightKeys, summary, sample, wouldAbort, completedAt: Date.now() } })
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || abort.signal.aborted && abort.signal.reason === 'shutdown'
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，预检已中断', retryable: true }
          : abort.signal.aborted ? { code: 'PREFLIGHT_TIMEOUT', message: '全量预检超过 30 分钟', retryable: true }
          : { code: 'PREFLIGHT_FAILED', message: error instanceof CompareError || error instanceof CsvValidationError || error instanceof QsvCommandError
            ? error.message : '全量预检失败', retryable: false })
    } finally {
      clearTimeout(deadline)
      this.running.delete(jobId)
      await rm(directory, { recursive: true, force: true })
    }
  }

  private async runCompare(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { leftId: string; rightId: string; leftHash: string; rightHash: string; config: CompareConfig }
    const left = this.db.getResource(owner.ownerKey, spec.leftId)
    const right = this.db.getResource(owner.ownerKey, spec.rightId)
    if (!left || !right || left.status !== 'ready' || right.status !== 'ready' || !left.storage_relpath || !right.storage_relpath ||
      left.content_hash !== spec.leftHash || right.content_hash !== spec.rightHash) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '核对输入已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    let durableCommit = false
    const rowsIn = (left.row_count ?? 0) + (right.row_count ?? 0)
    try {
      const leftPath = await checkedResourcePath(this.dataDir, owner.workspaceId, left.storage_relpath)
      const rightPath = await checkedResourcePath(this.dataDir, owner.workspaceId, right.storage_relpath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      const leftPrepared = join(dirname(path), 'left-prepared.csv')
      const rightPrepared = join(dirname(path), 'right-prepared.csv')
      const leftSorted = join(dirname(path), 'left-sorted.csv')
      const rightSorted = join(dirname(path), 'right-sorted.csv')
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '准备复合键' }, null, { outputId: datasetId })
      const preparedLeftRows = await prepareCompareInput(leftPath, leftPrepared, spec.config.leftKeyIds,
        spec.config.trimKeys, spec.config.ignoreKeyCase, abort.signal)
      const preparedRightRows = await prepareCompareInput(rightPath, rightPrepared, spec.config.rightKeyIds,
        spec.config.trimKeys, spec.config.ignoreKeyCase, abort.signal)
      if (preparedLeftRows !== left.row_count || preparedRightRows !== right.row_count) throw new QsvCommandError('核对输入行数无法核对')
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '外排序全部记录' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', leftPrepared], abort.signal)
      await runQsv(this.binary, ['index', rightPrepared], abort.signal)
      await runQsv(this.binary, ['extsort', '--select', '1', '--tmp-dir', dirname(path), leftPrepared, leftSorted], abort.signal,
        256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      await runQsv(this.binary, ['extsort', '--select', '1', '--tmp-dir', dirname(path), rightPrepared, rightSorted], abort.signal,
        256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '逐组核对' }, null, { outputId: datasetId })
      const summary = await compareSortedInputs(leftSorted, rightSorted, partial, spec.config,
        metadata(left).headers as string[], metadata(right).headers as string[], preparedLeftRows, preparedRightRows, abort.signal)
      for (const temporary of [leftPrepared, `${leftPrepared}.idx`, rightPrepared, `${rightPrepared}.idx`, leftSorted, rightSorted]) {
        await rm(temporary, { force: true })
      }
      const inspected = await inspectCsv(partial, abort.signal)
      if (inspected.rowCount !== summary.detailRows) throw new CsvValidationError('核对明细行数不一致')
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立结果索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const counted = Number((await runQsv(this.binary, ['count', path], abort.signal)).trim())
      if (counted !== summary.detailRows) throw new QsvCommandError('核对结果行数无法核对')
      const details = JSON.stringify({ ...metadata(output), headers: inspected.headers, indexState: 'ready', commitVersion: 1,
        compareSummary: summary })
      if (Buffer.byteLength(details, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('核对结果元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      await writeCommit(dirname(path), { version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: String(metadata(output).originalName), createdAt: output.created_at, jobId,
        sourceId: left.id, sourceHash: left.content_hash!, additionalSources: [{ id: right.id, hash: right.content_hash! }],
        compareSummary: summary,
        engineVersion: this.engineVersion, rowCount: summary.detailRows, headers: inspected.headers,
        indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.completeImport(owner.ownerKey, datasetId, { status: 'ready', row_count: summary.detailRows, column_count: inspected.headers.length,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, metadata_json: details },
      jobId, summary.detailRows, rowsIn)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '核对结果已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: '核对超过 30 分钟，已停止', retryable: true }
          : { code: 'COMPARE_FAILED', message: error instanceof CsvValidationError || error instanceof QsvCommandError || error instanceof CompareError ? error.message : '核对失败，请检查键和比较字段', retryable: false },
        { outputId: datasetId, rowsIn, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runCombine(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { sourceIds: string[]; sourceHashes: string[]; mode: 'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error' | 'relation' | 'set' | 'reshape'; relationConfig?: RelationConfig; setConfig?: SetConfig; reshapeConfig?: ReshapeConfig }
    const sources = spec.sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    if (sources.some((source, index) => !source || source.status !== 'ready' || source.content_hash !== spec.sourceHashes[index] || !source.storage_relpath)) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '合并输入已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const readySources = sources as ResourceRow[]
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    let durableCommit = false
    let relationReports: { side: 'left' | 'right'; file: string; rows: number }[] = []
    let relationSummary: { leftRows: number; rightRows: number; matchedPairs: number;
      matchedLeftRows: number; matchedRightRows: number; unmatchedLeftRows: number; unmatchedRightRows: number;
      outputRows: number } | undefined
    let relationStateReport: { file: string; rows: number } | undefined
    let reshapeRowMap: string | undefined
    let setRowMap: string | undefined
    let setStatePaths: (string | undefined)[] | null = null
    const rowsIn = readySources.reduce((sum, source) => sum + (source.row_count ?? 0), 0)
    let expectedRows = spec.mode.startsWith('horizontal') ? Math.max(...readySources.map((source) => source.row_count ?? 0)) : rowsIn
    try {
      const inputPaths = await Promise.all(readySources.map((source) => checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath!)))
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '合并全部记录' }, null, { outputId: datasetId })
      if (spec.mode === 'reshape' && spec.reshapeConfig) {
        reshapeRowMap = spec.reshapeConfig.kind === 'split-column' ? join(dirname(path), 'reshape-row-map.csv') : undefined
        const result = await writeReshapedCsv(inputPaths[0]!, partial, spec.reshapeConfig,
          readySources[0]!.row_count ?? 0, abort.signal, reshapeRowMap)
        expectedRows = result.rowsOut
      } else if (spec.mode === 'reshape') {
        throw new ReshapeError('重组规则快照缺失')
      } else if (spec.mode === 'set' && spec.setConfig) {
        setStatePaths = await Promise.all(readySources.map((source) => this.sourceCellStatePath(owner, source)))
        setRowMap = setStatePaths.some(Boolean) ? join(dirname(path), 'set-row-map.csv') : undefined
        const result = await writeSetOperation(inputPaths[0]!, inputPaths[1]!, partial, spec.setConfig,
          readySources[0]!.row_count ?? 0, readySources[1]!.row_count ?? 0, abort.signal, setRowMap)
        expectedRows = result.rowsOut
      } else if (spec.mode === 'set') {
        throw new SetOperationError('集合运算规则快照缺失')
      } else if (spec.mode === 'relation' && spec.relationConfig) {
        const leftPrepared = join(dirname(path), 'relation-left.csv')
        const rightPrepared = join(dirname(path), 'relation-right.csv')
        const keyIndex = join(dirname(path), 'relation-keys.sqlite')
        const preflight = await prepareRelation(inputPaths[0]!, inputPaths[1]!, leftPrepared, rightPrepared,
          keyIndex, spec.relationConfig, readySources[0]!.row_count ?? 0, readySources[1]!.row_count ?? 0, abort.signal,
          { leftPath: join(dirname(path), 'relation-unmatched-left.csv'), rightPath: join(dirname(path), 'relation-unmatched-right.csv') })
        expectedRows = preflight.expectedRows
        relationSummary = {
          leftRows: readySources[0]!.row_count ?? 0, rightRows: readySources[1]!.row_count ?? 0,
          matchedPairs: preflight.matchedPairs,
          matchedLeftRows: (readySources[0]!.row_count ?? 0) - preflight.unmatchedLeft,
          matchedRightRows: (readySources[1]!.row_count ?? 0) - preflight.unmatchedRight,
          unmatchedLeftRows: preflight.unmatchedLeft, unmatchedRightRows: preflight.unmatchedRight,
          outputRows: preflight.expectedRows,
        }
        relationReports = [
          { side: 'left', file: 'relation-unmatched-left.csv', rows: preflight.unmatchedLeft },
          { side: 'right', file: 'relation-unmatched-right.csv', rows: preflight.unmatchedRight },
        ]
        const flags = spec.relationConfig.kind === 'inner' ? [] : [`--${spec.relationConfig.kind}`]
        const ordering = ['inner', 'left', 'right', 'full'].includes(spec.relationConfig.kind) ? ['--maintain-order', 'left_right'] : []
        const validation = spec.relationConfig.cardinality === 'one-to-one' ? 'onetoone' :
          spec.relationConfig.cardinality === 'one-to-many' ? 'onetomany' :
          spec.relationConfig.cardinality === 'many-to-one' ? 'manytoone' : 'none'
        const decimalKeys = spec.relationConfig.keyType === 'decimal'
        const preparedKeys = decimalKeys || spec.relationConfig.trimKeys === true ||
          spec.relationConfig.ignoreCase === true || Boolean(spec.relationConfig.unicodeNormalization &&
            spec.relationConfig.unicodeNormalization !== 'none')
        const leftKeys = spec.relationConfig.leftKeyIds.map((id, index) =>
          String(preparedKeys ? preflight.leftWidth + 1 + index : Number(id.slice(2)) + 1)).join(',')
        const rightKeys = spec.relationConfig.rightKeyIds.map((id, index) =>
          String(preparedKeys ? preflight.rightWidth + 1 + index : Number(id.slice(2)) + 1)).join(',')
        const normalization = !preparedKeys && spec.relationConfig.unicodeNormalization && spec.relationConfig.unicodeNormalization !== 'none'
          ? ['--norm-unicode', spec.relationConfig.unicodeNormalization] : []
        await runQsv(this.binary, ['joinp', ...flags, ...ordering, '--cache-schema', '-1', '--validate', validation,
          ...(spec.relationConfig.matchEmptyKeys ? ['--nulls'] : []),
          ...(!preparedKeys && spec.relationConfig.ignoreCase ? ['--ignore-case'] : []), ...normalization,
          '--quiet', '--output', partial, leftKeys, leftPrepared, rightKeys, rightPrepared], abort.signal,
          256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        if (spec.relationConfig.kind === 'left-semi' || spec.relationConfig.kind === 'left-anti') {
          await runQsv(this.binary, ['index', partial], abort.signal)
          const sorted = join(dirname(path), 'relation-sorted.csv')
          await runQsv(this.binary, ['extsort', '--select', String(preflight.leftWidth), '--tmp-dir', dirname(path),
            partial, sorted], abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
          await rm(partial, { force: true }); await rm(`${partial}.idx`, { force: true })
          await rename(sorted, partial)
        }
        if (spec.relationConfig.output) {
          const statePaths = await Promise.all(readySources.map((source) => this.sourceCellStatePath(owner, source)))
          relationStateReport = await relationCellStates(partial, join(dirname(path), 'cell-states.csv'),
            spec.relationConfig, metadata(readySources[0]!).headers as string[],
            metadata(readySources[1]!).headers as string[], statePaths,
            readySources[0]!.row_count ?? 0, readySources[1]!.row_count ?? 0, expectedRows, abort.signal)
          const projected = join(dirname(path), 'relation-projected.csv')
          await projectRelationOutput(partial, projected, spec.relationConfig, metadata(readySources[0]!).headers as string[],
            metadata(readySources[1]!).headers as string[], expectedRows, abort.signal)
          await rm(partial, { force: true })
          await rename(projected, partial)
        }
        await rm(leftPrepared, { force: true }); await rm(rightPrepared, { force: true }); await rm(keyIndex, { force: true })
      } else if (spec.mode === 'relation') {
        throw new RelationError('关联规则快照缺失')
      } else if (spec.mode.startsWith('horizontal')) {
        await writeHorizontalConcat(inputPaths, partial, readySources.map((source) => source.row_count ?? 0), spec.mode === 'horizontal-pad', abort.signal)
      } else if (spec.mode === 'intersection') {
        const headers = readySources.map((source) => metadata(source).headers as string[])
        const shared = headers[0]!.filter((name) => headers.slice(1).every((row) => row.includes(name)))
        const projected: string[] = []
        for (let index = 0; index < inputPaths.length; index += 1) {
          const next = join(dirname(path), `input-${index}.csv`)
          const positions = shared.map((name) => String(headers[index]!.indexOf(name) + 1)).join(',')
          await runQsv(this.binary, ['select', positions, '--output', next, inputPaths[index]!], abort.signal,
            256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
          projected.push(next)
        }
        await runQsv(this.binary, ['cat', 'rows', '--output', partial, ...projected], abort.signal,
          256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        for (const temporary of projected) await rm(temporary, { force: true })
      } else {
        await runQsv(this.binary, ['cat', spec.mode === 'strict' ? 'rows' : 'rowskey', '--output', partial, ...inputPaths], abort.signal,
          256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      }
      const inspected = await inspectCsv(partial, abort.signal)
      if (inspected.rowCount !== expectedRows) throw new CsvValidationError('合并结果行数与预期不一致')
      let mergedStateReport: { file: string; rows: number } | undefined = relationStateReport
      if (spec.mode === 'reshape' && spec.reshapeConfig?.kind !== 'group-join' && spec.reshapeConfig) {
        const source = readySources[0]!
        mergedStateReport = await reshapeCellStates(partial, join(dirname(path), 'cell-states.csv'),
          spec.reshapeConfig, metadata(source).headers as string[], await this.sourceCellStatePath(owner, source),
          reshapeRowMap, source.row_count ?? 0, expectedRows, abort.signal)
        if (reshapeRowMap) await rm(reshapeRowMap, { force: true })
      } else if (spec.mode === 'set' && setRowMap && setStatePaths) {
        const combinedPath = join(dirname(path), 'set-input-states.csv')
        const joined = await mergeCellStates(readySources.map((source, index) => ({
          reportPath: setStatePaths![index], rowCount: source.row_count ?? 0, headers: metadata(source).headers as string[],
        })), [...new Set(readySources.flatMap((source) => metadata(source).headers as string[]))], combinedPath, false, abort.signal)
        if (joined) mergedStateReport = await mapCellStates(combinedPath, setRowMap, join(dirname(path), 'cell-states.csv'),
          expectedRows, rowsIn, abort.signal)
        await rm(combinedPath, { force: true }); await rm(setRowMap, { force: true })
      } else if (spec.mode === 'strict' || spec.mode === 'intersection' || spec.mode === 'union' || spec.mode.startsWith('horizontal')) {
        const reports = await Promise.all(readySources.map((source) => this.sourceCellStatePath(owner, source)))
        const inputs = readySources.map((source, index) => ({
          reportPath: reports[index], rowCount: source.row_count ?? 0, headers: metadata(source).headers as string[],
        }))
        mergedStateReport = spec.mode.startsWith('horizontal')
          ? await horizontalCellStates(inputs, inspected.headers, expectedRows, join(dirname(path), 'cell-states.csv'), abort.signal)
          : await mergeCellStates(inputs, inspected.headers, join(dirname(path), 'cell-states.csv'), spec.mode === 'union', abort.signal)
      }
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立结果索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const counted = Number((await runQsv(this.binary, ['count', path], abort.signal)).trim())
      if (counted !== expectedRows) throw new QsvCommandError('合并结果记录数无法核对')
      const relationReportDetails = await Promise.all(relationReports.map(async (report) => {
        const reportPath = join(dirname(path), report.file)
        await syncFile(reportPath)
        const digest = await digestFile(reportPath, abort.signal)
        return { ...report, bytes: digest.bytes, sha256: digest.sha256 }
      }))
      let cellStateReport: { file: string; rows: number; bytes: number; sha256: string } | undefined
      if (mergedStateReport) {
        const statePath = join(dirname(path), mergedStateReport.file)
        await syncFile(statePath)
        const stateDigest = await digestFile(statePath, abort.signal)
        cellStateReport = { ...mergedStateReport, bytes: stateDigest.bytes, sha256: stateDigest.sha256 }
      }
      if (relationReportDetails.length || cellStateReport) await syncDirectory(dirname(path))
      const sourceSchemas = readySources.map((resource) => ({ headers: metadata(resource).headers as string[],
        types: columnTypes(metadata(resource).columnTypes) }))
      let typeSequence: ColumnType[] = []
      if (spec.mode.startsWith('horizontal')) {
        typeSequence = sourceSchemas.flatMap((schema) => schema.headers.map((_, index) => schema.types[`c_${index}`] ?? 'string'))
      } else if (['strict', 'union', 'intersection'].includes(spec.mode)) {
        typeSequence = inspected.headers.map((name) => {
          const found = sourceSchemas.flatMap((schema) => {
            const at = schema.headers.indexOf(name)
            return at < 0 || schema.headers.lastIndexOf(name) !== at ? [] : [schema.types[`c_${at}`] ?? 'string']
          })
          return found.length && found.every((type) => type === found[0]) ? found[0]! : 'string'
        })
      } else if (spec.mode === 'set' && spec.setConfig) {
        const selected = spec.setConfig.kind === 'right-difference' ? sourceSchemas[1]! : sourceSchemas[0]!
        typeSequence = selected.headers.map((_, index) => selected.types[`c_${index}`] ?? 'string')
        if (spec.setConfig.kind === 'union') typeSequence = typeSequence.map((type, index) =>
          sourceSchemas[1]!.types[`c_${index}`] === type ? type : 'string')
      } else if (spec.mode === 'relation' && spec.relationConfig?.output) {
        typeSequence = spec.relationConfig.output.columns.map((entry) =>
          sourceSchemas[entry.side === 'left' ? 0 : 1]!.types[entry.id] ?? 'string')
        if (spec.relationConfig.output.includeSourceRows) {
          typeSequence.push('integer')
          if (spec.relationConfig.kind !== 'left-semi' && spec.relationConfig.kind !== 'left-anti') {
            typeSequence.push('integer')
          }
        }
      } else if (spec.mode === 'reshape' && spec.reshapeConfig) {
        const schema = sourceSchemas[0]!
        if (spec.reshapeConfig.kind === 'split-column') {
          typeSequence = schema.headers.map((_, index) => schema.types[`c_${index}`] ?? 'string')
          if (spec.reshapeConfig.direction === 'columns') {
            typeSequence.push(...Array.from({ length: spec.reshapeConfig.maxParts }, () => 'string' as ColumnType))
          } else {
            typeSequence.push('integer', 'string')
          }
        } else if (spec.reshapeConfig.kind === 'group-join') {
          typeSequence = spec.reshapeConfig.keyIds.map((id) => schema.types[id] ?? 'string')
          typeSequence.push('string')
        }
      }
      const resultTypes = Object.fromEntries(typeSequence.flatMap((type, index) => type === 'string' ? [] :
        [[`c_${index}`, type]])) as Record<string, ColumnType>
      const details = JSON.stringify({ ...metadata(output), headers: inspected.headers, indexState: 'ready', commitVersion: 1,
        columnTypes: resultTypes,
        ...(cellStateReport ? { cellStateReport } : {}),
        ...((spec.mode === 'strict' || spec.mode === 'intersection' || spec.mode === 'union' || spec.mode === 'set' || spec.mode === 'relation' ||
          spec.mode === 'reshape' && spec.reshapeConfig?.kind !== 'group-join' || spec.mode.startsWith('horizontal')) &&
          (cellStateReport || readySources.some((source) =>
          metadata(source).cellStateLineage === true || metadata(source).cellStateReport ||
          this.db.getJob(owner.ownerKey, source.producer_job_id ?? '')?.kind === 'import')) ? { cellStateLineage: true } : {}),
        ...(spec.mode === 'reshape' && spec.reshapeConfig?.kind === 'group-join'
          ? { cellStateLineageUnavailable: '按键组合将多条记录合并为一个单元格，无法逐格保留原始空值来源' } : {}),
        ...(relationSummary ? { relationSummary } : {}),
        ...(relationReportDetails.length ? { relationReports: relationReportDetails } : {}) })
      if (Buffer.byteLength(details, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('结果元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      await writeCommit(dirname(path), { version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: String(metadata(output).originalName), createdAt: output.created_at, jobId,
        sourceId: readySources[0]!.id, sourceHash: readySources[0]!.content_hash!,
        additionalSources: readySources.slice(1).map((source) => ({ id: source.id, hash: source.content_hash! })),
        engineVersion: this.engineVersion, rowCount: expectedRows, headers: inspected.headers,
        indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes,
        metadataSnapshot: JSON.parse(details) as Record<string, unknown> })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.completeImport(owner.ownerKey, datasetId, { status: 'ready', row_count: expectedRows, column_count: inspected.headers.length,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, metadata_json: details }, jobId, expectedRows, rowsIn)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '合并文件已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: '合并超过 30 分钟，已停止', retryable: true }
          : { code: 'COMBINE_FAILED', message: error instanceof CsvValidationError || error instanceof QsvCommandError || error instanceof RelationError || error instanceof SetOperationError || error instanceof ReshapeError || error instanceof CellStateLineageError ? error.message : '处理失败', retryable: false },
        { outputId: datasetId, rowsIn, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runExport(owner: Identity, jobId: string, exportId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const output = this.db.getResource(owner.ownerKey, exportId)
    if (!job || !output || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { sourceId: string; sourceHash: string; format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet' | 'zip'; safeText: boolean; report?: boolean; textOptions?: TextExportOptions; jsonOptions?: JsonExportOptions; workbook?: ExportWorkbook; sourceHashes?: string[]; scope?: ExportScope }
    const source = this.db.getResource(owner.ownerKey, spec.sourceId)
    const sourceIds = spec.workbook?.sourceIds ?? [spec.sourceId]
    const sources = sourceIds.map((id) => this.db.getResource(owner.ownerKey, id))
    const sourceHashes = spec.sourceHashes ?? [spec.sourceHash]
    if (!source || sourceIds.length !== sourceHashes.length || sources.some((item, index) => !item || item.kind !== 'dataset' ||
      item.status !== 'ready' || !item.storage_relpath || item.content_hash !== sourceHashes[index])) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '输入数据集已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, exportId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, exportId, `export.${spec.format}`)
    const path = join(this.dataDir, relpath)
    const partial = spec.format === 'xlsx' || spec.format === 'ods' ? join(dirname(path), `export.partial.${spec.format}`) : `${path}.partial`
    let durableCommit = false
    let reportGeneratedAt: number | null = null
    const exportRows = spec.scope ? spec.scope.endRow - spec.scope.startRow + 1 : sources.reduce((sum, item) => sum + (item!.row_count ?? 0), 0)
    const exportColumns = spec.scope ? spec.scope.columnIds.length : Math.max(...sources.map((item) => item!.column_count ?? 0))
    try {
      let sourcePath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '写出完整数据' }, null)
      if (spec.scope) {
        const scopedPath = join(dirname(path), 'selected-input.csv')
        await writeExportScope(sourcePath, scopedPath, spec.scope, source.row_count ?? 0, source.column_count ?? 0, abort.signal)
        sourcePath = scopedPath
      }
      if (spec.report) {
        if (!['zip', 'xlsx'].includes(spec.format) || !metadata(source).compareSummary || !source.producer_job_id) {
          throw new CompareReportError('核对报告来源无效')
        }
        const compareJob = this.db.getJob(owner.ownerKey, source.producer_job_id)
        if (!compareJob || compareJob.kind !== 'compare' || compareJob.state !== 'succeeded') {
          throw new CompareReportError('原核对任务不可用')
        }
        const compareSpec = JSON.parse(compareJob.spec_json) as { leftId: string; rightId: string; leftHash: string; rightHash: string; config: CompareConfig }
        const left = this.db.getResource(owner.ownerKey, compareSpec.leftId)
        const right = this.db.getResource(owner.ownerKey, compareSpec.rightId)
        reportGeneratedAt = Date.now()
        const report = await writeCompareReport(sourcePath, partial, join(dirname(path), 'report-work'),
          spec.format as 'zip' | 'xlsx', {
            resultId: source.id, resultHash: source.content_hash!, resultCreatedAt: source.created_at,
            comparedAt: compareJob.finished_at ?? source.updated_at, generatedAt: reportGeneratedAt, jobId: compareJob.id,
            engineVersion: compareJob.engine_version,
            left: { id: compareSpec.leftId, name: left?.name ?? compareSpec.leftId, hash: compareSpec.leftHash },
            right: { id: compareSpec.rightId, name: right?.name ?? compareSpec.rightId, hash: compareSpec.rightHash },
            config: compareSpec.config, summary: metadata(source).compareSummary as unknown as CompareSummary,
            annotations: (detailRows) => new Map(this.db.listCompareAnnotations(owner.ownerKey, source.id, detailRows)
              .map((annotation) => [annotation.detail_row, { status: annotation.status, note: annotation.note }])),
          }, abort.signal)
        if (report.detailRows !== source.row_count) throw new CompareReportError('报告明细数与结果资源不一致')
      } else if (spec.format === 'parquet') {
        const workDir = join(dirname(path), 'parquet-work')
        await runQsv(this.binary, ['to', 'parquet', '--all-strings', '--quiet', '--table', 'export', workDir, sourcePath],
          abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        await rename(join(workDir, 'export.parquet'), partial)
        await rm(workDir, { recursive: true, force: true })
      } else if (spec.format === 'xlsx' || spec.format === 'ods') {
        this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '检查工作簿单元格长度' }, null)
        if (spec.workbook) {
          const inputDir = join(dirname(path), 'workbook-inputs')
          await ensureDurableDirectory(dirname(path), 'workbook-inputs')
          const paths: string[] = []
          if (spec.workbook.rowsPerSheet) {
            const chunksDir = join(inputDir, 'parts')
            const manifest = await writeSplitFiles(sourcePath, chunksDir,
              { mode: 'rows', size: spec.workbook.rowsPerSheet, includeHeader: true }, exportRows, abort.signal)
            const names = exportSheetNames(spec.workbook, exportRows)
            if (manifest.files.length !== names.length || names.length > 20) throw new ExportScopeError('工作表数量与预检结果不一致')
            for (const [index, part] of manifest.files.entries()) {
              const staged = join(inputDir, `${names[index]}.csv`)
              await link(join(chunksDir, part.name), staged)
              await scanWorkbookCells(staged, abort.signal)
              paths.push(staged)
            }
          } else {
            for (let index = 0; index < sources.length; index += 1) {
              const item = sources[index]!
              const staged = join(inputDir, `${spec.workbook.sheetNames[index]}.csv`)
              await link(spec.workbook.sourceIds.length === 1 ? sourcePath :
                await checkedResourcePath(this.dataDir, owner.workspaceId, item.storage_relpath!), staged)
              await scanWorkbookCells(staged, abort.signal)
              paths.push(staged)
            }
          }
          await runQsv(this.binary, ['to', spec.format, '--all-strings', '--quiet', partial, ...paths], abort.signal,
            256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
          await rm(inputDir, { recursive: true, force: true })
        } else {
          await scanWorkbookCells(sourcePath, abort.signal)
          await runQsv(this.binary, ['to', spec.format, '--all-strings', '--quiet', partial, sourcePath], abort.signal,
            256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        }
      } else if (spec.format === 'json' || spec.format === 'jsonl') {
        const jsonOptions = spec.scope && spec.jsonOptions ? { ...spec.jsonOptions,
          types: Object.fromEntries(spec.scope.columnIds.map((id, index) => [`c_${index}`, spec.jsonOptions!.types[id] ?? 'text'])) } : spec.jsonOptions
        const written = await writeJsonExport(sourcePath, partial, spec.format, abort.signal, jsonOptions)
        if (written.rows !== exportRows) throw new QsvCommandError('导出记录数与输入不一致')
      } else if (spec.format === 'csv' && !spec.safeText && !spec.textOptions) {
        await pipeline(createReadStream(sourcePath), createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: abort.signal })
      } else {
        const written = await writeTextExport(sourcePath, partial, spec.format, spec.safeText, abort.signal, spec.textOptions)
        if (written.rows !== exportRows) throw new QsvCommandError('导出记录数与输入不一致')
      }
      if (spec.scope) await rm(sourcePath, { force: true })
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      const digest = await digestFile(path, abort.signal)
      const originalName = String(metadata(output).originalName)
      await writeCommit(dirname(path), { version: 1, kind: 'export', resourceId: exportId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: originalName, createdAt: output.created_at, jobId, sourceId: source.id,
        sourceHash: source.content_hash!, additionalSources: sources.slice(1).map((item) => ({ id: item!.id, hash: item!.content_hash! })),
        engineVersion: this.engineVersion, format: spec.format, rowCount: exportRows, columnCount: exportColumns,
        reportType: spec.report ? 'compare' : undefined })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      const totalRows = sources.reduce((sum, item) => sum + (item!.row_count ?? 0), 0)
      this.db.completeImport(owner.ownerKey, exportId, { status: 'ready', row_count: exportRows,
        column_count: exportColumns,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes,
        metadata_json: JSON.stringify({ ...metadata(output), commitVersion: 1, reportGeneratedAt }) }, jobId, exportRows, totalRows)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '导出文件已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, exportId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: output.metadata_json })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'EXPORT_TIMEOUT', message: '导出超过 30 分钟，已停止', retryable: true }
          : { code: 'EXPORT_FAILED', message: error instanceof CompareReportError || error instanceof ExportConfigError ||
            error instanceof ExportScopeError || error instanceof SplitError ? error.message : '导出失败，请检查数据内容与所选格式限制', retryable: false },
        { outputId: exportId, rowsIn: sources.reduce((sum, item) => sum + (item?.row_count ?? 0), 0), rowsOut: null,
          scope: spec.scope ? 'selected' : 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runSingleSourceOperation(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const dataset = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !dataset || job.state !== 'queued') return
    const spec = JSON.parse(job.spec_json) as { operation: string; sourceId: string; sourceHash: string; columnId?: string; columnIds?: string[]; mode?: string; value?: string; find?: string; replacement?: string; dateFormat?: DateInputFormat; plan?: ViewPlan | CleanPlan; patches?: CellPatch[] }
    const isClean = job.kind === 'clean'
    const isDedupe = job.kind === 'dedup'
    const isEdit = job.kind === 'edit'
    const source = this.db.getResource(owner.ownerKey, spec.sourceId)
    if (!source || source.status !== 'ready' || source.content_hash !== spec.sourceHash || !source.storage_relpath) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_CHANGED', message: '输入数据集已不可用', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: JSON.stringify({ ...metadata(dataset), indexState: 'none' }) })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    let durableCommit = false
    try {
      const sourcePath = await checkedResourcePath(this.dataDir, owner.workspaceId, source.storage_relpath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: isDedupe ? '按键排序并去重' : isClean ? '清洗全部记录' : isEdit ? '生成修正版本' : '扫描全部记录' }, null, { outputId: datasetId })
      const columnIndex = isDedupe || isEdit || spec.plan ? 0 : Number(spec.columnId!.slice(2))
      const args = isClean
        ? spec.mode === 'fill-empty'
          ? ['apply', 'emptyreplace', '--replacement', spec.replacement ?? '', '--output', partial, String(columnIndex + 1), sourcePath]
          : spec.mode === 'replace'
            ? ['apply', 'operations', 'replace', '--comparand', spec.find ?? '', '--replacement', spec.replacement ?? '', '--jobs', '1', '--output', partial, String(columnIndex + 1), sourcePath]
            : ['apply', 'operations', spec.mode, '--jobs', '1', '--output', partial, String(columnIndex + 1), sourcePath]
        : ['search', '--not-one', '--jobs', '1', '--select', String(columnIndex + 1),
            spec.mode === 'equals' ? '--exact' : '--literal', '--quiet', '--output', partial, spec.value ?? '', sourcePath]
      let removedRows = 0
      let cleanResult: Awaited<ReturnType<typeof writeCleanPlan>> | null = null
      let editResult: Awaited<ReturnType<typeof writeCellEdits>> | null = null
      let mappedStateReport: { file: string; rows: number } | undefined
      if (job.kind === 'filter') {
        const filterPlan: ViewPlan = spec.plan ? spec.plan as ViewPlan : { combine: 'and', conditions: [{
          columnId: spec.columnId!, operator: spec.mode === 'equals' ? 'equals' : 'contains', value: spec.value ?? '',
        }], sorts: [] }
        const statePath = await this.sourceCellStatePath(owner, source)
        const rowMap = statePath ? join(dirname(path), 'filtered-row-map.csv') : undefined
        const result = await writeFilteredSortedCsv(sourcePath, partial, filterPlan,
          source.row_count ?? 0, abort.signal, rowMap)
        if (statePath && rowMap) {
          mappedStateReport = await mapCellStates(statePath, rowMap, join(dirname(path), 'cell-states.csv'),
            result.rowsOut, result.rowsIn, abort.signal)
          await rm(rowMap, { force: true })
        }
      } else if (spec.operation === 'clean.plan' && spec.plan) {
        const statePath = await this.cleanCellStatePath(owner, source, spec.plan as CleanPlan)
        cleanResult = await writeCleanPlan(sourcePath, partial, spec.plan as CleanPlan, metadata(source).headers as string[],
          abort.signal, dirname(path), statePath, this.trialMode ? Number(metadata(source).sampleOriginRows) : undefined,
          statePath ? join(dirname(path), 'cell-states.csv') : undefined)
        if (cleanResult.rowsIn !== source.row_count) throw new CleanPlanError('清洗输入行数与资源记录不一致')
      } else if (spec.operation === 'cell.edit' && spec.patches) {
        const edits = validateCellPatches(source.id, spec.patches, source.row_count ?? 0, source.column_count ?? 0)
        editResult = await writeCellEdits(sourcePath, partial, metadata(source).headers as string[], edits, source.row_count ?? 0, abort.signal)
        const statePath = await this.sourceCellStatePath(owner, source)
        if (statePath) mappedStateReport = await copyCellStatesForEdits(statePath, join(dirname(path), 'cell-states.csv'),
          metadata(source).headers as string[], edits, source.row_count ?? 0, abort.signal)
      } else if (isDedupe) {
        const enumPath = join(dirname(path), 'enumerated.csv')
        const sortedPath = join(dirname(path), 'sorted.csv')
        const statePath = await this.sourceCellStatePath(owner, source)
        const rowMap = statePath ? join(dirname(path), 'dedup-row-map.csv') : undefined
        const keyIndices = (spec.columnIds ?? []).map((id) => Number(id.slice(2)))
        await runQsv(this.binary, ['enum', '--new-column', '__qsv_original_row__', '--start', '1', '--output', enumPath, sourcePath],
          abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        await runQsv(this.binary, ['index', enumPath], abort.signal)
        await runQsv(this.binary, ['extsort', '--select', keyIndices.map((index) => String(index + 1)).join(','),
          '--tmp-dir', dirname(path), enumPath, sortedPath], abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        const deduped = await keepFirstPerKey(sortedPath, partial, keyIndices, abort.signal, rowMap)
        if (deduped.rowsIn !== source.row_count) throw new QsvCommandError('去重输入行数无法核对')
        removedRows = deduped.removed
        if (statePath && rowMap) {
          mappedStateReport = await mapCellStates(statePath, rowMap, join(dirname(path), 'cell-states.csv'),
            deduped.rowsOut, deduped.rowsIn, abort.signal)
          await rm(rowMap, { force: true })
        }
        await rm(enumPath, { force: true })
        await rm(`${enumPath}.idx`, { force: true })
        await rm(sortedPath, { force: true })
      } else if (isClean && spec.mode === 'date-iso') {
        await normalizeDateColumn(sourcePath, partial, columnIndex, spec.dateFormat ?? 'yyyy-MM-dd', abort.signal)
      } else if (isClean && (spec.mode === 'nfc' || spec.mode === 'nfkc')) {
        await normalizeColumn(sourcePath, partial, columnIndex, spec.mode === 'nfc' ? 'NFC' : 'NFKC', abort.signal)
      } else {
        await runQsv(this.binary, args, abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
      }
      const inspected = await inspectCsv(partial, abort.signal)
      const sourceHeaders = metadata(source).headers as string[]
      if (JSON.stringify(inspected.headers) !== JSON.stringify(cleanResult?.headers ?? sourceHeaders)) throw new CsvValidationError('处理结果字段与预期不一致')
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立结果索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const countOutput = await runQsv(this.binary, ['count', path], abort.signal)
      const rowCount = Number(countOutput.trim())
      if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount !== inspected.rowCount ||
        (isEdit || isClean && !cleanResult ? rowCount !== source.row_count : rowCount > (source.row_count ?? 0))) {
        throw new QsvCommandError('处理结果记录数无法核对')
      }
      const cleanReports = cleanResult ? await Promise.all(cleanResult.reports.map(async (report) => {
        const reportPath = join(dirname(path), report.file)
        await syncFile(reportPath)
        const digest = await digestFile(reportPath, abort.signal)
        return { ...report, bytes: digest.bytes, sha256: digest.sha256 }
      })) : []
      let cellStateReport: { file: string; rows: number; bytes: number; sha256: string } | undefined
      if (cleanResult?.cellStateReport || mappedStateReport) {
        const report = cleanResult?.cellStateReport ?? mappedStateReport!
        const statePath = join(dirname(path), report.file)
        await syncFile(statePath)
        const stateDigest = await digestFile(statePath, abort.signal)
        cellStateReport = { ...report, bytes: stateDigest.bytes, sha256: stateDigest.sha256 }
      }
      if (cleanReports.length || cellStateReport) await syncDirectory(dirname(path))
      const originalName = String(metadata(dataset).originalName)
      const outputTypes = derivedColumnTypes(columnTypes(metadata(source).columnTypes), sourceHeaders.length, spec.operation,
        { columnId: spec.columnId, mode: spec.mode, plan: spec.operation === 'clean.plan' ? spec.plan as CleanPlan : undefined,
          patches: spec.patches })
      const metadataJson = JSON.stringify({ ...metadata(dataset), headers: inspected.headers, indexState: 'ready', commitVersion: 1,
        columnTypes: outputTypes,
        ...(cellStateReport ? { cellStateReport } : {}),
        ...((cleanResult || job.kind === 'filter' || isEdit || isDedupe) && (cellStateReport || metadata(source).cellStateLineage === true ||
          this.db.getJob(owner.ownerKey, source.producer_job_id ?? '')?.kind === 'import') ? { cellStateLineage: true } : {}),
        ...(isDedupe ? { dedup: { ...(metadata(dataset).dedup as Record<string, unknown>), removedRows } } : {}),
        ...(cleanResult ? { cleanResult: { rowsIn: cleanResult.rowsIn, rowsOut: cleanResult.rowsOut, steps: cleanResult.steps, reports: cleanReports } } : {}),
        ...(editResult ? { edit: { ...(metadata(dataset).edit as Record<string, unknown>), changedCells: editResult.changed } } : {}) })
      if (Buffer.byteLength(metadataJson, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('结果元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await writeCommit(dirname(path), { version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: originalName, createdAt: dataset.created_at, jobId, sourceId: source.id,
        sourceHash: source.content_hash!, engineVersion: this.engineVersion, rowCount, headers: inspected.headers,
        indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes,
        metadataSnapshot: JSON.parse(metadataJson) as Record<string, unknown> })
      durableCommit = true
      this.db.completeImport(owner.ownerKey, datasetId, { status: 'ready', row_count: rowCount, column_count: inspected.headers.length,
        storage_relpath: relpath, content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes, metadata_json: metadataJson },
      jobId, rowCount, source.row_count ?? rowCount)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        try { this.db.setJobState(owner.ownerKey, jobId, 'interrupted', { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
          { code: 'COMMIT_PENDING', message: '结果文件已写入，数据库登记等待恢复检查', retryable: true }) } catch { /* 下次启动核对提交凭据。 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, { status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: JSON.stringify({ ...metadata(dataset), indexState: 'none' }) })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'TASK_TIMEOUT', message: '全表处理超过 30 分钟，已停止', retryable: true }
          : { code: isDedupe ? 'DEDUP_FAILED' : isClean ? 'CLEAN_FAILED' : isEdit ? 'EDIT_FAILED' : 'FILTER_FAILED', message: error instanceof CsvValidationError || error instanceof QsvCommandError || error instanceof DateValidationError || error instanceof ViewPlanError || error instanceof CleanPlanError || error instanceof CellEditError || error instanceof CellStateLineageError ? error.message : '全表处理失败', retryable: false },
        { outputId: datasetId, rowsIn: source.row_count, rowsOut: null, scope: 'full' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }

  private async runImport(owner: Identity, jobId: string, datasetId: string) {
    const job = this.db.getJob(owner.ownerKey, jobId)
    const dataset = this.db.getResource(owner.ownerKey, datasetId)
    if (!job || !dataset || job.state !== 'queued') return
    const rawId = (JSON.parse(job.input_ids_json) as string[])[0]!
    const raw = this.db.getResource(owner.ownerKey, rawId)
    if (!raw?.storage_relpath) {
      this.db.setJobState(owner.ownerKey, jobId, 'failed', { mode: 'stage', percent: null, stage: '失败' },
        { code: 'INPUT_MISSING', message: '原文件不存在', retryable: false })
      this.db.updateResource(owner.ownerKey, datasetId, {
        status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null, metadata_json: JSON.stringify({ ...metadata(dataset), indexState: 'none', profileState: 'pending' }),
      })
      return
    }
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort('timeout'), this.limits.taskTimeoutMinutes * 60 * 1000)
    deadline.unref()
    this.running.set(jobId, abort)
    if (this.stopping) abort.abort('shutdown')
    const relpath = resourceRelpath(owner.workspaceId, datasetId, 'data.csv')
    const path = join(this.dataDir, relpath)
    const partial = `${path}.partial`
    const originalName = typeof metadata(dataset).originalName === 'string' ? metadata(dataset).originalName as string : dataset.name
    const spec = JSON.parse(job.spec_json) as { csv?: CsvImportOptions; json?: JsonImportOptions; sheetName?: string | null; columnTypes?: Record<string, ColumnType> }
    const options = csvImportOptions(spec.csv)
    let durableCommit = false
    let jsonImportErrorCount = 0
    let jsonConversionCount = 0
    let csvImportErrorCount = 0
    try {
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '校验 CSV' }, null, { outputId: datasetId })
      const inputPath = await checkedResourcePath(this.dataDir, owner.workspaceId, raw.storage_relpath)
      await ensureDurableDirectory(this.dataDir, dirname(relpath))
      let inspected: Awaited<ReturnType<typeof inspectCsv>>
      if (raw.format === 'csv' && isDefaultCsvOptions(options)) {
        inspected = await inspectCsv(inputPath, abort.signal)
        if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
        this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '复制原文件' }, null, { outputId: datasetId })
        await pipeline(createReadStream(inputPath), createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: abort.signal })
      } else if (raw.format === 'csv' || raw.format === 'tsv') {
        this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '按配置解析 CSV' }, null, { outputId: datasetId })
        const normalized = await normalizeCsvToFile(inputPath, partial, options, abort.signal, join(dirname(path), 'csv-errors.csv'))
        inspected = normalized
        csvImportErrorCount = normalized.errorCount
      } else if (raw.format === 'json' || raw.format === 'jsonl' || raw.format === 'ndjson') {
        this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '按配置解析 JSON' }, null, { outputId: datasetId })
        const parsed = await normalizeJsonToFile(inputPath, partial, raw.format === 'json' ? 'json' : 'jsonl', jsonImportOptions(spec.json),
          abort.signal, join(dirname(path), 'json-errors.csv'), join(dirname(path), 'json-conversions.csv'))
        inspected = parsed
        jsonImportErrorCount = parsed.errorCount
        jsonConversionCount = parsed.conversionCount
      } else if (raw.format === 'parquet') {
        this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '读取 Parquet 列' }, null, { outputId: datasetId })
        try { await readFlatParquetSchema(inputPath) }
        catch (error) { throw new ParquetSchemaError(error instanceof Error ? error.message : 'Parquet 字段无法读取') }
        const safePath = inputPath.replaceAll("'", "''")
        await runQsv(this.binary, ['sqlp', 'SKIP_INPUT', `SELECT * FROM read_parquet('${safePath}')`, '--output', partial, '--quiet'],
          abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        inspected = await inspectCsv(partial, abort.signal)
      } else {
        const sheets = await this.workbookSheets(owner, rawId, abort.signal)
        if (!spec.sheetName || !sheets.some((sheet) => sheet.name === spec.sheetName)) {
          throw new CsvValidationError('选定的工作表不存在，导入已停止')
        }
        this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '读取工作表' }, null, { outputId: datasetId })
        const extracted = join(dirname(path), 'sheet-extracted.csv')
        await runQsv(this.binary, ['excel', '--sheet', spec.sheetName, '--quiet', '--output', extracted, inputPath], abort.signal, 256 * 1024, this.limits.taskTimeoutMinutes * 60 * 1000)
        const normalized = await normalizeCsvToFile(extracted, partial, { ...options, encoding: 'utf-8', delimiter: ',', quote: '"' },
          abort.signal, join(dirname(path), 'csv-errors.csv'))
        inspected = normalized
        csvImportErrorCount = normalized.errorCount
        await rm(extracted, { force: true })
      }
      await syncFile(partial)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await rename(partial, path)
      await syncDirectory(dirname(path))
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '建立索引' }, null, { outputId: datasetId })
      await runQsv(this.binary, ['index', path], abort.signal)
      await syncFile(`${path}.idx`)
      await syncDirectory(dirname(path))
      const countOutput = await runQsv(this.binary, ['count', path], abort.signal)
      const rowCount = Number(countOutput.trim())
      if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount !== inspected.rowCount) throw new QsvCommandError('qsv 与 CSV 校验的记录数不一致')
      const headerOutput = await runQsv(this.binary, ['slice', '--len', '0', path], abort.signal, ROW_BLOCK_BYTES)
      const headerRecords = parse(headerOutput, { bom: true, relax_quotes: false }) as string[][]
      const headers = headerRecords[0] ?? []
      if (headers.length !== inspected.headers.length || headers.some((header, index) => header !== inspected.headers[index])) throw new QsvCommandError('qsv 与 CSV 校验的字段不一致')
      this.db.setJobState(owner.ownerKey, jobId, 'running', { mode: 'stage', percent: null, stage: '检查已选字段类型' }, null, { outputId: datasetId })
      await validateColumnTypes(path, headers.length, columnTypes(spec.columnTypes), abort.signal)
      let jsonImportReport: { file: string; rows: number; bytes: number; sha256: string } | undefined
      if (jsonImportErrorCount) {
        const reportPath = join(dirname(path), 'json-errors.csv')
        await syncFile(reportPath)
        const reportDigest = await digestFile(reportPath, abort.signal)
        await syncDirectory(dirname(path))
        jsonImportReport = { file: 'json-errors.csv', rows: jsonImportErrorCount, bytes: reportDigest.bytes, sha256: reportDigest.sha256 }
      }
      let csvImportReport: { file: string; rows: number; bytes: number; sha256: string } | undefined
      if (csvImportErrorCount) {
        const reportPath = join(dirname(path), 'csv-errors.csv')
        await syncFile(reportPath)
        const reportDigest = await digestFile(reportPath, abort.signal)
        await syncDirectory(dirname(path))
        csvImportReport = { file: 'csv-errors.csv', rows: csvImportErrorCount, bytes: reportDigest.bytes, sha256: reportDigest.sha256 }
      }
      let jsonConversionReport: { file: string; rows: number; bytes: number; sha256: string } | undefined
      if (jsonConversionCount) {
        const reportPath = join(dirname(path), 'json-conversions.csv')
        await syncFile(reportPath)
        const reportDigest = await digestFile(reportPath, abort.signal)
        await syncDirectory(dirname(path))
        jsonConversionReport = { file: 'json-conversions.csv', rows: jsonConversionCount,
          bytes: reportDigest.bytes, sha256: reportDigest.sha256 }
      }
      const metadataJson = JSON.stringify({ ...metadata(dataset), originalName, headers, indexState: 'ready', profileState: 'pending', commitVersion: 1,
        ...(jsonImportReport ? { jsonImportReport } : {}), ...(csvImportReport ? { csvImportReport } : {}),
        ...(jsonConversionReport ? { jsonConversionReport } : {}),
        ...(raw.format === 'parquet' ? { parquetConversion: { scalarValues: 'csv-text', nulls: 'empty-text',
          nested: 'rejected' } } : {}), columnTypes: columnTypes(spec.columnTypes) })
      if (Buffer.byteLength(metadataJson, 'utf8') > MAX_METADATA_BYTES) throw new QsvCommandError('表头元数据超过 64 KiB 限制')
      const digest = await digestFile(path, abort.signal)
      const indexDigest = await digestFile(`${path}.idx`, abort.signal)
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      await writeCommit(dirname(path), {
        version: 1, kind: 'dataset', resourceId: datasetId, ownerKey: owner.ownerKey,
        workspaceId: owner.workspaceId, relpath, sha256: digest.sha256, bytes: digest.bytes,
        name: originalName, createdAt: dataset.created_at, jobId, sourceId: rawId,
        sourceHash: raw.content_hash!, engineVersion: this.engineVersion, rowCount, headers,
        indexSha256: indexDigest.sha256, indexBytes: indexDigest.bytes,
        metadataSnapshot: JSON.parse(metadataJson) as Record<string, unknown>,
      })
      durableCommit = true
      if (abort.signal.aborted) throw new QsvCommandError('任务已取消')
      this.db.completeImport(owner.ownerKey, datasetId, {
        status: 'ready', row_count: rowCount, column_count: headers.length, storage_relpath: relpath,
        content_hash: `sha256:${digest.sha256}`, byte_size: digest.bytes,
        metadata_json: metadataJson,
      }, jobId, rowCount)
    } catch (error) {
      const cancelled = abort.signal.aborted && abort.signal.reason === 'user'
      const interrupted = this.stopping || (abort.signal.aborted && abort.signal.reason === 'shutdown')
      const timedOut = abort.signal.aborted && abort.signal.reason === 'timeout'
      if (durableCommit && !cancelled) {
        // 文件与索引已完整同步；保留凭据，让下次启动补全数据库提交。
        try {
          this.db.setJobState(owner.ownerKey, jobId, 'interrupted',
            { mode: 'stage', percent: null, stage: '文件已写入，等待恢复检查' },
            { code: 'COMMIT_PENDING', message: '文件已写入，数据库登记等待恢复检查', retryable: true })
        } catch { /* 数据库故障时保留原状态，重启仍会检查凭据 */ }
        return
      }
      await rm(dirname(path), { recursive: true, force: true })
      this.db.updateResource(owner.ownerKey, datasetId, {
        status: 'failed', row_count: null, column_count: null, storage_relpath: null,
        content_hash: null, byte_size: null,
        metadata_json: JSON.stringify({ ...metadata(dataset), indexState: 'none', profileState: 'pending' }),
      })
      this.db.setJobState(owner.ownerKey, jobId, interrupted ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
        { mode: 'stage', percent: null, stage: interrupted ? '已中断' : cancelled ? '已取消' : '失败' },
        cancelled ? null : interrupted ? { code: 'SERVICE_STOPPED', message: '服务停止，任务已中断', retryable: true }
          : timedOut ? { code: 'IMPORT_TIMEOUT', message: '导入超过 30 分钟，已停止', retryable: true }
          : { code: 'IMPORT_FAILED', message: error instanceof QsvCommandError || error instanceof CsvValidationError ||
              error instanceof JsonImportError || error instanceof ColumnTypeError || error instanceof ParquetSchemaError ? error.message : '导入失败',
            retryable: !(error instanceof CsvValidationError || error instanceof JsonImportError ||
              error instanceof ColumnTypeError || error instanceof ParquetSchemaError) },
        { outputId: datasetId, rowsIn: null, rowsOut: null, scope: 'unknown' })
    } finally { clearTimeout(deadline); this.running.delete(jobId) }
  }
}
