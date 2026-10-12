import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from './app.ts'
import { WebDatabase } from './database.ts'
import type { EngineProbe } from './engine.ts'
import { ORDERS_EXAMPLE_CONTENT, ORDERS_EXAMPLE_NAME } from './example.ts'
import { WorkbenchService } from './service.ts'
import { StubAuth } from './test-auth.ts'

const probe: EngineProbe = { version: 'qsv-test', sha256: '0'.repeat(64), platform: 'test', verified: true, reason: null,
  operations: { 'table.count': true, 'table.preview.indexed': true } }

test('built-in example creates one real owner-scoped import and keeps its source visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-example-'))
  const db = new WebDatabase(directory)
  const service = new WorkbenchService(db, directory, 'missing-qsv-test-binary', 'qsv-test')
  const app = createApp(probe, { service, authMode: 'lazycat', oidc: new StubAuth() })
  const alice = { 'x-test-user-id': 'alice', 'x-qsv-request': '1' }
  const bob = { 'x-test-user-id': 'bob', 'x-qsv-request': '1' }
  try {
    const first = await app.inject({ method: 'POST', url: '/api/v1/examples/orders/import', headers: alice })
    assert.equal(first.statusCode, 202)
    const firstBody = first.json()
    const second = await app.inject({ method: 'POST', url: '/api/v1/examples/orders/import', headers: alice })
    assert.equal(second.statusCode, 202)
    assert.equal(second.json().job.id, firstBody.job.id)
    assert.equal(second.json().resource.id, firstBody.resource.id)
    const rawId = firstBody.job.inputIds[0] as string
    const raw = (await app.inject({ method: 'GET', url: `/api/v1/resources/${rawId}`, headers: alice })).json().resource
    assert.equal(raw.name, ORDERS_EXAMPLE_NAME)
    const renamed = await app.inject({ method: 'PATCH', url: `/api/v1/resources/${rawId}`, headers: alice,
      payload: { name: '[内置示例] 我的订单', description: '', expectedUpdatedAt: raw.updatedAt } })
    assert.equal(renamed.statusCode, 200)
    const third = await app.inject({ method: 'POST', url: '/api/v1/examples/orders/import', headers: alice })
    assert.equal(third.statusCode, 202)
    assert.equal(third.json().job.id, firstBody.job.id)
    const download = await app.inject({ method: 'GET', url: `/api/v1/resources/${rawId}/download`, headers: alice })
    assert.equal(Buffer.compare(download.rawPayload, ORDERS_EXAMPLE_CONTENT), 0)
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/resources/${rawId}`, headers: bob })).statusCode, 404)
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/examples/orders/import', headers: bob })
    assert.equal(foreign.statusCode, 202)
    assert.notEqual(foreign.json().job.id, firstBody.job.id)
  } finally {
    await service.shutdown()
    await app.close()
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
