import { createSHA256 } from 'hash-wasm'

const CHUNK_BYTES = 4 * 1024 * 1024

/** 文件按块读取；刷新后重新选择时使用完整摘要核对续传内容。 */
export async function fileDigest(file: File, onProgress: (readBytes: number) => void, signal?: AbortSignal) {
  const hasher = await createSHA256()
  hasher.init()
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    if (signal?.aborted) throw new DOMException('文件校验已取消', 'AbortError')
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
    hasher.update(bytes)
    onProgress(Math.min(offset + bytes.byteLength, file.size))
  }
  if (signal?.aborted) throw new DOMException('文件校验已取消', 'AbortError')
  const sha256 = hasher.digest('hex')
  const fingerprintBytes = new TextEncoder().encode(`${file.name}\n${file.size}\n${sha256}`)
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', fingerprintBytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { sha256, fingerprint }
}
