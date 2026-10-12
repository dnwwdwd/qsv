import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { WebDatabase, type JobRow, type ResourceRow } from './database.ts'
import { resourceRelpath } from './files.ts'
import { WorkbenchService } from './service.ts'
import { recoverStartup } from './recovery.ts'
import { writeCommit } from './commit.ts'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

test('startup restores committed files and interrupts jobs without a complete checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-recover-'))
  const ownerKey = 'a'.repeat(64)
  const workspaceId = ownerKey.slice(0, 24)
  const owner = { ownerKey, workspaceId, displayName: '测试用户', source: 'local' as const }
  let db = new WebDatabase(directory)
  try {
    const service = new WorkbenchService(db, directory, '', 'qsv test')
    const raw = await service.upload(owner, Readable.from(['id\n1\n']), 'sample.csv', 'recovery-upload-0001', 5)
    db.db.prepare('DELETE FROM resources WHERE id = ?').run(raw.id)
    db.close()
    db = new WebDatabase(directory)
    const first = await recoverStartup(db, directory)
    assert.equal(first.rawRestored, 1)
    const restoredRaw = db.getResource(ownerKey, raw.id)!
    assert.equal(restoredRaw.content_hash, `sha256:${sha('id\n1\n')}`)

    const now = Date.now()
    const datasetId = `res_${randomUUID()}`
    const jobId = `job_${randomUUID()}`
    const dataset: ResourceRow = {
      id: datasetId, owner_key: ownerKey, kind: 'dataset', status: 'building', name: 'sample.csv',
      format: 'csv', group_id: datasetId, version: 1, source_ids_json: JSON.stringify([raw.id]),
      producer_job_id: jobId, storage_relpath: null, content_hash: null, byte_size: null,
      row_count: null, column_count: null, metadata_json: '{}', created_at: now, updated_at: now, deleted_at: null,
    }
    const job: JobRow = {
      id: jobId, owner_key: ownerKey, kind: 'import', name: '导入 sample.csv', state: 'interrupted',
      retry_of: null, input_ids_json: JSON.stringify([raw.id]), spec_json: '{}', spec_hash: `sha256:${sha('{}')}`,
      engine_version: 'qsv test', idempotency_key: 'recovery-import-0001',
      progress_json: '{}', summary_json: JSON.stringify({ outputId: datasetId }), error_json: null,
      work_relpath: join('owners', workspaceId, 'jobs', jobId),
      created_at: now, started_at: now, finished_at: null, updated_at: now,
    }
    db.createImport(dataset, job)
    const relpath = resourceRelpath(workspaceId, datasetId, 'data.csv')
    const datasetPath = join(directory, relpath)
    await mkdir(join(directory, 'owners', workspaceId, 'resources', datasetId), { recursive: true })
    await writeFile(datasetPath, 'id\n1\n')
    await writeFile(`${datasetPath}.idx`, 'index')
    await writeCommit(join(directory, 'owners', workspaceId, 'resources', datasetId), {
      version: 1, kind: 'dataset', resourceId: datasetId, ownerKey, workspaceId, relpath,
      sha256: sha('id\n1\n'), bytes: 5, name: 'sample.csv', createdAt: now,
      jobId, sourceId: raw.id, sourceHash: restoredRaw.content_hash!, engineVersion: 'qsv test',
      rowCount: 1, headers: ['id'], indexSha256: sha('index'), indexBytes: 5,
    })

    const unfinishedId = `res_${randomUUID()}`
    const unfinishedJobId = `job_${randomUUID()}`
    db.createImport({ ...dataset, id: unfinishedId, group_id: unfinishedId, producer_job_id: unfinishedJobId },
      { ...job, id: unfinishedJobId, state: 'running', idempotency_key: 'recovery-import-0002',
        summary_json: JSON.stringify({ outputId: unfinishedId }) })
    const orphanId = `res_${randomUUID()}`
    const orphanDir = join(directory, 'owners', workspaceId, 'resources', orphanId)
    await mkdir(orphanDir, { recursive: true })
    await writeFile(join(orphanDir, 'data.csv.partial'), 'unfinished')
    await writeFile(join(directory, 'owners', workspaceId, 'uploads', `${randomUUID()}.partial`), 'unfinished')
    const tusId = 'a'.repeat(32)
    const tusDir = join(directory, 'owners', workspaceId, 'uploads', 'tus')
    await mkdir(tusDir)
    await writeFile(join(tusDir, tusId), 'unfinished')
    await writeFile(join(tusDir, `${tusId}.json`), '{}')
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await utimes(join(tusDir, tusId), old, old)
    await utimes(join(tusDir, `${tusId}.json`), old, old)
    const brokenTusId = 'b'.repeat(32)
    await writeFile(join(tusDir, brokenTusId), 'partial')
    await writeFile(join(tusDir, `${brokenTusId}.json`), '{"size":')
    db.close()
    db = new WebDatabase(directory)
    const second = await recoverStartup(db, directory)
    assert.equal(second.importsRestored, 1)
    assert.equal(second.interrupted, 1)
    assert.equal(second.partialsRemoved, 1)
    assert.equal(second.orphanDirectoriesRemoved, 1)
    assert.equal(second.tusExpired, 2)
    assert.equal(db.getResource(ownerKey, datasetId)?.status, 'ready')
    assert.equal(db.getJob(ownerKey, jobId)?.state, 'succeeded')
    assert.equal(db.getResource(ownerKey, unfinishedId)?.status, 'failed')
    assert.equal(db.getJob(ownerKey, unfinishedJobId)?.state, 'interrupted')
    assert.deepEqual(await recoverStartup(db, directory), { rawRestored: 0, importsRestored: 0, exportsRestored: 0, interrupted: 0, partialsRemoved: 0, orphanDirectoriesRemoved: 0, tusExpired: 0 })

    db.db.prepare('UPDATE resources SET row_count = 2 WHERE id = ?').run(datasetId)
    await assert.rejects(recoverStartup(db, directory), /元数据与提交凭据不一致/)
    db.db.prepare('UPDATE resources SET row_count = 1 WHERE id = ?').run(datasetId)
    await writeFile(`${datasetPath}.idx`, 'broken')
    await assert.rejects(recoverStartup(db, directory), /文件校验失败/)
    await writeFile(`${datasetPath}.idx`, 'index')
    await rm(join(directory, 'owners', workspaceId, 'resources', datasetId, 'commit.json'))
    await assert.rejects(recoverStartup(db, directory), /缺少有效的提交凭据/)
  } finally {
    if (db.db.open) db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
