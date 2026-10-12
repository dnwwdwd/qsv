import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createApp } from './app.ts'
import { WebDatabase, type ResourceRow } from './database.ts'
import type { EngineProbe } from './engine.ts'
import { recoverStartup } from './recovery.ts'
import { WorkbenchService } from './service.ts'
import { StubAuth } from './test-auth.ts'

const probe: EngineProbe = {
  version: 'qsv 23.0.1-test', sha256: '0'.repeat(64), platform: 'test', verified: true, reason: null,
  operations: { 'table.count': true, 'table.preview.indexed': true },
}

test('upload persists and another owner cannot read or import it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-test-'))
  const db = new WebDatabase(directory)
  const app = createApp(probe, { service: new WorkbenchService(db, directory, '', probe.version!), authMode: 'lazycat', oidc: new StubAuth() })
  try {
    const alice = { 'x-test-user-id': 'alice' }
    const bob = { 'x-test-user-id': 'bob' }
    const uploadHeaders = { ...alice, 'x-qsv-request': '1', 'x-file-name': 'sample.csv', 'idempotency-key': 'test-upload-key-0001', 'content-type': 'application/octet-stream' }
    const upload = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: uploadHeaders, payload: 'id,value\n0001,中文\n' })
    assert.equal(upload.statusCode, 201)
    const id = upload.json().resource.id as string
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: uploadHeaders, payload: 'id,value\n0001,中文\n' })
    assert.equal(duplicate.statusCode, 201)
    assert.equal(duplicate.json().resource.id, id)
    const conflicting = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: uploadHeaders, payload: 'id,value\n0002,不同\n' })
    assert.equal(conflicting.statusCode, 409)
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/resources/${id}`, headers: alice })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/resources/${id}`, headers: bob })).statusCode, 404)
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/resources/${id}/download`, headers: bob })).statusCode, 404)
    const version = (await app.inject({ method: 'GET', url: `/api/v1/resources/${id}`, headers: alice })).json().resource.updatedAt as number
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/resources/${id}`, headers: { ...alice, 'x-qsv-request': '1' },
      payload: { name: '客户资料', description: '保留前导零和中文', expectedUpdatedAt: version } })
    assert.equal(renamed.statusCode, 200)
    assert.equal(renamed.json().resource.name, '客户资料')
    assert.equal(renamed.json().resource.metadata.originalName, 'sample.csv')
    assert.equal(renamed.json().resource.metadata.description, '保留前导零和中文')
    assert.ok(renamed.json().resource.updatedAt > version)
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/resources/${id}`, headers: { ...alice, 'x-qsv-request': '1' },
      payload: { name: '旧版本覆盖', description: '', expectedUpdatedAt: version } })).statusCode, 409)
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/resources/${id}`, headers: { ...bob, 'x-qsv-request': '1' },
      payload: { name: '越权', description: '', expectedUpdatedAt: version } })).statusCode, 404)
    const repeatedAfterRename = await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: uploadHeaders, payload: 'id,value\n0001,中文\n' })
    assert.equal(repeatedAfterRename.statusCode, 201)
    assert.equal(repeatedAfterRename.json().resource.id, id)
    assert.equal(repeatedAfterRename.json().resource.name, '客户资料')
    const foreignImport = await app.inject({ method: 'POST', url: '/api/v1/imports', headers: { ...bob, 'x-qsv-request': '1', 'idempotency-key': 'owner-bound-request-0001', 'content-type': 'application/json' }, payload: { rawResourceId: id } })
    assert.equal(foreignImport.statusCode, 422)
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/uploads', headers: { ...alice, 'x-file-name': 'sample.csv', 'idempotency-key': 'another-upload-key-0001', 'content-type': 'application/octet-stream' }, payload: 'id\n1\n' })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/resources' })).statusCode, 401)
    const original = db.db.prepare('SELECT * FROM resources WHERE id=?').get(id) as ResourceRow
    for (let index = 0; index < 55; index += 1) {
      const otherId = `res_${randomUUID()}`
      db.insertResource({ ...original, id: otherId, group_id: otherId, name: `additional-${index}.csv`, storage_relpath: null, content_hash: null, byte_size: null,
        metadata_json: '{}', created_at: original.created_at + index + 1, updated_at: original.updated_at + index + 1 })
    }
    const lastPage = await app.inject({ method: 'GET', url: '/api/v1/resources?offset=50&limit=10', headers: alice })
    assert.equal(lastPage.statusCode, 200)
    assert.equal(lastPage.json().total, 56)
    assert.equal(lastPage.json().items.length, 6)
    const firstCursorPage = (await app.inject({ method: 'GET', url: '/api/v1/resources?cursor=&limit=50', headers: alice })).json()
    assert.equal(firstCursorPage.items.length, 50)
    assert.ok(firstCursorPage.nextCursor)
    const newestId = `res_${randomUUID()}`
    db.insertResource({ ...original, id: newestId, group_id: newestId, name: 'newest.csv', storage_relpath: null, content_hash: null, byte_size: null,
      metadata_json: '{}', created_at: original.created_at + 1000, updated_at: original.updated_at + 1000 })
    const secondCursorPage = (await app.inject({ method: 'GET', url: `/api/v1/resources?cursor=${encodeURIComponent(firstCursorPage.nextCursor)}&limit=50`, headers: alice })).json()
    assert.equal(secondCursorPage.items.length, 6)
    assert.ok(secondCursorPage.items.every((item: { id: string }) => !firstCursorPage.items.some((first: { id: string }) => first.id === item.id)))
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/resources?cursor=bad', headers: alice })).statusCode, 400)
    const searched = (await app.inject({ method: 'GET', url: '/api/v1/search?q=additional-54', headers: alice })).json()
    assert.equal(searched.resources.length, 1)
    assert.equal(searched.resources[0].name, 'additional-54.csv')
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/search?q=additional-54', headers: bob })).json().resources.length, 0)
    const jobId = `job_${randomUUID()}`
    db.insertJob({ id: jobId, owner_key: original.owner_key, kind: 'import', name: '导入失败样本', state: 'failed', retry_of: null,
      input_ids_json: JSON.stringify([id]), spec_json: '{}', spec_hash: 'a'.repeat(64), engine_version: 'test', idempotency_key: null,
      progress_json: JSON.stringify({ mode: 'stage', percent: null, stage: '失败' }), summary_json: '{}',
      error_json: JSON.stringify({ code: 'INVALID_CSV', message: '记录格式不一致', retryable: false }), work_relpath: 'jobs/test',
      created_at: Date.now(), started_at: Date.now(), finished_at: Date.now(), updated_at: Date.now() })
    const aliceOverview = (await app.inject({ method: 'GET', url: '/api/v1/overview', headers: alice })).json()
    const bobOverview = (await app.inject({ method: 'GET', url: '/api/v1/overview', headers: bob })).json()
    assert.equal(aliceOverview.needsAttention, 1)
    assert.equal(aliceOverview.attentionJobs[0].id, jobId)
    assert.equal(bobOverview.needsAttention, 0)
    assert.deepEqual(bobOverview.attentionJobs, [])
    const retriedId = `job_${randomUUID()}`
    db.insertJob({ ...db.getJob(original.owner_key, jobId)!, id: retriedId, state: 'queued', retry_of: jobId,
      idempotency_key: 'retry-test-key-0001', created_at: Date.now() + 1, updated_at: Date.now() + 1 })
    const afterRetry = (await app.inject({ method: 'GET', url: '/api/v1/overview', headers: alice })).json()
    assert.equal(afterRetry.needsAttention, 0)
    assert.deepEqual(afterRetry.attentionJobs, [])
    db.setJobState(original.owner_key, retriedId, 'failed', { mode: 'stage', percent: null, stage: '失败' }, { code: 'TEST', message: '再次失败', retryable: true })
    const afterRetryFailed = (await app.inject({ method: 'GET', url: '/api/v1/overview', headers: alice })).json()
    assert.equal(afterRetryFailed.needsAttention, 1)
    assert.equal(afterRetryFailed.attentionJobs[0].id, retriedId)
    await app.close()
    db.close()
    const reopened = new WebDatabase(directory)
    assert.equal((reopened.db.prepare('SELECT COUNT(*) AS n FROM resources').get() as { n: number }).n, 57)
    await recoverStartup(reopened, directory)
    assert.equal(reopened.getResource(original.owner_key, id)?.name, '客户资料')
    reopened.close()
  } finally {
    await app.close()
    if (db.db.open) db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('renaming a raw resource while an import waits keeps the original filename in the committed dataset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-rename-import-'))
  const binary = join(directory, 'qsv-test')
  // 本机 node 路径可能含空格（如 “Application Support”）；shebang 不引用空格路径会被截断，
  // 导致 qsv 进程无法启动。用 env 查找解释器可避免这个问题。
  await writeFile(binary, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst [command, ...args] = process.argv.slice(2);\nconst file = args.at(-1);\nif (command === 'index') fs.writeFileSync(file + '.idx', 'index');\nelse if (command === 'count') process.stdout.write(String(fs.readFileSync(file, 'utf8').trimEnd().split('\\n').length - 1));\nelse if (command === 'slice') process.stdout.write(fs.readFileSync(file, 'utf8').split('\\n')[0] + '\\n');\nelse process.exit(2);\n`)
  await chmod(binary, 0o700)
  const db = new WebDatabase(directory)
  const service = new WorkbenchService(db, directory, binary, 'qsv-test')
  const owner = { ownerKey: 'a'.repeat(64), workspaceId: 'a'.repeat(24), displayName: '测试用户', source: 'local' as const }
  try {
    const content = Buffer.from('code,name\n0001,测试\n')
    const raw = await service.upload(owner, Readable.from([content]), 'source.csv', 'rename-source-key-0001', content.length)
    const first = service.submitImport(owner, raw.id, 'rename-first-job-0001')
    const second = service.submitImport(owner, raw.id, 'rename-second-job-0001')
    assert.equal(second.job.state, 'queued')
    service.updateResourceDetails(owner, raw.id, '客户资料', '', raw.updatedAt)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (db.getJob(owner.ownerKey, first.job.id)?.state === 'succeeded' && db.getJob(owner.ownerKey, second.job.id)?.state === 'succeeded') break
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(db.getJob(owner.ownerKey, first.job.id)?.state, 'succeeded')
    assert.equal(db.getJob(owner.ownerKey, second.job.id)?.state, 'succeeded')
    const output = db.getResource(owner.ownerKey, second.resource.id)!
    assert.equal(output.name, 'source.csv')
    assert.equal(JSON.parse(output.metadata_json).originalName, 'source.csv')
    assert.equal((await service.downloadPath(owner, raw.id)).name, 'source.csv')
    await service.shutdown()
    await recoverStartup(db, directory)
    assert.equal(db.getResource(owner.ownerKey, second.resource.id)?.status, 'ready')
  } finally {
    await service.shutdown()
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
