import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MemoryLocker } from '@tus/server'
import { createApp } from './app.ts'
import { WebDatabase } from './database.ts'
import type { EngineProbe } from './engine.ts'
import { WorkbenchService } from './service.ts'

const probe: EngineProbe = {
  version: 'qsv-test', sha256: '0'.repeat(64), platform: 'test', verified: true, reason: null,
  operations: { 'table.count': true, 'table.preview.indexed': true },
}
const alice = { 'x-hc-user-id': 'alice' }
const bob = { 'x-hc-user-id': 'bob' }
const write = { 'x-qsv-request': '1' }

async function openApp(directory: string) {
  const db = new WebDatabase(directory)
  const service = new WorkbenchService(db, directory, '', 'qsv-test')
  const app = createApp(probe, { service, authMode: 'lazycat' })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  assert(address && typeof address !== 'string')
  return { app, db, base: `http://127.0.0.1:${address.port}` }
}

function metadata(entries: Record<string, string>) {
  return Object.entries(entries).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',')
}

test('tus resumes across a server restart, isolates owners, and commits one raw resource', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-tus-'))
  let running = await openApp(directory)
  const file = Buffer.from('code,name\n0001,测试\n')
  const sha256 = createHash('sha256').update(file).digest('hex')
  const key = 'tus-restart-key-0001'
  try {
    const created = await fetch(`${running.base}/api/v1/tus`, {
      method: 'POST', headers: { ...alice, ...write, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(file.length),
        'Upload-Metadata': metadata({ filename: 'resume.csv', uploadKey: key, fingerprint: 'a'.repeat(64), sha256 }) },
    })
    assert.equal(created.status, 201)
    const location = created.headers.get('location')
    assert(location)
    const first = await fetch(`${running.base}${location}`, {
      method: 'PATCH', headers: { ...alice, ...write, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
      body: file.subarray(0, 7),
    })
    assert.equal(first.status, 204)
    assert.equal(first.headers.get('upload-offset'), '7')
    const foreign = await fetch(`${running.base}${location}`, { method: 'HEAD', headers: { ...bob, 'Tus-Resumable': '1.0.0' } })
    assert.equal(foreign.status, 404)
    const premature = await fetch(`${running.base}${location}/commit`, { method: 'POST', headers: { ...alice, ...write, 'idempotency-key': key } })
    assert.equal(premature.status, 409)
    await running.app.close()
    running.db.close()
    running = await openApp(directory)
    const resumed = await fetch(`${running.base}${location}`, { method: 'HEAD', headers: { ...alice, 'Tus-Resumable': '1.0.0' } })
    assert.equal(resumed.status, 200)
    assert.equal(resumed.headers.get('upload-offset'), '7')
    const last = await fetch(`${running.base}${location}`, {
      method: 'PATCH', headers: { ...alice, ...write, 'Tus-Resumable': '1.0.0', 'Upload-Offset': '7', 'Content-Type': 'application/offset+octet-stream' },
      body: file.subarray(7),
    })
    assert.equal(last.status, 204)
    const uploadId = location.split('/').at(-1)!
    const workspaceId = (await readdir(join(directory, 'owners')))[0]!
    const metadataPath = join(directory, 'owners', workspaceId, 'uploads', 'tus', `${uploadId}.json`)
    const beforeCommit = await readFile(metadataPath)
    const committed = await fetch(`${running.base}${location}/commit`, { method: 'POST', headers: { ...alice, ...write, 'idempotency-key': key } })
    assert.equal(committed.status, 201)
    const resource = (await committed.json() as { resource: { id: string; byteSize: number } }).resource
    assert.equal(resource.byteSize, file.length)
    const repeated = await fetch(`${running.base}${location}/commit`, { method: 'POST', headers: { ...alice, ...write, 'idempotency-key': key } })
    assert.equal(repeated.status, 201)
    assert.equal((await repeated.json() as { resource: { id: string } }).resource.id, resource.id)
    const renamed = await fetch(`${running.base}/api/v1/resources/${resource.id}`, { method: 'PATCH', headers: { ...alice, ...write, 'content-type': 'application/json' },
      body: JSON.stringify({ name: '续传后的显示名', description: '原文件保持不变', expectedUpdatedAt: (await (await fetch(`${running.base}/api/v1/resources/${resource.id}`, { headers: alice })).json() as { resource: { updatedAt: number } }).resource.updatedAt }) })
    assert.equal(renamed.status, 200)
    await writeFile(metadataPath, beforeCommit)
    await running.app.close()
    running.db.close()
    running = await openApp(directory)
    const afterInterruptedCleanup = await fetch(`${running.base}${location}/commit`, { method: 'POST', headers: { ...alice, ...write, 'idempotency-key': key } })
    assert.equal(afterInterruptedCleanup.status, 201)
    assert.equal((await afterInterruptedCleanup.json() as { resource: { id: string } }).resource.id, resource.id)
    const download = await fetch(`${running.base}/api/v1/resources/${resource.id}/download`, { headers: alice })
    assert.equal(download.status, 200)
    assert.equal(Buffer.from(await download.arrayBuffer()).compare(file), 0)
    const foreignKey = await fetch(`${running.base}/api/v1/uploads/by-key/${key}`, { headers: bob })
    assert.equal(foreignKey.status, 404)
  } finally {
    await running.app.close()
    if (running.db.db.open) running.db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('tus releases an interrupted PATCH so the same upload can resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-tus-abort-'))
  const running = await openApp(directory)
  const file = Buffer.from('code,name\n0001,测试\n')
  const sha256 = createHash('sha256').update(file).digest('hex')
  try {
    const created = await fetch(`${running.base}/api/v1/tus`, {
      method: 'POST', headers: { ...alice, ...write, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(file.length),
        'Upload-Metadata': metadata({ filename: 'abort.csv', uploadKey: 'tus-abort-key-0001', fingerprint: 'b'.repeat(64), sha256 }) },
    })
    assert.equal(created.status, 201)
    const location = created.headers.get('location')!
    let abortPatch!: () => void
    const disconnected = new Promise<void>((resolve) => {
      const target = new URL(location, running.base)
      const request = httpRequest(target, { method: 'PATCH', headers: { ...alice, ...write, 'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream', 'Content-Length': String(file.length) } })
      request.on('error', () => resolve())
      request.on('close', () => resolve())
      request.write(file.subarray(0, 8))
      abortPatch = () => request.destroy()
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    try {
      const foreignPatch = await fetch(`${running.base}${location}`, { method: 'PATCH', headers: { ...bob, ...write,
        'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: file.subarray(0, 1) })
      assert.equal(foreignPatch.status, 404)
    } finally { abortPatch() }
    await disconnected
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    const head = await fetch(`${running.base}${location}`, { method: 'HEAD', headers: { ...alice, 'Tus-Resumable': '1.0.0' } })
    assert.equal(head.status, 200)
    const offset = Number(head.headers.get('upload-offset'))
    const resumed = await fetch(`${running.base}${location}`, { method: 'PATCH', headers: { ...alice, ...write,
      'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' },
    body: file.subarray(offset) })
    assert.equal(resumed.status, 204, await resumed.text())
    assert.equal(resumed.headers.get('upload-offset'), String(file.length))
    const committed = await fetch(`${running.base}${location}/commit`, { method: 'POST', headers: { ...alice, ...write, 'idempotency-key': 'tus-abort-key-0001' } })
    assert.equal(committed.status, 201)
    const resourceId = (await committed.json() as { resource: { id: string } }).resource.id
    const downloaded = await fetch(`${running.base}/api/v1/resources/${resourceId}/download`, { headers: alice })
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).compare(file), 0)
  } finally {
    running.app.server.closeAllConnections()
    await running.app.close()
    running.db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('an interrupted PATCH keeps its reservation until the tus file lock is released', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-tus-lock-'))
  const running = await openApp(directory)
  const file = Buffer.from('code,name\n0001,测试\n')
  const sha256 = createHash('sha256').update(file).digest('hex')
  let unlockStarted!: () => void
  let allowUnlock!: () => void
  const unlocking = new Promise<void>((resolve) => { unlockStarted = resolve })
  const mayUnlock = new Promise<void>((resolve) => { allowUnlock = resolve })
  const originalNewLock = MemoryLocker.prototype.newLock
  try {
    const created = await fetch(`${running.base}/api/v1/tus`, {
      method: 'POST', headers: { ...alice, ...write, 'Tus-Resumable': '1.0.0', 'Upload-Length': String(file.length),
        'Upload-Metadata': metadata({ filename: 'held-lock.csv', uploadKey: 'tus-held-lock-0001', fingerprint: 'c'.repeat(64), sha256 }) },
    })
    assert.equal(created.status, 201)
    const location = created.headers.get('location')!
    MemoryLocker.prototype.newLock = function (id) {
      const lock = originalNewLock.call(this, id)
      const originalUnlock = lock.unlock.bind(lock)
      lock.unlock = async () => { unlockStarted(); await mayUnlock; await originalUnlock() }
      return lock
    }
    let abortPatch!: () => void
    const disconnected = new Promise<void>((resolve) => {
      const request = httpRequest(new URL(location, running.base), { method: 'PATCH', headers: { ...alice, ...write,
        'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
        'Content-Length': String(file.length) } })
      request.on('error', () => resolve())
      request.on('close', () => resolve())
      request.write(file.subarray(0, 8))
      abortPatch = () => request.destroy()
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    abortPatch()
    await disconnected
    await Promise.race([unlocking, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tus did not reach unlock')), 2000))])
    const concurrent = await fetch(`${running.base}${location}`, { method: 'PATCH', headers: { ...alice, ...write,
      'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' },
    body: file.subarray(0, 1), signal: AbortSignal.timeout(500) })
    assert.equal(concurrent.status, 409)
  } finally {
    allowUnlock()
    MemoryLocker.prototype.newLock = originalNewLock
    running.app.server.closeAllConnections()
    await running.app.close()
    running.db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
