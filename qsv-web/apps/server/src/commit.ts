import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, lstat, readFile } from 'node:fs/promises'
import type { QualitySummary } from './quality.ts'

interface CommitBase {
  version: 1
  resourceId: string
  ownerKey: string
  workspaceId: string
  relpath: string
  sha256: string
  bytes: number
  name: string
  createdAt: number
}

export interface RawCommit extends CommitBase {
  kind: 'raw'
  uploadKey: string
}

export interface DatasetCommit extends CommitBase {
  kind: 'dataset'
  jobId: string
  sourceId: string
  sourceHash: string
  additionalSources?: { id: string; hash: string }[]
  compareSummary?: Record<string, number>
  qualitySummary?: QualitySummary
  engineVersion: string
  rowCount: number
  headers: string[]
  indexSha256: string
  indexBytes: number
  metadataSnapshot?: Record<string, unknown>
}

export interface ExportCommit extends CommitBase {
  kind: 'export'
  jobId: string
  sourceId: string
  sourceHash: string
  additionalSources?: { id: string; hash: string }[]
  engineVersion: string
  format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet' | 'zip'
  rowCount: number
  columnCount?: number
  splitManifest?: { sha256: string; bytes: number }
  reportType?: 'compare'
}

export type Commit = RawCommit | DatasetCommit | ExportCommit

