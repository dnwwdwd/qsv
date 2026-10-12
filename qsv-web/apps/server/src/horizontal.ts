import { createReadStream, createWriteStream } from 'node:fs'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { parse } from 'csv-parse'

export class HorizontalError extends Error {}

function cell(value: string) { return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value }
function line(values: string[]) { return `${values.map(cell).join(',')}\n` }

/** 按原始行位置横向拼接；每份输入仅持有当前一条记录。 */
export async function writeHorizontalConcat(paths: string[], outputPath: string, expectedRows: number[], padMissing: boolean,
  signal?: AbortSignal) {
  if (paths.length < 2 || paths.length > 20 || paths.length !== expectedRows.length) throw new HorizontalError('横向拼接输入数量无效')
  const inputs = paths.map((path) => {
    const source = createReadStream(path, { signal })
    const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
    source.on('error', (error) => parser.destroy(error))
    source.pipe(parser)
    return { source, parser, iterator: (parser as AsyncIterable<string[]>)[Symbol.asyncIterator]() }
  })
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  const write = async (data: string) => { if (!output.write(data)) await once(output, 'drain') }
  try {
    const first = await Promise.all(inputs.map((input) => input.iterator.next()))
    if (first.some((item) => item.done || !item.value?.length)) throw new HorizontalError('横向拼接输入缺少表头')
    const headers: string[][] = first.map((item) => item.value as string[])
    if (headers.reduce((sum, columns) => sum + columns.length, 0) > 4096) throw new HorizontalError('横向拼接超过 4096 列')
    const used = new Set<string>()
    const combined = headers.flatMap((columns, sourceIndex) => columns.map((name, columnIndex) => {
      const base = name || `第${sourceIndex + 1}份_列${columnIndex + 1}`
      let outputName = base
      let suffix = 2
      while (used.has(outputName)) outputName = `${base}_${suffix++}`
      used.add(outputName)
      return outputName
    }))
    await write(line(combined))
    const counts = inputs.map(() => 0)
    let rows = 0
    while (true) {
      if (signal?.aborted) throw new HorizontalError('横向拼接已取消')
      const next = await Promise.all(inputs.map((input) => input.iterator.next()))
      if (next.every((item) => item.done)) break
      if (!padMissing && next.some((item) => item.done)) throw new HorizontalError('输入行数不一致，已按设置停止横向拼接')
      const joined: string[] = []
      next.forEach((item, index) => {
        if (item.done) joined.push(...Array.from({ length: headers[index]!.length }, () => ''))
        else {
          if (item.value.length !== headers[index]!.length) throw new HorizontalError(`第 ${index + 1} 份数据的第 ${counts[index]! + 1} 行字段数不一致`)
          joined.push(...item.value)
          counts[index] = counts[index]! + 1
        }
      })
      await write(line(joined))
      rows += 1
    }
    if (counts.some((count, index) => count !== expectedRows[index])) throw new HorizontalError('横向拼接输入行数与资源记录不一致')
    output.end()
    await finished(output)
    return { rows, headers: combined }
  } catch (error) { output.destroy(); throw error }
  finally { for (const input of inputs) { input.source.destroy(); input.parser.destroy(); await input.iterator.return?.() } }
}
