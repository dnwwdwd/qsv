import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { acquireInstanceLock, preparePrivateDataDir } from './instance-lock.ts'
import { WebDatabase } from './database.ts'
import { WorkbenchService } from './service.ts'

test('data directory allows only one server instance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-lock-'))
  try {
    await preparePrivateDataDir(directory)
    const release = await acquireInstanceLock(directory)
    await assert.rejects(acquireInstanceLock(directory), /已有服务实例/)
    await release()
    const releaseAgain = await acquireInstanceLock(directory)
    await releaseAgain()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('service shutdown stops an unfinished upload before closing the database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-shutdown-'))
  const db = new WebDatabase(directory)
  try {
    const ownerKey = 'b'.repeat(64)
    const service = new WorkbenchService(db, directory, '', 'qsv test')
    const stream = new PassThrough()
    const upload = service.upload({ ownerKey, workspaceId: ownerKey.slice(0, 24), displayName: '测试用户', source: 'local' },
      stream, 'unfinished.csv', 'shutdown-upload-0001', 5)
    await service.shutdown()
    await assert.rejects(upload)
    assert.equal(db.countResources(ownerKey), 0)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('service shutdown interrupts a running import before database close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-running-stop-'))
  const db = new WebDatabase(directory)
  try {
    const binary = join(directory, 'slow-qsv')
    await writeFile(binary, '#!/bin/sh\nsleep 30\n', { mode: 0o700 })
    const ownerKey = 'c'.repeat(64)
    const owner = { ownerKey, workspaceId: ownerKey.slice(0, 24), displayName: '测试用户', source: 'local' as const }
    const service = new WorkbenchService(db, directory, binary, 'qsv test')
    const raw = await service.upload(owner, Readable.from(['id\n1\n']), 'sample.csv', 'shutdown-raw-upload-0001', 5)
    const submitted = service.submitImport(owner, raw.id, 'shutdown-running-0001')
    let indexing = false
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (service.getJob(owner, submitted.job.id).progress &&
        (service.getJob(owner, submitted.job.id).progress as { stage?: string }).stage === '建立索引') { indexing = true; break }
      await pause(10)
    }
    assert.equal(indexing, true)
    await service.shutdown()
    assert.equal(db.getJob(ownerKey, submitted.job.id)?.state, 'interrupted')
    assert.equal(db.getResource(ownerKey, submitted.resource.id)?.status, 'failed')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