export async function syncFile(path: string) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export async function syncDirectory(path: string) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** 每新建一层目录都同步其父目录，避免文件已提交但目录项在断电后丢失。 */
export async function ensureDurableDirectory(root: string, relative: string) {
  let current = root
  for (const part of relative.split(sep)) {
    if (!part || part === '.' || part === '..') throw new Error('目录路径无效')
    const next = join(current, part)
    try { await mkdir(next, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const info = await lstat(next)
    if (!info.isDirectory()) throw new Error('资源目录不是普通目录')
    await syncDirectory(current)
    current = next
  }
}

/** 凭据先于数据库 ready 状态落盘，重启时可核对并补全登记。 */
export async function writeCommit(resourceDirectory: string, commit: Commit) {
  const path = join(resourceDirectory, 'commit.json')
  const temporary = join(resourceDirectory, `commit.${randomUUID()}.partial`)
  try {
    const serialized = JSON.stringify(commit)
    if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) throw new Error('提交凭据超过 256 KiB')
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(serialized)
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, path)
    await syncDirectory(resourceDirectory)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

export async function readCommit(path: string): Promise<unknown> {
  const file = await lstat(path)
  if (!file.isFile() || file.size > 256 * 1024) throw new Error('提交凭据无效或过大')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export function isCommit(value: unknown): value is Commit {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (item.version !== 1 || !['raw', 'dataset', 'export'].includes(String(item.kind)) ||
    typeof item.resourceId !== 'string' || !/^res_[0-9a-f-]{36}$/.test(item.resourceId) ||
    typeof item.ownerKey !== 'string' || !/^[0-9a-f]{64}$/.test(item.ownerKey) ||
    item.workspaceId !== item.ownerKey.slice(0, 24) ||
    typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
    !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 ||
    typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 255 || /[\x00-\x1f/\\]/.test(item.name) ||
    !Number.isSafeInteger(item.createdAt) || Number(item.createdAt) < 0) return false
  const rawExtension = /\.(csv|tsv|xlsx|xls|xlsm|xlsb|ods|json|jsonl|ndjson|parquet)$/i.exec(item.name as string)?.[1]?.toLowerCase()
  if (item.kind === 'raw' && !rawExtension) return false
  const exportFormat = ['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet', 'zip'].includes(String(item.format)) ? item.format : null
  if (item.kind === 'export' && !exportFormat) return false
  const expectedPath = join('owners', item.workspaceId as string, 'resources', item.resourceId,
    item.kind === 'raw' ? `original.${rawExtension}` : item.kind === 'export' ? `export.${exportFormat}` : 'data.csv')
  if (item.relpath !== expectedPath) return false
  if (item.kind === 'raw') return typeof item.uploadKey === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(item.uploadKey)
  const common = typeof item.jobId === 'string' && /^job_[0-9a-f-]{36}$/.test(item.jobId) &&
    typeof item.sourceId === 'string' && /^res_[0-9a-f-]{36}$/.test(item.sourceId) &&
    typeof item.sourceHash === 'string' && /^sha256:[0-9a-f]{64}$/.test(item.sourceHash) &&
    typeof item.engineVersion === 'string' && item.engineVersion.length > 0 &&
    Number.isSafeInteger(item.rowCount) && Number(item.rowCount) >= 0
  if (!common) return false
  if (item.additionalSources !== undefined && (!Array.isArray(item.additionalSources) || item.additionalSources.length > 19 ||
    !item.additionalSources.every((source: unknown) => source !== null && typeof source === 'object' &&
      /^res_[0-9a-f-]{36}$/.test(String((source as Record<string, unknown>).id)) &&
      /^sha256:[0-9a-f]{64}$/.test(String((source as Record<string, unknown>).hash))))) return false
  if (item.kind === 'export') {
    if (item.columnCount !== undefined && (!Number.isSafeInteger(item.columnCount) || Number(item.columnCount) < 1 || Number(item.columnCount) > 16_384)) return false
    if (item.additionalSources?.length && !['xlsx', 'ods'].includes(String(item.format))) return false
    if (item.format === 'zip') {
      const manifest = item.splitManifest as Record<string, unknown> | undefined
      if (item.reportType === 'compare') {
        if (manifest !== undefined) return false
      } else if (!manifest || typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
        !Number.isSafeInteger(manifest.bytes) || Number(manifest.bytes) < 1 || Number(manifest.bytes) > 8 * 1024 * 1024) return false
    } else if (item.splitManifest !== undefined) return false
    if (item.reportType !== undefined && (item.reportType !== 'compare' || !['zip', 'xlsx'].includes(String(item.format)))) return false
    return true
  }
  if (item.compareSummary !== undefined && (item.compareSummary === null || typeof item.compareSummary !== 'object' ||
    Array.isArray(item.compareSummary) || Object.keys(item.compareSummary).length > 20 ||
    Object.values(item.compareSummary).some((count) => !Number.isSafeInteger(count) || Number(count) < 0))) return false
  if (item.qualitySummary !== undefined) {
    if (item.qualitySummary === null || typeof item.qualitySummary !== 'object' || Array.isArray(item.qualitySummary)) return false
    const summary = item.qualitySummary as Record<string, unknown>
    if (!['checkedRows', 'failedRows', 'violations'].every((key) => Number.isSafeInteger(summary[key]) && Number(summary[key]) >= 0) ||
      !Array.isArray(summary.ruleFailures) || summary.ruleFailures.length > 32 ||
      summary.ruleFailures.some((count: unknown) => !Number.isSafeInteger(count) || Number(count) < 0)) return false
  }
  if (item.metadataSnapshot !== undefined) {
    if (!item.metadataSnapshot || typeof item.metadataSnapshot !== 'object' || Array.isArray(item.metadataSnapshot) ||
      Buffer.byteLength(JSON.stringify(item.metadataSnapshot), 'utf8') > 64 * 1024) return false
    const snapshot = item.metadataSnapshot as Record<string, unknown>
    if (snapshot.originalName !== item.name || snapshot.indexState !== 'ready' ||
      JSON.stringify(snapshot.headers) !== JSON.stringify(item.headers)) return false
    if (snapshot.cleanResult !== undefined) {
      const result = snapshot.cleanResult as Record<string, unknown>
      if (!result || typeof result !== 'object' || !Array.isArray(result.reports) || result.reports.length > 24 ||
        result.reports.some((report: unknown) => {
          if (!report || typeof report !== 'object') return true
          const item = report as Record<string, unknown>
          return !Number.isInteger(item.step) || Number(item.step) < 1 || Number(item.step) > 24 ||
            !['errors', 'duplicates', 'empty-rows'].includes(String(item.kind)) ||
            item.file !== `clean-step-${item.step}-${item.kind}.csv` ||
            !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 ||
            typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)
        })) return false
    }
    if (snapshot.cellStateReport !== undefined) {
      const report = snapshot.cellStateReport as Record<string, unknown>
      if (!report || typeof report !== 'object' || report.file !== 'cell-states.csv' ||
        !Number.isSafeInteger(report.rows) || Number(report.rows) < 1 ||
        !Number.isSafeInteger(report.bytes) || Number(report.bytes) < 1 ||
        typeof report.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(report.sha256)) return false
    }
    if (snapshot.cellStateLineage !== undefined && snapshot.cellStateLineage !== true) return false
    if (snapshot.cellStateLineageUnavailable !== undefined &&
      (typeof snapshot.cellStateLineageUnavailable !== 'string' || snapshot.cellStateLineageUnavailable.length > 200)) return false
    if (snapshot.relationReports !== undefined) {
      if (!Array.isArray(snapshot.relationReports) || snapshot.relationReports.length > 2 ||
        snapshot.relationReports.some((report: unknown) => {
          if (!report || typeof report !== 'object') return true
          const item = report as Record<string, unknown>
          return !['left', 'right'].includes(String(item.side)) ||
            item.file !== `relation-unmatched-${item.side}.csv` ||
            !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 ||
            typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)
        })) return false
    }
  }
  return typeof item.indexSha256 === 'string' && /^[0-9a-f]{64}$/.test(item.indexSha256) &&
    Number.isSafeInteger(item.indexBytes) && Number(item.indexBytes) > 0 &&
    Array.isArray(item.headers) && item.headers.length > 0 && item.headers.length <= 4096 &&
    item.headers.every((header: unknown) => typeof header === 'string')
}

export async function verifyCommit(dataDir: string, commit: Commit) {
  const path = join(dataDir, commit.relpath)
  const file = await lstat(path)
  if (!file.isFile() || file.size !== commit.bytes) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== commit.sha256) return false
  if (commit.kind === 'dataset') {
    const index = await lstat(`${path}.idx`)
    if (!index.isFile() || index.size !== commit.indexBytes) return false
    const indexHash = createHash('sha256')
    for await (const chunk of createReadStream(`${path}.idx`)) indexHash.update(chunk)
    if (indexHash.digest('hex') !== commit.indexSha256) return false
    const snapshot = commit.metadataSnapshot
    if (snapshot) for (const key of ['jsonImportReport', 'csvImportReport', 'jsonConversionReport', 'cellStateReport']) {
      const report = snapshot[key] as { file?: unknown; bytes?: unknown; sha256?: unknown } | undefined
      if (!report) continue
      const expectedFile = key === 'jsonImportReport' ? 'json-errors.csv' : key === 'csvImportReport' ? 'csv-errors.csv' :
        key === 'cellStateReport' ? 'cell-states.csv' : 'json-conversions.csv'
      if (report.file !== expectedFile || !Number.isSafeInteger(report.bytes) || Number(report.bytes) < 1 ||
        typeof report.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(report.sha256)) return false
      const reportPath = join(dataDir, commit.relpath, '..', expectedFile)
      const info = await lstat(reportPath)
      if (!info.isFile() || info.size !== report.bytes) return false
      const reportHash = createHash('sha256')
      for await (const block of createReadStream(reportPath)) reportHash.update(block)
      if (reportHash.digest('hex') !== report.sha256) return false
    }
    const cleanResult = snapshot?.cleanResult as { reports?: { file: string; bytes: number; sha256: string }[] } | undefined
    for (const report of cleanResult?.reports ?? []) {
      const reportPath = join(dataDir, commit.relpath, '..', report.file)
      const info = await lstat(reportPath)
      if (!info.isFile() || info.size !== report.bytes) return false
      const reportHash = createHash('sha256')
      for await (const block of createReadStream(reportPath)) reportHash.update(block)
      if (reportHash.digest('hex') !== report.sha256) return false
    }
    const relationReports = snapshot?.relationReports as { file: string; bytes: number; sha256: string }[] | undefined
    for (const report of relationReports ?? []) {
      const reportPath = join(dataDir, commit.relpath, '..', report.file)
      const info = await lstat(reportPath)
      if (!info.isFile() || info.size !== report.bytes) return false
      const reportHash = createHash('sha256')
      for await (const block of createReadStream(reportPath)) reportHash.update(block)
      if (reportHash.digest('hex') !== report.sha256) return false
    }
  }
  if (commit.kind === 'export' && commit.format === 'zip' && commit.splitManifest) {
    const directory = join(dataDir, commit.relpath, '..')
    const manifestPath = join(directory, 'manifest.json')
    const manifestFile = await lstat(manifestPath)
    if (!manifestFile.isFile() || manifestFile.size !== commit.splitManifest.bytes) return false
    const manifestBytes = await readFile(manifestPath)
    if (createHash('sha256').update(manifestBytes).digest('hex') !== commit.splitManifest.sha256) return false
    let manifest: unknown
    try { manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown } catch { return false }
    const value = manifest as Record<string, unknown>
    if (!value || value.version !== 1 || !['rows', 'value'].includes(String(value.mode)) ||
      !Number.isSafeInteger(value.sourceRows) || value.sourceRows !== commit.rowCount ||
      !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 1000) return false
    let rows = 0
    const names = new Set<string>()
    for (const raw of value.files) {
      const file = raw as Record<string, unknown>
      if (!file || typeof file.name !== 'string' || !/^(chunk_[0-9]{5,}|part_[0-9a-f]{64})\.csv$/.test(file.name) || names.has(file.name) ||
        !Number.isSafeInteger(file.rows) || Number(file.rows) < 0 || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 1 ||
        typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !(file.value === null || typeof file.value === 'string')) return false
      names.add(file.name)
      rows += Number(file.rows)
      const chunkPath = join(directory, 'chunks', file.name)
      const chunk = await lstat(chunkPath)
      if (!chunk.isFile() || chunk.size !== file.bytes) return false
      const chunkHash = createHash('sha256')
      for await (const block of createReadStream(chunkPath)) chunkHash.update(block)
      if (chunkHash.digest('hex') !== file.sha256) return false
    }
    if (rows !== commit.rowCount) return false
  }
  return true
}
