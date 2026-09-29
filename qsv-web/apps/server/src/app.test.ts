import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.ts'
import type { EngineProbe } from './engine.ts'

test('capabilities reports only probed operations and a request ID', async () => {
  const probe: EngineProbe = {
    version: null,
    sha256: null,
    platform: 'test',
    verified: false,
    reason: '未配置引擎',
    operations: { 'table.count': false, 'table.preview.indexed': false },
  }
  const app = createApp(probe)
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/capabilities' })
    assert.equal(response.statusCode, 200)
    const body = response.json()
    assert.equal(typeof body.requestId, 'string')
    assert.equal(body.engine.verified, false)
    assert.deepEqual(body.operations, probe.operations)
  } finally {
    await app.close()
  }
})
