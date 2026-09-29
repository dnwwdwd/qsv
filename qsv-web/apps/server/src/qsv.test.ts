import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runQsv } from './qsv.ts'

test('subprocess output cap terminates a verbose command', async () => {
  await assert.rejects(
    runQsv(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000000))'], undefined, 1024, 5000),
    /输出超过限制/,
  )
})
