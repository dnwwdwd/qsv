import { createReadStream } from 'node:fs'
import { Transform } from 'node:stream'
import parserStream from 'stream-json'
import pick from 'stream-json/filters/pick.js'
import type { Token } from 'stream-json/parser.js'

const MAX_CELL_BYTES = 1024 * 1024
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_DEPTH = 32
const MAX_EXPLODED_ROWS = 10_000

export class StructuredJsonError extends Error {}
type JsonNumber = { rawNumber: string }
type JsonValue = string | JsonNumber | boolean | null | Map<string, JsonValue> | JsonValue[]
type Frame = { kind: 'object'; value: Map<string, JsonValue>; key: string | null } | { kind: 'array'; value: JsonValue[] }
export interface StructureOptions { nested?: 'reject' | 'flatten' | 'stringify'; arrays?: 'reject' | 'stringify' | 'explode'; explodePath?: string }

function stringified(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stringified).join(',')}]`
  if (value instanceof Map) return `{${[...value].map(([key, child]) => `${JSON.stringify(key)}:${stringified(child)}`).join(',')}}`
  return value.rawNumber
}

function pointerPart(value: string) { return value.replaceAll('~', '~0').replaceAll('/', '~1') }
function pointerParts(value: string) {
  if (!value.startsWith('/') || value.length < 2 || value.length > 1024) throw new StructuredJsonError('数组展开路径必须是 /字段/子字段 形式')
  return value.slice(1).split('/').map((part) => {
    if (!part || /~(?![01])/u.test(part)) throw new StructuredJsonError('数组展开路径无效')
    return part.replaceAll('~1', '/').replaceAll('~0', '~')
  })
}

function atPointer(root: Map<string, JsonValue>, pointer: string): JsonValue | undefined {
  let node: JsonValue = root
  for (const part of pointerParts(pointer)) {
    if (!(node instanceof Map)) return undefined
    const child = node.get(part)
    if (child === undefined) return undefined
    node = child
  }
  return node
}

function addCell(record: Map<string, string | null>, kinds: Map<string, string>, path: string, value: string | null, kind: string) {
  if (value !== null && Buffer.byteLength(value, 'utf8') > MAX_CELL_BYTES) throw new StructuredJsonError(`字段 ${path.slice(0, 80)} 超过 1 MiB 单元格限制`)
  if (record.has(path)) throw new StructuredJsonError(`字段路径重复：${path.slice(0, 80)}`)
  record.set(path, value)
  kinds.set(path, kind)
  if (record.size > 4096) throw new StructuredJsonError('展开后的字段超过 4096 列')
}

export function projectStructuredRecord(root: Map<string, JsonValue>, options: StructureOptions): { cells: Map<string, string | null>; kinds: Map<string, string> }[] {
  const nested = options.nested ?? 'reject'
  const arrays = options.arrays ?? 'reject'
  const selected = arrays === 'explode' ? atPointer(root, options.explodePath ?? '') : undefined
  if (arrays === 'explode' && !Array.isArray(selected)) throw new StructuredJsonError('指定的数组展开路径不存在或不是数组')
  if (Array.isArray(selected) && selected.length > MAX_EXPLODED_ROWS) throw new StructuredJsonError('单条记录的数组展开超过 10000 行')
  const values = Array.isArray(selected) ? selected : [undefined]
  return values.map((replacement) => {
    const record = new Map<string, string | null>()
    const kinds = new Map<string, string>()
    const visit = (value: JsonValue, path: string, depth: number) => {
      if (depth > MAX_DEPTH) throw new StructuredJsonError('JSON 嵌套层数超过 32 层')
      if (value instanceof Map) {
        if (path && nested === 'reject') throw new StructuredJsonError(`嵌套对象 ${path.slice(0, 80)} 需要选择展开或字符串化`)
        if (path && nested === 'stringify') { addCell(record, kinds, path, stringified(value), 'object'); return }
        for (const [key, child] of value) visit(child, `${path}/${pointerPart(key)}`, depth + 1)
      } else if (Array.isArray(value)) {
        if (arrays === 'reject') throw new StructuredJsonError(`数组 ${path.slice(0, 80)} 需要选择处理方式`)
        addCell(record, kinds, path, stringified(value), 'array')
      } else if (value === null) addCell(record, kinds, path, null, 'null')
      else if (typeof value === 'string') addCell(record, kinds, path, value, 'string')
      else if (typeof value === 'boolean') addCell(record, kinds, path, String(value), 'boolean')
      else addCell(record, kinds, path, value.rawNumber, 'number')
    }
    for (const [key, value] of root) {
      const path = nested === 'reject' && arrays === 'reject' ? key : `/${pointerPart(key)}`
      if (arrays === 'explode' && path === options.explodePath) visit(replacement!, path, 1)
      else if (arrays === 'explode' && options.explodePath?.startsWith(`${path}/`)) {
        const branch = (node: JsonValue, branchPath: string, depth: number) => {
          if (branchPath === options.explodePath) { visit(replacement!, branchPath, depth); return }
          if (!(node instanceof Map)) throw new StructuredJsonError('数组展开路径必须经过对象字段')
          for (const [part, child] of node) {
            const childPath = `${branchPath}/${pointerPart(part)}`
            if (options.explodePath?.startsWith(childPath) && (options.explodePath === childPath || options.explodePath.startsWith(`${childPath}/`))) branch(child, childPath, depth + 1)
            else visit(child, childPath, depth + 1)
          }
        }
        branch(value, path, 1)
      } else visit(value, path, 1)
    }
    if (record.size === 0) throw new StructuredJsonError('JSON 记录没有可导入的字段')
    return { cells: record, kinds }
  })
}

/** 顶层对象数组或 JSONL，逐条构造最多 8 MiB 的记录；数字始终保留原始文本。 */
export async function* readStructuredJson(path: string, format: 'json' | 'jsonl', signal?: AbortSignal, dataPath?: string): AsyncGenerator<Map<string, JsonValue>> {
  if (dataPath && format !== 'json') throw new StructuredJsonError('JSONL 每行已经是一条记录，不能再指定数据路径')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const utf8 = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    try { callback(null, decoder.decode(chunk, { stream: true })) }
    catch { callback(new StructuredJsonError('JSON 文件包含无效的 UTF-8 字节')) }
  }, flush(callback) {
    try { callback(null, decoder.decode()) }
    catch { callback(new StructuredJsonError('JSON 文件尾部包含无效的 UTF-8 字节')) }
  } })
  const source = createReadStream(path, { signal })
  const parser = parserStream({ jsonStreaming: format === 'jsonl', packValues: false, streamValues: true })
  const parts = dataPath ? pointerParts(dataPath) : null
  const selector = parts ? pick.asStream({ once: true, filter: (stack: (string | number)[]) =>
    stack.length >= parts.length && parts.every((part, index) => stack[index] === part) }) : null
  source.on('error', (error) => parser.destroy(error))
  utf8.on('error', (error) => parser.destroy(error))
  parser.on('error', (error) => selector?.destroy(error))
  source.pipe(utf8).pipe(parser)
  if (selector) parser.pipe(selector)
  let rootArray = false
  let rootClosed = false
  let records = 0
  let recordBytes = 0
  let frames: Frame[] = []
  let tokenKind: 'key' | 'string' | 'number' | null = null
  let buffer = ''
  let bufferBytes = 0
  const addBytes = (text: string) => {
    const size = Buffer.byteLength(text, 'utf8')
    bufferBytes += size
    recordBytes += size + 2
    if (bufferBytes > MAX_CELL_BYTES || recordBytes > MAX_RECORD_BYTES) throw new StructuredJsonError(`第 ${records + 1} 条 JSON 记录超过单元格或记录大小限制`)
    buffer += text
  }
  const attach = (value: JsonValue) => {
    const top = frames.at(-1)
    if (!top) throw new StructuredJsonError(`第 ${records + 1} 条 JSON 记录结构无效`)
    recordBytes += 8
    if (top.kind === 'array') top.value.push(value)
    else {
      if (top.key === null || top.value.has(top.key)) throw new StructuredJsonError(`第 ${records + 1} 条 JSON 记录有缺失或重复字段`)
      top.value.set(top.key, value)
      top.key = null
    }
    if (recordBytes > MAX_RECORD_BYTES) throw new StructuredJsonError(`第 ${records + 1} 条 JSON 记录超过 8 MiB`)
  }
  try {
    for await (const raw of selector ?? parser) {
      if (signal?.aborted) throw new StructuredJsonError('JSON 导入已取消')
      const token = raw as Token
      switch (token.name) {
        case 'startArray':
          if (frames.length === 0 && format === 'json' && !rootArray && !rootClosed) { rootArray = true; break }
          if (!frames.length || frames.length >= MAX_DEPTH) throw new StructuredJsonError('JSON 数组位置无效或嵌套过深')
          frames.push({ kind: 'array', value: [] }); recordBytes += 2
          break
        case 'endArray': {
          if (!frames.length && rootArray && format === 'json') { rootArray = false; rootClosed = true; break }
          const done = frames.pop()
          if (!done || done.kind !== 'array') throw new StructuredJsonError('JSON 数组结构无效')
          attach(done.value)
          break
        }
        case 'startObject':
          if (!frames.length) {
            if ((format === 'json' && (!rootArray || rootClosed)) || (format === 'jsonl' && rootArray)) throw new StructuredJsonError('JSON 顶层必须是对象记录')
            recordBytes = 0
          }
          if (frames.length >= MAX_DEPTH) throw new StructuredJsonError('JSON 嵌套层数超过 32 层')
          frames.push({ kind: 'object', value: new Map(), key: null }); recordBytes += 2
          break
        case 'endObject': {
          const done = frames.pop()
          if (!done || done.kind !== 'object' || done.key !== null || tokenKind) throw new StructuredJsonError('JSON 对象结构无效')
          if (frames.length) attach(done.value)
          else { records += 1; yield done.value }
          break
        }
        case 'startKey':
          if (frames.at(-1)?.kind !== 'object' || (frames.at(-1) as Extract<Frame, { kind: 'object' }>).key !== null || tokenKind) throw new StructuredJsonError('JSON 字段位置无效')
          tokenKind = 'key'; buffer = ''; bufferBytes = 0
          break
        case 'endKey': {
          const top = frames.at(-1)
          if (tokenKind !== 'key' || !top || top.kind !== 'object') throw new StructuredJsonError('JSON 字段名无效')
          top.key = buffer; tokenKind = null
          break
        }
        case 'startString':
        case 'startNumber':
          if (!frames.length || tokenKind) throw new StructuredJsonError('JSON 值位置无效')
          tokenKind = token.name === 'startString' ? 'string' : 'number'; buffer = ''; bufferBytes = 0
          break
        case 'endString':
        case 'endNumber':
          if ((token.name === 'endString' && tokenKind !== 'string') || (token.name === 'endNumber' && tokenKind !== 'number')) throw new StructuredJsonError('JSON 值结构无效')
          attach(tokenKind === 'number' ? { rawNumber: buffer } : buffer); tokenKind = null
          break
        case 'stringChunk':
        case 'numberChunk':
          if ((token.name === 'stringChunk' && !['key', 'string'].includes(tokenKind ?? '')) || (token.name === 'numberChunk' && tokenKind !== 'number')) throw new StructuredJsonError('JSON 值片段无效')
          addBytes(token.value)
          break
        case 'nullValue': attach(null); break
        case 'trueValue': attach(true); break
        case 'falseValue': attach(false); break
      }
    }
    if ((format === 'json' && !rootClosed) || frames.length || tokenKind) throw new StructuredJsonError('JSON 文件末尾记录不完整')
  } catch (error) {
    if (error instanceof StructuredJsonError) throw error
    if (signal?.aborted) throw new StructuredJsonError('JSON 导入已取消')
    throw new StructuredJsonError(`JSON 格式无效，靠近第 ${records + 1} 条记录`)
  } finally {
    source.destroy(); utf8.destroy(); parser.destroy(); selector?.destroy()
  }
}
