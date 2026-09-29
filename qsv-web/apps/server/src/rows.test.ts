import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebDatabase, type ResourceRow } from './database.ts'
import { resourceRelpath } from './files.ts'
import type { Identity } from './identity.ts'
import { ServiceError, WorkbenchService } from './service.ts'

test('large row blocks stay bounded, preserve offsets, and expose full cells only to their owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-rows-'))
  const db = new WebDatabase(directory)
  const ownerKey = createHash('sha256').update('qsv-web:local:single-user').digest('hex')
  const owner: Identity = { ownerKey, workspaceId: ownerKey.slice(0, 24), displayName: 'test', source: 'local' }
  const other: Identity = { ownerKey: 'b'.repeat(64), workspaceId: 'b'.repeat(24), displayName: 'other', source: 'local' }
  const id = `res_${randomUUID()}`
  const relpath = resourceRelpath(owner.workspaceId, id, 'data.csv')
  const path = join(directory, relpath)
  const binary = join(directory, 'fake-qsv.mjs')
  try {
    await mkdir(join(directory, 'owners', owner.workspaceId, 'resources', id), { recursive: true })
    await writeFile(path, 'id,content\n0,value\n')
    await writeFile(binary, `#!/usr/bin/env node\nconst args=process.argv.slice(2);const start=Number(args[args.indexOf('--start')+1]);const count=Number(args[args.indexOf('--len')+1]);process.stdout.write('id,content\\n');for(let i=start;i<Math.min(start+count,520);i++)process.stdout.write(i+','+'中'.repeat(2000)+'\\n');\n`)
    await chmod(binary, 0o700)
    const now = Date.now()
    const source: ResourceRow = { id, owner_key: owner.ownerKey, kind: 'dataset', status: 'ready', name: 'large.csv', format: 'csv',
      group_id: id, version: 1, source_ids_json: '[]', producer_job_id: null, storage_relpath: relpath,
      content_hash: 'a'.repeat(64), byte_size: 20, row_count: 520, column_count: 2,
      metadata_json: JSON.stringify({ headers: ['id', 'content'] }), created_at: now, updated_at: now, deleted_at: null }
    db.insertResource(source)
    const service = new WorkbenchService(db, directory, binary, 'qsv-test')
    const view = await service.createView(owner, id)
    const first = await service.rows(owner, view.id, 0, 512)
    assert(first.limit < 512)
    assert.equal(first.nextOffset, first.rows.length)
    assert.equal(first.truncatedCells.length, first.rows.length)
    assert(Buffer.byteLength(JSON.stringify(first)) <= 2 * 1024 * 1024)
    assert.equal((await service.rows(owner, view.id, 0, 512)).nextOffset, first.nextOffset)
    const second = await service.rows(owner, view.id, first.nextOffset, 512)
    assert.equal(second.sourceRowNumbers[0], first.nextOffset + 1)
    assert.equal(second.nextOffset, 520)
    assert.equal(second.hasMore, false)
    const cell = await service.cell(owner, view.id, 0, 'c_1')
    assert.equal(cell.value, '中'.repeat(2000))
    await assert.rejects(service.cell(other, view.id, 0, 'c_1'), (error) => error instanceof ServiceError && error.status === 404)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
})
