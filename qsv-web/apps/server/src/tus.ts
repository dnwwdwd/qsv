import { readdir, readFile, lstat, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { FileStore } from '@tus/file-store'
import { MemoryLocker, Server } from '@tus/server'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ensureDurableDirectory, syncDirectory } from './commit.ts'
import { MAX_UPLOAD_BYTES, UploadValidationError, validateUploadName } from './files.ts'
import type { Identity } from './identity.ts'
import { ServiceError, WorkbenchService } from './service.ts'

const TUS_PATH = '/api/v1/tus'
const TUS_ID = /^[0-9a-f]{32}$/
const WORKSPACE_ID = /^[0-9a-f]{24}$/
const UPLOAD_KEY = /^[A-Za-z0-9_-]{16,128}$/
const scopedId = (workspaceId: string, id: string) => `${workspaceId}:${id}`

interface Entry { directory: string; store: FileStore; server: Server; locker: MemoryLocker }
interface Pending { workspaceId: string; bytes: number }

/** tus 文件只放在所属用户的私有目录，资源登记沿用普通上传的提交凭据。 */
export class TusUploads {
  private readonly service: WorkbenchService
  private readonly entries = new Map<string, Promise<Entry>>()
  private readonly pending = new Map<string, Pending>()
  private readonly writing = new Map<string, symbol>()
  private readonly committing = new Set<string>()
  private creationTail: Promise<void> = Promise.resolve()
  private activeChunkBytes = 0

  constructor(service: WorkbenchService) { this.service = service }

  private async serializeCreation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.creationTail
    let release!: () => void
    this.creationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private directory(owner: Identity) {
    return join(this.service.dataDir, 'owners', owner.workspaceId, 'uploads', 'tus')
  }

  private async entry(owner: Identity): Promise<Entry> {
    let task = this.entries.get(owner.workspaceId)
    if (!task) {
      task = this.createEntry(owner)
      this.entries.set(owner.workspaceId, task)
      void task.catch(() => { if (this.entries.get(owner.workspaceId) === task) this.entries.delete(owner.workspaceId) })
    }
    return task
  }

  private async createEntry(owner: Identity): Promise<Entry> {
    const directory = this.directory(owner)
    await ensureDurableDirectory(this.service.dataDir, join('owners', owner.workspaceId, 'uploads', 'tus'))
    const store = new FileStore({ directory })
    store.extensions = ['creation', 'termination']
    const locker = new MemoryLocker()
    const server = new Server({
      path: TUS_PATH,
      datastore: store,
      locker,
      maxSize: MAX_UPLOAD_BYTES,
      relativeLocation: true,
      allowedOrigins: () => false,
      onUploadCreate: async (_request, upload) => {
        const name = upload.metadata?.filename
        const key = upload.metadata?.uploadKey
        const fingerprint = upload.metadata?.fingerprint
        const sha256 = upload.metadata?.sha256
        if (typeof name !== 'string' || typeof key !== 'string' || typeof fingerprint !== 'string' || typeof sha256 !== 'string' ||
          !UPLOAD_KEY.test(key) || !/^[0-9a-f]{64}$/.test(fingerprint) || !/^[0-9a-f]{64}$/.test(sha256) ||
          !Number.isSafeInteger(upload.size) || upload.size! < 1 || upload.size! > MAX_UPLOAD_BYTES) {
          throw { status_code: 400, body: '上传元信息或文件大小无效' }
        }
        try {
          validateUploadName(name)
          if (upload.size! > this.service.uploadLimit(name)) throw { status_code: 413, body: '文件超过当前格式大小上限' }
        }
        catch (error) {
          if (error instanceof UploadValidationError) throw { status_code: 422, body: error.message }
          throw error
        }
        await this.serializeCreation(async () => {
          const { ownerBytes, globalBytes, remainingBytes, ownerCount, globalCount } = await this.scanReservations(owner.workspaceId)
          const concurrency = this.service.uploadConcurrency()
          if (ownerCount >= concurrency.owner || globalCount >= concurrency.global) throw { status_code: 429, body: '未完成上传数量已达到上限' }
          try { this.service.checkTusCapacity(owner, upload.size!, ownerBytes, globalBytes, remainingBytes) }
          catch (error) {
            if (error instanceof ServiceError) throw { status_code: error.status, body: error.message }
            throw error
          }
          this.pending.set(scopedId(owner.workspaceId, upload.id), { workspaceId: owner.workspaceId, bytes: upload.size! })
        })
        const timer = setTimeout(async () => {
          const key = scopedId(owner.workspaceId, upload.id)
          const current = this.pending.get(key)
          if (!current) return
          try { if (!await store.configstore.get(upload.id)) this.pending.delete(key) }
          catch { this.pending.delete(key) }
        }, 60_000)
        timer.unref()
        return { metadata: { filename: name, uploadKey: key, fingerprint, sha256, workspaceId: owner.workspaceId } }
      },
    })
    return { directory, store, server, locker }
  }

