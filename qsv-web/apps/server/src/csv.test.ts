import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inspectCsv } from './csv.ts'

test('CSV inspection preserves text and rejects malformed data before import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qsv-web-csv-'))
  try {
    const valid = join(directory, 'valid.csv')
    await writeFile(valid, '编号,备注\n000123,"含,逗号"\n')
    assert.deepEqual(await inspectCsv(valid), { headers: ['编号', '备注'], rowCount: 1 })

    const ragged = join(directory, 'ragged.csv')
    await writeFile(ragged, 'a,b\n1,2,3\n')
    await assert.rejects(inspectCsv(ragged), /格式不一致/)

    const badEncoding = join(directory, 'invalid-utf8.csv')
    await writeFile(badEncoding, Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0x2c, 0x31, 0x0a]))
    await assert.rejects(inspectCsv(badEncoding), /无效的 UTF-8/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
