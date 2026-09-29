import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { createBackup, restoreBackup } from './backup.ts'
import { WebDatabase } from './database.ts'
import { acquireInstanceLock } from './instance-lock.ts'
import { WorkbenchService } from './service.ts'

test('backup snapshots SQLite and committed resource files, and restore detects corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qsv-web-backup-'))
  const source = join(root, 'source')
  const backup = join(root, 'snapshot')
  const restored = join(root, 'restored')
  let db: WebDatabase | null = null
  try {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(source, { mode: 0o700 })
    db = new WebDatabase(source)
    const ownerKey = 'b'.repeat(64)
    const owner = { ownerKey, workspaceId: ownerKey.slice(0, 24), displayName: '测试', source: 'local' as const }
    const service = new WorkbenchService(db, source, '', 'qsv-test')
    const content = 'code,name\n0001,测试\n'
    const raw = await service.upload(owner, Readable.from([content]), 'sample.csv', 'backup-upload-key-0001', Buffer.byteLength(content))
    db.close()
    db = null

    const release = await acquireInstanceLock(source)
    try { await assert.rejects(createBackup(source, backup), /已有服务实例/) }
    finally { await release() }

    const created = await createBackup(source, backup)
    assert.equal(created.resourceCount, 1)
    assert.equal(created.fileCount, 3)
    const result = await restoreBackup(backup, restored)
    assert.equal(result.resourceCount, 1)
    db = new WebDatabase(restored)
    assert.equal(db.getResource(ownerKey, raw.id)?.content_hash, raw.contentHash)
    assert.equal(await readFile(join(restored, 'owners', owner.workspaceId, 'resources', raw.id, 'original.csv'), 'utf8'), content)
    db.close()
    db = null

    const manifestPath = join(backup, 'backup-manifest.json')
    const manifest = await readFile(manifestPath, 'utf8')
    const missingFile = JSON.parse(manifest) as { files: { path: string }[] }
    missingFile.files = missingFile.files.filter((entry) => !entry.path.endsWith('/original.csv'))
    await writeFile(manifestPath, JSON.stringify(missingFile))
    await assert.rejects(restoreBackup(backup, join(root, 'missing-resource-restore')), /文件缺失/)
    await writeFile(manifestPath, manifest)

    await writeFile(join(backup, 'owners', owner.workspaceId, 'resources', raw.id, 'original.csv'), 'altered')
    await assert.rejects(restoreBackup(backup, join(root, 'corrupt-restore')), /校验失败/)
    await assert.rejects(restoreBackup(backup, restored), /已存在/)
  } finally {
    db?.close()
    await rm(root, { recursive: true, force: true })
  }
})
