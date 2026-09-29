import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'

function encode(row: string[]) {
  return `${row.map((value) => /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(',')}\n`
}

/** 输入按键字段排好序，组内选原始行号最小的一行，因此“保留第一条”不受排序稳定性影响。 */
export async function keepFirstPerKey(sortedPath: string, outputPath: string, keyIndices: number[], signal?: AbortSignal,
  lineagePath?: string) {
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  let width = 0
  let sawHeader = false
  let currentKey: string | null = null
  let chosen: string[] | null = null
  let chosenIndex = Number.POSITIVE_INFINITY
  let readRows = 0
  let keptRows = 0
  const lineage = lineagePath ? createWriteStream(lineagePath, { flags: 'wx', mode: 0o600 }) : null
  const encoder = new Transform({ objectMode: true, transform(row: string[], _encoding, callback) {
    try {
      if (!sawHeader) {
        sawHeader = true
        width = row.length - 1
        if (width < 1 || keyIndices.some((index) => index < 0 || index >= width)) throw new Error('去重字段无效')
        callback(null, encode(row.slice(0, width)))
        return
      }
      if (row.length !== width + 1) throw new Error('去重时发现字段数不一致')
      const rowIndex = Number(row[width])
      if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) throw new Error('原始行号无效')
      const key = JSON.stringify(keyIndices.map((index) => row[index]))
      readRows += 1
      let output = ''
      if (currentKey !== null && key !== currentKey && chosen !== null) {
        output = encode(chosen)
        keptRows += 1
        if (lineage && !lineage.write(`${keptRows},${chosenIndex}\n`)) {
          currentKey = key
          chosen = row.slice(0, width)
          chosenIndex = rowIndex
          lineage.once('drain', () => callback(null, output))
          return
        }
        chosen = null
        chosenIndex = Number.POSITIVE_INFINITY
      }
      currentKey = key
      if (rowIndex < chosenIndex) { chosen = row.slice(0, width); chosenIndex = rowIndex }
      callback(null, output)
    } catch (error) { callback(error as Error) }
  }, flush(callback) {
    if (!sawHeader) { callback(new Error('数据集缺少表头')); return }
    if (chosen !== null) {
      keptRows += 1
      const output = encode(chosen)
      if (lineage && !lineage.write(`${keptRows},${chosenIndex}\n`)) {
        lineage.once('drain', () => callback(null, output))
      } else callback(null, output)
      return
    }
    callback()
  } })
  lineage?.on('error', (error) => encoder.destroy(error))
  try {
    await pipeline(createReadStream(sortedPath), parser, encoder, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
    if (lineage) { lineage.end(); await finished(lineage) }
  } catch (error) { lineage?.destroy(); throw error }
  return { rowsIn: readRows, rowsOut: keptRows, removed: readRows - keptRows }
}