  private async scanReservations(ownerWorkspaceId: string) {
    let ownerBytes = 0
    let globalBytes = 0
    let remainingBytes = 0
    let ownerCount = 0
    let globalCount = 0
    const seen = new Set<string>()
    const ownersDir = join(this.service.dataDir, 'owners')
    let owners: string[] = []
    try { owners = (await readdir(ownersDir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && WORKSPACE_ID.test(entry.name)).map((entry) => entry.name) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const workspaceId of owners) {
      const path = join(ownersDir, workspaceId, 'uploads', 'tus')
      let files: string[] = []
      try { files = await readdir(path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      for (const file of files) {
        if (!/^[0-9a-f]{32}\.json$/.test(file)) continue
        const id = file.slice(0, -5)
        const key = scopedId(workspaceId, id)
        let record: { size?: unknown } | null = null
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            record = JSON.parse(await readFile(join(path, file), 'utf8')) as { size?: unknown }
            if (Number.isSafeInteger(record?.size) && (record.size as number) >= 1 && (record.size as number) <= MAX_UPLOAD_BYTES) break
            record = null
          } catch { record = null }
          if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
        if (!record) {
          const age = Date.now() - (await stat(join(path, file))).mtimeMs
          if (age < 60_000 || this.writing.has(key)) throw new ServiceError(503, 'UPLOAD_METADATA_BUSY', '续传记录暂时不可用，请重试')
          await rm(join(path, file), { force: true })
          await rm(join(path, id), { force: true })
          await syncDirectory(path)
          continue
        }
        seen.add(key)
        globalBytes += record.size as number
        globalCount += 1
        let uploaded = 0
        try { uploaded = (await stat(join(path, id))).size }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        remainingBytes += Math.max(0, (record.size as number) - uploaded)
        if (workspaceId === ownerWorkspaceId) { ownerBytes += record.size as number; ownerCount += 1 }
      }
    }
    for (const [key, pending] of this.pending) {
      if (seen.has(key)) continue
      globalBytes += pending.bytes
      remainingBytes += pending.bytes
      globalCount += 1
      if (pending.workspaceId === ownerWorkspaceId) { ownerBytes += pending.bytes; ownerCount += 1 }
    }
    return { ownerBytes, globalBytes, remainingBytes, ownerCount, globalCount }
  }

  async handle(request: FastifyRequest, reply: FastifyReply, owner: Identity) {
    const id = (request.params as { id?: string }).id
    if (id && !TUS_ID.test(id)) throw new ServiceError(404, 'UPLOAD_NOT_FOUND', '上传不存在')
    const scoped = id ? scopedId(owner.workspaceId, id) : null
    let aborted = false
    let handling = false
    let hadError = false
    let releaseAborted!: () => void
    const abortedTask = new Promise<void>((resolve) => { releaseAborted = resolve })
    let reservedChunk = 0
    let token: symbol | null = null
    let reservationReleased = false
    const releaseReservation = () => {
      if (reservationReleased || request.method !== 'PATCH') return
      reservationReleased = true
      if (scoped && token && this.writing.get(scoped) === token) this.writing.delete(scoped)
      this.activeChunkBytes -= reservedChunk
    }
    const onError = () => { hadError = true; aborted = true; releaseAborted() }
    const onClose = () => {
      if (request.raw.complete) return
      aborted = true
      // tus 的 Node 适配器只监听 request.error；浏览器中断也可能只发 close。
      // 补发错误，让内部写入流与锁结束；锁释放后才能允许续传或提交。
      if (handling && !hadError) request.raw.emit('error', new Error('上传连接已中断'))
      releaseAborted()
    }
    if (request.method === 'PATCH') {
      const length = Number(request.headers['content-length'])
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UPLOAD_BYTES) throw new ServiceError(411, 'UPLOAD_LENGTH_REQUIRED', '分块必须提供有效长度')
      if (scoped && this.writing.has(scoped)) throw new ServiceError(409, 'UPLOAD_BUSY', '该上传正在写入')
      this.service.checkTusChunkSpace(length + this.activeChunkBytes)
      token = Symbol(id)
      if (scoped) this.writing.set(scoped, token)
      this.activeChunkBytes += length
      reservedChunk = length
    }
    if (request.method === 'PATCH') {
      request.raw.on('error', onError)
      request.raw.once('close', onClose)
    }
    let entry: Entry | undefined
    try {
      entry = await this.entry(owner)
      if (aborted) return
      reply.hijack()
      const task = entry.server.handle(request.raw, reply.raw)
      handling = true
      if (aborted && !hadError) request.raw.emit('error', new Error('上传连接已中断'))
      await Promise.race([task, abortedTask])
    }
    finally {
      handling = false
      if (request.method === 'PATCH') {
        request.raw.off('close', onClose)
        request.raw.off('error', onError)
        // 断线后 tus 的外层处理 Promise 可能不结束；其内部文件锁仍会在写入流
        // 完成清理后释放。等待这个时刻，避免提交读取仍在写入的文件。
        if (entry && id) {
          while (entry.locker.locks.has(id)) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10))
          }
        }
      }
      releaseReservation()
      if (request.method === 'DELETE' && scoped && reply.raw.statusCode === 204) this.pending.delete(scoped)
    }
  }

  async commit(owner: Identity, id: string, key: string) {
    if (!TUS_ID.test(id)) throw new ServiceError(404, 'UPLOAD_NOT_FOUND', '上传不存在')
    if (!UPLOAD_KEY.test(key)) throw new ServiceError(400, 'INVALID_IDEMPOTENCY_KEY', '幂等键格式无效')
    const scoped = scopedId(owner.workspaceId, id)
    if (this.writing.has(scoped)) throw new ServiceError(409, 'UPLOAD_BUSY', '上传分块正在写入')
    if (this.committing.has(scoped)) throw new ServiceError(409, 'UPLOAD_BUSY', '上传文件正在提交')
    this.committing.add(scoped)
    try { return await this.commitOnce(owner, id, key) }
    finally { this.committing.delete(scoped) }
  }

  private async commitOnce(owner: Identity, id: string, key: string) {
    const entry = await this.entry(owner)
    const scoped = scopedId(owner.workspaceId, id)
    const record = await entry.store.configstore.get(id)
    if (!record) return this.service.rawByUploadKey(owner, key)
    const name = record.metadata?.filename
    const sha256 = record.metadata?.sha256
    if (typeof name !== 'string' || typeof sha256 !== 'string' || record.metadata?.uploadKey !== key) {
      throw new ServiceError(409, 'UPLOAD_METADATA_MISMATCH', '上传文件与提交请求不一致')
    }
    let existing: ReturnType<WorkbenchService['rawByUploadKey']> | null = null
    try { existing = this.service.rawByUploadKey(owner, key) }
    catch (error) { if (!(error instanceof ServiceError && error.status === 404)) throw error }
    if (existing) {
      if (existing.metadata.originalName !== name || existing.contentHash !== `sha256:${sha256}` || existing.byteSize !== record.size) {
        throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于不同文件')
      }
      await rm(join(entry.directory, id), { force: true })
      await entry.store.configstore.delete(id)
      await syncDirectory(entry.directory)
      this.pending.delete(scoped)
      return existing
    }
    let upload: Awaited<ReturnType<FileStore['getUpload']>>
    try { upload = await entry.store.getUpload(id) }
    catch { throw new ServiceError(404, 'UPLOAD_NOT_FOUND', '上传文件不存在') }
    if (upload.size !== upload.offset || !Number.isSafeInteger(upload.size) || upload.size! < 1) {
      throw new ServiceError(409, 'UPLOAD_INCOMPLETE', '上传数据尚未完整')
    }
    const path = join(entry.directory, id)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new ServiceError(409, 'UPLOAD_INVALID', '上传文件类型无效')
    const resource = await this.service.commitTusUpload(owner, path, name, key, upload.size!, sha256)
    await rm(path, { force: true })
    await entry.store.configstore.delete(id)
    await syncDirectory(entry.directory)
    this.pending.delete(scoped)
    return resource
  }
}
