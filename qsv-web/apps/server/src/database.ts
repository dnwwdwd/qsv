import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ResourceRow {
  id: string
  owner_key: string
  kind: 'raw' | 'dataset' | 'report' | 'export' | 'view'
  status: 'staging' | 'building' | 'ready' | 'failed' | 'trashed'
  name: string
  format: string
  group_id: string
  version: number
  source_ids_json: string
  producer_job_id: string | null
  storage_relpath: string | null
  content_hash: string | null
  byte_size: number | null
  row_count: number | null
  column_count: number | null
  metadata_json: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface JobRow {
  id: string
  owner_key: string
  kind: string
  name: string
  state: 'draft' | 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'succeeded' | 'failed' | 'interrupted'
  retry_of: string | null
  parent_job_id?: string | null
  input_ids_json: string
  spec_json: string
  spec_hash: string
  engine_version: string
  idempotency_key: string | null
  progress_json: string
  summary_json: string
  error_json: string | null
  work_relpath: string
  created_at: number
  started_at: number | null
  finished_at: number | null
  updated_at: number
}

export interface JobProgressEvent {
  at: number
  state: JobRow['state']
  stage: string
  errorCode: string | null
}

function progressWithEvent(progress: unknown, state: JobRow['state'], at: number, errorCode: string | null,
  previous?: string): string {
  const input = progress && typeof progress === 'object' && !Array.isArray(progress)
    ? progress as Record<string, unknown> : { mode: 'unknown', percent: null }
  const stage = typeof input.stage === 'string' ? input.stage.slice(0, 120) : ''
  const current = {
    mode: input.mode === 'stage' || input.mode === 'percent' ? input.mode : 'unknown',
    percent: typeof input.percent === 'number' && Number.isFinite(input.percent)
      ? Math.max(0, Math.min(100, input.percent)) : null,
    stage,
  }
  const before = previous ? JSON.parse(previous) as { events?: JobProgressEvent[] } : undefined
  const events = Array.isArray(before?.events) ? before.events.filter((event) =>
    typeof event?.at === 'number' && typeof event?.stage === 'string' && typeof event?.state === 'string') : []
  const last = events.at(-1)
  if (!last || last.state !== state || last.stage !== stage || last.errorCode !== errorCode) {
    events.push({ at, state, stage, errorCode })
  }
  let truncated = Boolean(before && (before as { eventsTruncated?: boolean }).eventsTruncated) || events.length > 64
  const retained = events.slice(-64)
  let serialized = JSON.stringify({ ...current, events: retained, eventsTruncated: truncated })
  while (Buffer.byteLength(serialized, 'utf8') > 16 * 1024 && retained.length > 1) {
    retained.shift()
    truncated = true
    serialized = JSON.stringify({ ...current, events: retained, eventsTruncated: truncated })
  }
  return serialized
}

export interface RecipeRow {
  id: string
  owner_key: string
  family_id: string
  version: number
  kind: 'pipeline' | 'compare' | 'validate' | 'sql' | 'transform'
  name: string
  description: string
  spec_json: string
  parameter_schema: string
  compatibility_json: string
  is_current: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export interface CompareAnnotationRow { owner_key: string; result_id: string; detail_row: number;
  status: 'pending' | 'verified' | 'ignored'; note: string; updated_at: number }

const MIN_SQLITE = [3, 51, 3]
/** 当前 schema 版本；迁移脚本 0001—0005 对应 1—5。备份校验必须与之一致。 */
export const SCHEMA_VERSION = 5

function versionOkay(version: string) {
  const actual = version.split('.').map(Number)
  return MIN_SQLITE.some((part, index) => actual[index]! > part && actual.slice(0, index).every((value, i) => value === MIN_SQLITE[i]))
    || MIN_SQLITE.every((part, index) => actual[index] === part)
}

export class WebDatabase {
  readonly db: Database.Database
  readonly sqliteVersion: string

  constructor(dataDir: string) {
    this.db = new Database(join(dataDir, 'meta.sqlite'))
    this.sqliteVersion = (this.db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
    if (!versionOkay(this.sqliteVersion)) {
      this.db.close()
      throw new Error(`SQLite ${this.sqliteVersion} 不满足最低版本 3.51.3`)
    }
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('busy_timeout = 5000')
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 5) throw new Error(`数据库版本 ${version} 高于程序支持的版本`)
    if (version === 0) {
      const schema = readFileSync(new URL('../migrations/0001.sql', import.meta.url), 'utf8')
      this.db.transaction(() => {
        this.db.exec(schema)
        this.db.pragma('user_version = 1')
      })()
    }
    if (version < 2) {
      const migration = readFileSync(new URL('../migrations/0002.sql', import.meta.url), 'utf8')
      this.db.transaction(() => {
        this.db.exec(migration)
        this.db.pragma('user_version = 2')
      })()
    }
    if (version < 3) {
      const migration = readFileSync(new URL('../migrations/0003.sql', import.meta.url), 'utf8')
      this.db.transaction(() => {
        this.db.exec(migration)
        this.db.pragma('user_version = 3')
      })()
    }
    if (version < 4) {
      const migration = readFileSync(new URL('../migrations/0004.sql', import.meta.url), 'utf8')
      this.db.transaction(() => {
        this.db.exec(migration)
        this.db.pragma('user_version = 4')
      })()
    }
    if (version < 5) {
      const migration = readFileSync(new URL('../migrations/0005.sql', import.meta.url), 'utf8')
      this.db.transaction(() => {
        this.db.exec(migration)
        this.db.pragma('user_version = 5')
      })()
    }
  }

  close() { this.db.close() }

  getAppLimits(): { limits_json: string; updated_at: number } | undefined {
    return this.db.prepare('SELECT limits_json,updated_at FROM app_limits WHERE id=1')
      .get() as { limits_json: string; updated_at: number } | undefined
  }

  setAppLimits(limitsJson: string, expectedUpdatedAt: number | null) {
    return this.db.transaction(() => {
      const current = this.getAppLimits()
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return undefined
      const updatedAt = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
      this.db.prepare(`INSERT INTO app_limits(id,limits_json,updated_at) VALUES (1,?,?)
        ON CONFLICT(id) DO UPDATE SET limits_json=excluded.limits_json,updated_at=excluded.updated_at`)
        .run(limitsJson, updatedAt)
      return { limits_json: limitsJson, updated_at: updatedAt }
    })()
  }

  getUserSettings(owner: string): { settings_json: string; updated_at: number } | undefined {
    return this.db.prepare('SELECT settings_json,updated_at FROM user_settings WHERE owner_key=?')
      .get(owner) as { settings_json: string; updated_at: number } | undefined
  }

  setUserSettings(owner: string, settingsJson: string, expectedUpdatedAt: number | null) {
    return this.db.transaction(() => {
      const current = this.getUserSettings(owner)
      if ((current?.updated_at ?? null) !== expectedUpdatedAt) return undefined
      const updatedAt = Math.max(Date.now(), (current?.updated_at ?? 0) + 1)
      if (current) this.db.prepare('UPDATE user_settings SET settings_json=?,updated_at=? WHERE owner_key=?')
        .run(settingsJson, updatedAt, owner)
      else this.db.prepare('INSERT INTO user_settings(owner_key,settings_json,updated_at) VALUES (?,?,?)')
        .run(owner, settingsJson, updatedAt)
      return { settings_json: settingsJson, updated_at: updatedAt }
    })()
  }

  storageBreakdown(owner: string) {
    return this.db.prepare(`SELECT kind,status,COUNT(*) AS count,COALESCE(SUM(byte_size),0) AS bytes
      FROM resources WHERE owner_key=? AND kind!='view' AND status IN ('ready','trashed')
      GROUP BY kind,status ORDER BY kind,status`).all(owner) as { kind: string; status: string; count: number; bytes: number }[]
  }

  purgeTrashedResource(owner: string, id: string, expectedUpdatedAt: number) {
    return this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM resources WHERE owner_key=? AND id=? AND status='trashed' AND updated_at=?")
        .run(owner, id, expectedUpdatedAt)
      if (!result.changes) return false
      this.db.prepare('DELETE FROM compare_annotations WHERE owner_key=? AND result_id=?').run(owner, id)
      this.db.prepare("DELETE FROM resources WHERE owner_key=? AND kind='view' AND EXISTS (SELECT 1 FROM json_each(resources.source_ids_json) WHERE value=?)")
        .run(owner, id)
      return true
    })()
  }

  getCompareAnnotation(owner: string, resultId: string, detailRow: number): CompareAnnotationRow | undefined {
    return this.db.prepare('SELECT * FROM compare_annotations WHERE owner_key=? AND result_id=? AND detail_row=?')
      .get(owner, resultId, detailRow) as CompareAnnotationRow | undefined
  }

  listCompareAnnotations(owner: string, resultId: string, detailRows: number[]): CompareAnnotationRow[] {
    if (!detailRows.length) return []
    const markers = detailRows.map(() => '?').join(',')
    return this.db.prepare(`SELECT * FROM compare_annotations WHERE owner_key=? AND result_id=? AND detail_row IN (${markers}) ORDER BY detail_row`)
      .all(owner, resultId, ...detailRows) as CompareAnnotationRow[]
  }

  setCompareAnnotations(owner: string, resultId: string, edits: { detailRow: number; status: CompareAnnotationRow['status'] | null;
    note: string; expectedUpdatedAt: number | null }[]) {
    return this.db.transaction(() => {
      const previous = edits.map((edit) => this.getCompareAnnotation(owner, resultId, edit.detailRow))
      for (let index = 0; index < edits.length; index += 1) {
        if ((previous[index]?.updated_at ?? null) !== edits[index]!.expectedUpdatedAt) return null
      }
      for (let index = 0; index < edits.length; index += 1) {
        const edit = edits[index]!
        if (edit.status === null) {
          this.db.prepare('DELETE FROM compare_annotations WHERE owner_key=? AND result_id=? AND detail_row=?')
            .run(owner, resultId, edit.detailRow)
        } else {
          const updatedAt = Math.max(Date.now(), (previous[index]?.updated_at ?? 0) + 1)
          this.db.prepare(`INSERT INTO compare_annotations(owner_key,result_id,detail_row,status,note,updated_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(owner_key,result_id,detail_row) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=excluded.updated_at`)
            .run(owner, resultId, edit.detailRow, edit.status, edit.note, updatedAt)
        }
      }
      return this.listCompareAnnotations(owner, resultId, edits.map((edit) => edit.detailRow))
    })()
  }

  insertRecipe(row: RecipeRow) {
    this.db.prepare(`INSERT INTO recipes (id,owner_key,family_id,version,kind,name,description,spec_json,parameter_schema,compatibility_json,is_current,created_at,updated_at,deleted_at)
      VALUES (@id,@owner_key,@family_id,@version,@kind,@name,@description,@spec_json,@parameter_schema,@compatibility_json,@is_current,@created_at,@updated_at,@deleted_at)`).run(row)
  }

  getRecipe(owner: string, id: string): RecipeRow | undefined {
    return this.db.prepare('SELECT * FROM recipes WHERE owner_key=? AND id=?').get(owner, id) as RecipeRow | undefined
  }

  listCurrentRecipes(owner: string, limit = 200): RecipeRow[] {
    return this.db.prepare('SELECT * FROM recipes WHERE owner_key=? AND is_current=1 AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ?')
      .all(owner, limit) as RecipeRow[]
  }

  listRecipeVersions(owner: string, familyId: string): RecipeRow[] {
    return this.db.prepare('SELECT * FROM recipes WHERE owner_key=? AND family_id=? ORDER BY version DESC LIMIT 100')
      .all(owner, familyId) as RecipeRow[]
  }

  versionRecipe(owner: string, currentId: string, expectedUpdatedAt: number, next: RecipeRow): boolean {
    return this.db.transaction(() => {
      const updated = this.db.prepare('UPDATE recipes SET is_current=0 WHERE owner_key=? AND id=? AND is_current=1 AND deleted_at IS NULL AND updated_at=?')
        .run(owner, currentId, expectedUpdatedAt).changes
      if (!updated) return false
      this.insertRecipe(next)
      return true
    })()
  }

  deleteRecipeFamily(owner: string, id: string, expectedUpdatedAt: number): boolean {
    return this.db.transaction(() => {
      const row = this.getRecipe(owner, id)
      if (!row || row.is_current !== 1 || row.deleted_at !== null || row.updated_at !== expectedUpdatedAt) return false
      const now = Date.now()
      this.db.prepare('UPDATE recipes SET is_current=0,deleted_at=?,updated_at=? WHERE owner_key=? AND family_id=? AND deleted_at IS NULL')
        .run(now, now, owner, row.family_id)
      return true
    })()
  }

  linkJobToParent(owner: string, id: string, parentId: string) {
    return this.db.prepare('UPDATE jobs SET parent_job_id=? WHERE owner_key=? AND id=? AND parent_job_id IS NULL').run(parentId, owner, id).changes
  }

  updateJobSummary(owner: string, id: string, summary: unknown) {
    return this.db.prepare('UPDATE jobs SET summary_json=?,updated_at=? WHERE owner_key=? AND id=?')
      .run(JSON.stringify(summary), Date.now(), owner, id).changes
  }

  listChildJobs(owner: string, parentId: string): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key=? AND parent_job_id=? ORDER BY created_at,id').all(owner, parentId) as JobRow[]
  }

  interruptUnfinished() {
    return this.db.transaction(() => {
      const now = Date.now()
      const unfinished = this.db.prepare("SELECT owner_key,id FROM jobs WHERE state IN ('queued','running','cancel_requested')")
        .all() as Pick<JobRow, 'owner_key' | 'id'>[]
      for (const job of unfinished) this.setJobState(job.owner_key, job.id, 'interrupted',
        { mode: 'unknown', percent: null, stage: '服务重启，任务已中断' })
      this.db.prepare("UPDATE resources SET status = 'failed', updated_at = ? WHERE status = 'building'").run(now)
      return unfinished.length
    })()
  }

  insertResource(row: ResourceRow) {
    this.db.prepare(`INSERT INTO resources (id,owner_key,kind,status,name,format,group_id,version,source_ids_json,producer_job_id,storage_relpath,content_hash,byte_size,row_count,column_count,metadata_json,created_at,updated_at,deleted_at)
      VALUES (@id,@owner_key,@kind,@status,@name,@format,@group_id,@version,@source_ids_json,@producer_job_id,@storage_relpath,@content_hash,@byte_size,@row_count,@column_count,@metadata_json,@created_at,@updated_at,@deleted_at)`).run(row)
  }

  getResource(owner: string, id: string): ResourceRow | undefined {
    return this.db.prepare('SELECT * FROM resources WHERE owner_key = ? AND id = ?').get(owner, id) as ResourceRow | undefined
  }

  listJobOutputs(owner: string, jobId: string): ResourceRow[] {
    return this.db.prepare('SELECT * FROM resources WHERE owner_key=? AND producer_job_id=? ORDER BY created_at,id')
      .all(owner, jobId) as ResourceRow[]
  }

  listResourceVersions(owner: string, groupId: string): ResourceRow[] {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND group_id=? AND kind='dataset' ORDER BY version DESC")
      .all(owner, groupId) as ResourceRow[]
  }

  findRawByUploadKey(owner: string, key: string): ResourceRow | undefined {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND kind='raw' AND json_extract(metadata_json,'$.uploadKey')=? LIMIT 1").get(owner, key) as ResourceRow | undefined
  }

  findReadyRawByDigest(owner: string, contentHash: string, byteSize: number, format: string): ResourceRow[] {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND kind='raw' AND status='ready' AND content_hash=? AND byte_size=? AND format=? ORDER BY updated_at DESC,id DESC LIMIT 5")
      .all(owner, contentHash, byteSize, format) as ResourceRow[]
  }

  listResources(owner: string, limit = 50, offset = 0): ResourceRow[] {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key = ? AND status != ? AND kind != 'view' ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?").all(owner, 'trashed', limit, offset) as ResourceRow[]
  }

  findResources(owner: string, filters: { name?: string; format?: string; kind?: string; status?: string; from?: number; to?: number },
    offset: number, limit: number): { items: ResourceRow[]; total: number } {
    let where = "owner_key=? AND status!='trashed' AND kind!='view'"
    const values: Array<string | number> = [owner]
    if (filters.name) { where += ' AND instr(lower(name),lower(?))>0'; values.push(filters.name) }
    if (filters.format) { where += ' AND format=?'; values.push(filters.format) }
    if (filters.kind) { where += ' AND kind=?'; values.push(filters.kind) }
    if (filters.status) { where += ' AND status=?'; values.push(filters.status) }
    if (filters.from !== undefined) { where += ' AND created_at>=?'; values.push(filters.from) }
    if (filters.to !== undefined) { where += ' AND created_at<=?'; values.push(filters.to) }
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM resources WHERE ${where}`).get(...values) as { total: number }).total
    const items = this.db.prepare(`SELECT * FROM resources WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as ResourceRow[]
    return { items, total }
  }

  listTrashedResources(owner: string, limit = 50, offset = 0): ResourceRow[] {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND status='trashed' AND kind!='view' ORDER BY deleted_at DESC,id DESC LIMIT ? OFFSET ?")
      .all(owner, limit, offset) as ResourceRow[]
  }

  listExpiredTrashedResources(cutoff: number, limit = 100): ResourceRow[] {
    return this.db.prepare(`SELECT * FROM resources AS resource WHERE resource.status='trashed' AND resource.kind!='view'
      AND resource.deleted_at IS NOT NULL AND resource.deleted_at<=? AND NOT EXISTS (
        SELECT 1 FROM jobs AS job WHERE job.owner_key=resource.owner_key
        AND job.state IN ('queued','running','cancel_requested')
        AND EXISTS (SELECT 1 FROM json_each(job.input_ids_json) WHERE value=resource.id)
      ) ORDER BY resource.deleted_at ASC,resource.id ASC LIMIT ?`).all(cutoff, limit) as ResourceRow[]
  }

  countTrashedResources(owner: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM resources WHERE owner_key=? AND status='trashed' AND kind!='view'").get(owner) as { total: number }).total
  }

  resourceDependencies(owner: string, id: string) {
    const activeJobs = this.db.prepare("SELECT id,name,state FROM jobs WHERE owner_key=? AND state IN ('queued','running','cancel_requested') AND EXISTS (SELECT 1 FROM json_each(jobs.input_ids_json) WHERE value=?) ORDER BY created_at DESC LIMIT 50")
      .all(owner, id) as { id: string; name: string; state: string }[]
    const derivedResources = this.db.prepare("SELECT id,name,kind,status FROM resources WHERE owner_key=? AND id!=? AND status!='trashed' AND EXISTS (SELECT 1 FROM json_each(resources.source_ids_json) WHERE value=?) ORDER BY created_at DESC LIMIT 50")
      .all(owner, id, id) as { id: string; name: string; kind: string; status: string }[]
    return { activeJobs, derivedResources }
  }

  setResourceTrashed(owner: string, id: string, expectedUpdatedAt: number, currentStatus: 'ready' | 'failed' | 'trashed',
    nextStatus: 'ready' | 'failed' | 'trashed', metadataJson: string): ResourceRow | undefined {
    const updatedAt = Math.max(Date.now(), expectedUpdatedAt + 1)
    const result = this.db.prepare("UPDATE resources SET status=?,deleted_at=?,updated_at=?,metadata_json=? WHERE owner_key=? AND id=? AND updated_at=? AND status=? AND kind!='view'")
      .run(nextStatus, nextStatus === 'trashed' ? Date.now() : null, updatedAt, metadataJson, owner, id, expectedUpdatedAt, currentStatus)
    return result.changes ? this.getResource(owner, id) : undefined
  }

  listResourcesAfter(owner: string, limit: number, cursor: { createdAt: number; id: string } | null): ResourceRow[] {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND status!='trashed' AND kind!='view' AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(owner, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit) as ResourceRow[]
  }

  countResources(owner: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM resources WHERE owner_key = ? AND status != 'trashed' AND kind != 'view'").get(owner) as { total: number }).total
  }

  searchResources(owner: string, query: string, limit = 12): ResourceRow[] {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND status!='trashed' AND kind!='view' AND instr(lower(name),lower(?))>0 ORDER BY updated_at DESC,id DESC LIMIT ?")
      .all(owner, query, limit) as ResourceRow[]
  }

  countAllResources(owner?: string): number {
    return owner === undefined
      ? (this.db.prepare('SELECT COUNT(*) AS total FROM resources').get() as { total: number }).total
      : (this.db.prepare('SELECT COUNT(*) AS total FROM resources WHERE owner_key=?').get(owner) as { total: number }).total
  }

  countRecentRawResources(owner: string, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM resources WHERE owner_key=? AND kind='raw' AND created_at>=?").get(owner, since) as { total: number }).total
  }

  storageBytes(owner?: string): number {
    const sql = "SELECT COALESCE(SUM(byte_size),0) AS total FROM resources WHERE status IN ('ready','trashed') AND byte_size IS NOT NULL AND kind != 'view'"
    return owner === undefined
      ? (this.db.prepare(sql).get() as { total: number }).total
      : (this.db.prepare(`${sql} AND owner_key=?`).get(owner) as { total: number }).total
  }

  committedReadyResourceIds(): string[] {
    return (this.db.prepare("SELECT id FROM resources WHERE status='ready' AND json_extract(metadata_json,'$.commitVersion')=1").all() as { id: string }[]).map((row) => row.id)
  }

  findView(owner: string, sourceId: string, contentHash: string | null): ResourceRow | undefined {
    return this.db.prepare("SELECT * FROM resources WHERE owner_key=? AND kind='view' AND status='ready' AND source_ids_json=? AND content_hash=? ORDER BY created_at DESC LIMIT 1").get(owner, JSON.stringify([sourceId]), contentHash) as ResourceRow | undefined
  }

  updateResource(owner: string, id: string, changes: Pick<ResourceRow, 'status' | 'row_count' | 'column_count' | 'storage_relpath' | 'content_hash' | 'byte_size' | 'metadata_json'>) {
    return this.db.prepare(`UPDATE resources SET status=@status,row_count=@row_count,column_count=@column_count,storage_relpath=@storage_relpath,content_hash=@content_hash,byte_size=@byte_size,metadata_json=@metadata_json,updated_at=@updated_at WHERE owner_key=@owner_key AND id=@id`).run({ ...changes, updated_at: Date.now(), owner_key: owner, id }).changes
  }

  updateResourceDetails(owner: string, id: string, expectedUpdatedAt: number, name: string, metadataJson: string): ResourceRow | undefined {
    const updatedAt = Math.max(Date.now(), expectedUpdatedAt + 1)
    const result = this.db.prepare("UPDATE resources SET name=?,metadata_json=?,updated_at=? WHERE owner_key=? AND id=? AND updated_at=? AND status!='trashed'")
      .run(name, metadataJson, updatedAt, owner, id, expectedUpdatedAt)
    return result.changes ? this.getResource(owner, id) : undefined
  }

  insertJob(row: JobRow) {
    this.db.prepare(`INSERT INTO jobs (id,owner_key,kind,name,state,retry_of,input_ids_json,spec_json,spec_hash,engine_version,idempotency_key,progress_json,summary_json,error_json,work_relpath,created_at,started_at,finished_at,updated_at)
      VALUES (@id,@owner_key,@kind,@name,@state,@retry_of,@input_ids_json,@spec_json,@spec_hash,@engine_version,@idempotency_key,@progress_json,@summary_json,@error_json,@work_relpath,@created_at,@started_at,@finished_at,@updated_at)`).run({
      ...row, progress_json: progressWithEvent(JSON.parse(row.progress_json) as unknown, row.state, row.created_at, null),
    })
  }

  createImport(resource: ResourceRow, job: JobRow) {
    this.db.transaction(() => {
      this.insertResource(resource)
      this.insertJob(job)
    })()
  }

  completeImport(owner: string, datasetId: string, resourceChanges: Parameters<WebDatabase['updateResource']>[2], jobId: string, rowCount: number, rowsIn = rowCount) {
    this.db.transaction(() => {
      const prior = this.getJob(owner, jobId)
      const scope = prior && (JSON.parse(prior.summary_json) as { scope?: string }).scope === 'selected' ? 'selected' : 'full'
      this.updateResource(owner, datasetId, resourceChanges)
      this.setJobState(owner, jobId, 'succeeded', { mode: 'stage', percent: null, stage: '完成' }, null,
        { outputId: datasetId, rowsIn, rowsOut: rowCount, scope })
    })()
  }

  getJob(owner: string, id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key = ? AND id = ?').get(owner, id) as JobRow | undefined
  }

  findJobByKey(owner: string, key: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key = ? AND idempotency_key = ?').get(owner, key) as JobRow | undefined
  }

  findJobByRetryOf(owner: string, originalId: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key = ? AND retry_of = ? ORDER BY created_at DESC,id DESC LIMIT 1').get(owner, originalId) as JobRow | undefined
  }

  listJobs(owner: string, limit = 50, offset = 0): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key = ? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(owner, limit, offset) as JobRow[]
  }

  findJobs(owner: string, filters: { name?: string; kind?: string; state?: string; inputId?: string; from?: number; to?: number },
    offset: number, limit: number): { items: JobRow[]; total: number } {
    let where = 'owner_key=?'
    const values: Array<string | number> = [owner]
    if (filters.name) { where += ' AND instr(lower(name),lower(?))>0'; values.push(filters.name) }
    if (filters.kind) { where += ' AND kind=?'; values.push(filters.kind) }
    if (filters.state) { where += ' AND state=?'; values.push(filters.state) }
    if (filters.inputId) { where += ' AND EXISTS (SELECT 1 FROM json_each(jobs.input_ids_json) WHERE value=?)'; values.push(filters.inputId) }
    if (filters.from !== undefined) { where += ' AND created_at>=?'; values.push(filters.from) }
    if (filters.to !== undefined) { where += ' AND created_at<=?'; values.push(filters.to) }
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE ${where}`).get(...values) as { total: number }).total
    const items = this.db.prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as JobRow[]
    return { items, total }
  }

  listJobsAfter(owner: string, limit: number, cursor: { createdAt: number; id: string } | null): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key=? AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(owner, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit) as JobRow[]
  }

  listAttentionJobs(owner: string, limit = 5): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE owner_key = ? AND state IN ('failed','interrupted') AND id NOT IN (SELECT retry_of FROM jobs WHERE owner_key=? AND retry_of IS NOT NULL) ORDER BY updated_at DESC,id DESC LIMIT ?").all(owner, owner, limit) as JobRow[]
  }

  countAttentionJobs(owner: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS total FROM jobs WHERE owner_key=? AND state IN ('failed','interrupted') AND id NOT IN (SELECT retry_of FROM jobs WHERE owner_key=? AND retry_of IS NOT NULL)").get(owner, owner) as { total: number }).total
  }

  countJobs(owner: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS total FROM jobs WHERE owner_key = ?').get(owner) as { total: number }).total
  }

  searchJobs(owner: string, query: string, limit = 12): JobRow[] {
    return this.db.prepare('SELECT * FROM jobs WHERE owner_key=? AND instr(lower(name),lower(?))>0 ORDER BY updated_at DESC,id DESC LIMIT ?')
      .all(owner, query, limit) as JobRow[]
  }

  countActiveJobs(owner?: string): number {
    const sql = "SELECT COUNT(*) AS total FROM jobs WHERE state IN ('queued','running','cancel_requested')"
    return owner === undefined ? (this.db.prepare(sql).get() as { total: number }).total
      : (this.db.prepare(`${sql} AND owner_key=?`).get(owner) as { total: number }).total
  }

  countRecentJobs(owner: string, since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS total FROM jobs WHERE owner_key=? AND created_at>=?').get(owner, since) as { total: number }).total
  }

  countJobsByState(owner: string): Record<string, number> {
    const rows = this.db.prepare('SELECT state,COUNT(*) AS total FROM jobs WHERE owner_key = ? GROUP BY state').all(owner) as { state: string; total: number }[]
    return Object.fromEntries(rows.map((row) => [row.state, row.total]))
  }

  setJobState(owner: string, id: string, state: JobRow['state'], progress: unknown, error: unknown = null, summary?: unknown) {
    const now = Date.now()
    const previous = this.getJob(owner, id)
    if (!previous) return 0
    const errorCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code.slice(0, 80) : null
    const progressJson = progressWithEvent(progress, state, now, errorCode, previous.progress_json)
    return this.db.prepare(`UPDATE jobs SET state=?,progress_json=?,error_json=?,summary_json=COALESCE(?,summary_json),started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,finished_at=CASE WHEN ? IN ('succeeded','failed','cancelled','interrupted') THEN ? ELSE finished_at END,updated_at=? WHERE owner_key=? AND id=?`).run(
      state, progressJson, error === null ? null : JSON.stringify(error), summary === undefined ? null : JSON.stringify(summary), state, now, state, now, now, owner, id,
    ).changes
  }
}
