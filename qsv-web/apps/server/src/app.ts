import Fastify from 'fastify'
import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { EngineProbe } from './engine.ts'
import { localIdentity, type Identity } from './identity.ts'
import type { AuthProvider } from './oidc-auth.ts'
import { ServiceError, WorkbenchService } from './service.ts'
import type { CsvImportOptions } from './csv.ts'
import type { ColumnType } from './column-types.ts'
import type { CompareConfig } from './compare.ts'
import type { QualityOutputMode, QualityRule } from './quality.ts'
import type { JsonImportOptions } from './json-import.ts'
import type { ExportScope } from './export-scope.ts'
import type { SplitConfig } from './split.ts'
import type { ViewPlan } from './view-operation.ts'
import type { AggregateConfig } from './aggregate.ts'
import type { RelationConfig } from './relation.ts'
import type { SetConfig } from './set-operation.ts'
import type { ReshapeConfig } from './reshape.ts'
import type { PivotConfig } from './pivot.ts'
import type { CleanPlan } from './clean-plan.ts'
import type { SqlParameters } from './sql-parameters.ts'
import type { CellPatch } from './cell-edit.ts'
import type { JsonExportOptions, TextExportOptions } from './export.ts'
import type { DateInputFormat } from './transform.ts'
import { TusUploads } from './tus.ts'
import { ORDERS_EXAMPLE_CONTENT, ORDERS_EXAMPLE_HASH, ORDERS_EXAMPLE_IMPORT_KEY, ORDERS_EXAMPLE_NAME, ORDERS_EXAMPLE_UPLOAD_KEY } from './example.ts'

/** 构建产物（含扩展名）可免鉴权读取；登录页需要它们才能渲染。 */
const STATIC_ASSET = /\.[A-Za-z0-9]+$/u

const APP_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const viewConditionSchema = { type: 'object', required: ['columnId', 'operator'], additionalProperties: false,
  properties: { columnId: { type: 'string', pattern: '^c_[0-9]+$' }, operator: { type: 'string',
    enum: ['equals', 'not-equals', 'contains', 'starts', 'ends', 'is-empty', 'not-empty', 'between', 'in', 'pattern'] },
    value: { type: 'string', maxLength: 512 }, other: { type: 'string', maxLength: 512 },
    values: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 512 } } } }

declare module 'fastify' {
  interface FastifyRequest { identity?: Identity }
}

interface AppOptions { service?: WorkbenchService; authMode?: 'local' | 'lazycat'; oidc?: AuthProvider; webDist?: string }

function pageRange(query: { offset?: string; limit?: string }) {
  const offset = Number(query.offset ?? 0)
  const limit = Number(query.limit ?? 50)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ServiceError(400, 'INVALID_PAGE', '分页范围无效')
  }
  return { offset, limit }
}

export function createApp(probe: EngineProbe, options: AppOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 300 * 1024 })
  const mode = options.authMode ?? 'local'

  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload))
  app.addContentTypeParser('application/offset+octet-stream', (_request, _payload, done) => done(null))

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]
    // 登录页本身、登录回调与健康检查必须免鉴权，否则用户无法进入登录流程。
    if (path === '/health' || path === '/login' || path.startsWith('/auth/')) return
    const identity = mode === 'lazycat' ? options.oidc?.identityFor(request) ?? null : localIdentity()
    if (!identity) {
      if (path.startsWith('/api/')) {
        reply.code(401).send({ requestId: request.id, error: { code: 'UNAUTHENTICATED', message: '请先登录' } })
        return
      }
      // 静态资源（带扩展名的构建产物）必须放行，否则登录页自身无法加载；
      // 页面路由与深链接一律先送到登录页。这里不含任何用户数据。
      if (request.method === 'GET' && !STATIC_ASSET.test(path)) return reply.redirect('/login')
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        reply.code(401).send({ requestId: request.id, error: { code: 'UNAUTHENTICATED', message: '请先登录' } })
        return
      }
      return
    }
    request.identity = identity
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-qsv-request'] !== '1') {
      reply.code(403).send({ requestId: request.id, error: { code: 'REQUEST_HEADER_REQUIRED', message: '请求缺少安全标记' } })
    }
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      reply.code(error.status).send({ requestId: request.id, error: { code: error.code, message: error.message } })
      return
    }
    if (typeof error === 'object' && error !== null && 'validation' in error && error.validation) {
      reply.code(400).send({ requestId: request.id, error: { code: 'INVALID_REQUEST', message: '请求参数无效' } })
      return
    }
    reply.code(500).send({ requestId: request.id, error: { code: 'INTERNAL_ERROR', message: '服务处理失败' } })
  })

  app.get('/health', async () => ({ status: 'ok' }))
  if (mode === 'lazycat' && options.oidc) {
    app.get('/auth/login', async (_request, reply) => options.oidc!.login(reply))
    app.get('/auth/oidc/callback', async (request, reply) => options.oidc!.callback(request, reply))
    app.get('/auth/signed-out', async (_request, reply) => reply.type('text/html; charset=utf-8')
      .send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>已退出</title><body style="font:16px system-ui;max-width:36rem;margin:12vh auto;padding:1.5rem"><h1>已退出 qsv 数据工作台</h1><p>当前应用会话已结束。平台登录状态由懒猫微服管理。</p><a href="/auth/login">重新进入工作台</a></body></html>'))
  }
  app.get('/api/v1/capabilities', async (request) => ({
    requestId: request.id,
    app: { version: APP_VERSION,
      license: 'MIT', mode: mode === 'lazycat' ? 'lazycat' : 'local',
      importFormats: ['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'json', 'jsonl', 'ndjson', 'parquet'],
      exportFormats: ['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet'] },
    engine: { version: probe.version, sha256: probe.sha256, platform: probe.platform, verified: probe.verified, reason: probe.reason },
    operations: probe.operations,
  }))

  if (options.service) {
    const service = options.service
    const tus = new TusUploads(service)
    const who = (identity: Identity | undefined) => {
      if (!identity) throw new ServiceError(401, 'UNAUTHENTICATED', '请先登录')
      return identity
    }

    app.get('/api/v1/session', async (request) => ({
      requestId: request.id,
      user: { name: who(request.identity).displayName, workspaceId: who(request.identity).workspaceId, role: who(request.identity).role ?? 'normal' },
      source: who(request.identity).source,
    }))
    app.post('/api/v1/logout', async (request, reply) => {
      if (mode === 'lazycat' && options.oidc) return { requestId: request.id, ...options.oidc.logout(request, reply) }
      return { requestId: request.id, signedOut: false }
    })
    app.get('/api/v1/overview', async (request) => ({ requestId: request.id, ...service.overview(who(request.identity)) }))
    app.get('/api/v1/storage', async (request) => ({ requestId: request.id, ...service.storage(who(request.identity)) }))
    app.get('/api/v1/storage/details', async (request) => ({ requestId: request.id,
      ...await service.storageDetails(who(request.identity)) }))
    app.post('/api/v1/storage/clear-cache', async (request) => ({ requestId: request.id,
      ...service.clearPreviewCache(who(request.identity)) }))
    app.get('/api/v1/storage/cleanup-preview', async (request) => ({ requestId: request.id,
      ...await service.cleanupPreview(who(request.identity)) }))
    app.delete<{ Params: { id: string }; Body: { expectedUpdatedAt: number } }>('/api/v1/storage/trash/:id/permanent', {
      schema: { body: { type: 'object', required: ['expectedUpdatedAt'], additionalProperties: false,
        properties: { expectedUpdatedAt: { type: 'integer', minimum: 0 } } } },
    }, async (request) => ({ requestId: request.id,
      ...await service.purgeTrashedResource(who(request.identity), request.params.id, request.body.expectedUpdatedAt) }))
    app.get('/api/v1/settings', async (request) => ({ requestId: request.id,
      ...service.getUserSettings(who(request.identity)) }))
    app.put<{ Body: { settings: { defaultEncoding: string; timezone: string; outputFormat: string; safeText: boolean };
      expectedUpdatedAt: number | null } }>('/api/v1/settings', {
      schema: { body: { type: 'object', required: ['settings', 'expectedUpdatedAt'], additionalProperties: false,
        properties: { settings: { type: 'object', required: ['defaultEncoding', 'timezone', 'outputFormat', 'safeText'], additionalProperties: false,
          properties: { defaultEncoding: { type: 'string' }, timezone: { type: 'string', minLength: 1, maxLength: 64 },
            outputFormat: { type: 'string' }, safeText: { type: 'boolean' } } },
          expectedUpdatedAt: { type: ['integer', 'null'], minimum: 0 } } } },
    }, async (request) => ({ requestId: request.id,
      ...service.updateUserSettings(who(request.identity), request.body.settings, request.body.expectedUpdatedAt) }))
    app.get('/api/v1/admin/limits', async (request) => ({ requestId: request.id, ...service.appLimits(who(request.identity)) }))
    app.put<{ Body: { limits: unknown; expectedUpdatedAt: number | null } }>('/api/v1/admin/limits', {
      schema: { body: { type: 'object', required: ['limits', 'expectedUpdatedAt'], additionalProperties: false,
        properties: { limits: { type: 'object' }, expectedUpdatedAt: { type: ['integer', 'null'], minimum: 0 } } } },
    }, async (request) => ({ requestId: request.id, ...service.saveAppLimits(who(request.identity), request.body.limits,
      request.body.expectedUpdatedAt) }))
    app.get<{ Querystring: { q?: string } }>('/api/v1/search', async (request) => ({
      requestId: request.id, ...service.search(who(request.identity), request.query.q ?? ''),
    }))

    app.get<{ Querystring: { offset?: string; limit?: string; cursor?: string } }>('/api/v1/resources', async (request) => {
      const { offset, limit } = pageRange(request.query)
      return { requestId: request.id, ...(request.query.cursor === undefined
        ? service.listResources(who(request.identity), offset, limit)
        : service.listResourcesAfter(who(request.identity), request.query.cursor, limit)) }
    })
    app.get<{ Querystring: { offset?: string; limit?: string; name?: string; format?: string; kind?: string; status?: string; from?: string; to?: string } }>('/api/v1/resources/find', async (request) => {
      const { offset, limit } = pageRange(request.query)
      return { requestId: request.id, ...service.findResources(who(request.identity), {
        name: request.query.name, format: request.query.format, kind: request.query.kind, status: request.query.status,
        from: request.query.from === undefined ? undefined : Number(request.query.from),
        to: request.query.to === undefined ? undefined : Number(request.query.to),
      }, offset, limit) }
    })
    app.get<{ Querystring: { sha256: string; bytes: string; format: string } }>('/api/v1/uploads/matches', {
      schema: { querystring: { type: 'object', required: ['sha256', 'bytes', 'format'], additionalProperties: false,
        properties: { sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, bytes: { type: 'integer', minimum: 1, maximum: 5 * 1024 * 1024 * 1024 },
          format: { type: 'string', enum: ['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'json', 'jsonl', 'ndjson', 'parquet'] } } } },
    }, async (request) => ({ requestId: request.id, items: service.matchingRawUploads(who(request.identity), request.query.sha256, Number(request.query.bytes), request.query.format) }))
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id', async (request) => ({ requestId: request.id, resource: service.getResource(who(request.identity), request.params.id) }))
    app.get<{ Querystring: { offset?: string; limit?: string } }>('/api/v1/trash', async (request) => {
      const { offset, limit } = pageRange(request.query)
      return { requestId: request.id, ...service.listTrashedResources(who(request.identity), offset, limit) }
    })
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/dependencies', async (request) => ({
      requestId: request.id, ...service.resourceDependencies(who(request.identity), request.params.id),
    }))
    app.post<{ Params: { id: string }; Body: { expectedUpdatedAt: number } }>('/api/v1/resources/:id/trash', {
      schema: { body: { type: 'object', required: ['expectedUpdatedAt'], additionalProperties: false,
        properties: { expectedUpdatedAt: { type: 'integer', minimum: 0 } } } },
    }, async (request) => ({ requestId: request.id, resource: service.trashResource(who(request.identity), request.params.id, request.body.expectedUpdatedAt) }))
    app.post<{ Params: { id: string }; Body: { expectedUpdatedAt: number } }>('/api/v1/resources/:id/restore', {
      schema: { body: { type: 'object', required: ['expectedUpdatedAt'], additionalProperties: false,
        properties: { expectedUpdatedAt: { type: 'integer', minimum: 0 } } } },
    }, async (request) => ({ requestId: request.id, resource: service.restoreResource(who(request.identity), request.params.id, request.body.expectedUpdatedAt) }))
    app.patch<{ Params: { id: string }; Body: { name: string; description: string; expectedUpdatedAt: number } }>('/api/v1/resources/:id', {
      schema: { body: { type: 'object', required: ['name', 'description', 'expectedUpdatedAt'], additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 255 }, description: { type: 'string', maxLength: 1000 }, expectedUpdatedAt: { type: 'integer', minimum: 0 } } } },
    }, async (request) => ({ requestId: request.id, resource: service.updateResourceDetails(who(request.identity), request.params.id,
      request.body.name, request.body.description, request.body.expectedUpdatedAt) }))
    app.get<{ Params: { key: string } }>('/api/v1/uploads/by-key/:key', async (request) => ({ requestId: request.id, resource: service.rawByUploadKey(who(request.identity), request.params.key) }))
    app.post<{ Params: { id: string }; Body: { csv?: CsvImportOptions } }>('/api/v1/resources/:id/preview', {
      schema: { body: { type: 'object', additionalProperties: false, properties: { csv: { type: 'object', required: ['encoding', 'delimiter', 'header'], additionalProperties: false,
        properties: { encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] }, delimiter: { type: 'string', enum: [',', ';', '\t', '|'] }, header: { type: 'string', enum: ['first-row', 'none'] },
          quote: { type: 'string', enum: ['"', "'"] }, headerRow: { type: 'integer', minimum: 1, maximum: 1000000 }, dataStartRow: { type: 'integer', minimum: 1, maximum: 1000000000 },
          dataEndRow: { type: ['integer', 'null'], minimum: 1, maximum: 1000000000 }, skipEmptyLines: { type: 'boolean' },
          invalidRows: { type: 'string', enum: ['reject', 'isolate'] }, headerRowCount: { type: 'integer', minimum: 1, maximum: 5 },
          headerJoin: { type: 'string', enum: ['space', 'slash', 'underscore'] }, headerFill: { type: 'boolean' } } } } } },
    }, async (request) => ({ requestId: request.id, preview: await service.previewRawCsv(who(request.identity), request.params.id, request.body?.csv) }))
    app.post<{ Params: { id: string }; Body: { json?: JsonImportOptions } }>('/api/v1/resources/:id/json-preview', {
      schema: { body: { type: 'object', additionalProperties: false, properties: {
        json: { type: 'object', required: ['nulls', 'missing'], additionalProperties: false,
          properties: { nulls: { type: 'string', enum: ['reject', 'empty'] }, missing: { type: 'string', enum: ['reject', 'empty'] },
            newFields: { type: 'string', enum: ['reject', 'ignore', 'include'] },
            nested: { type: 'string', enum: ['reject', 'flatten', 'stringify'] }, arrays: { type: 'string', enum: ['reject', 'stringify', 'explode'] },
            explodePath: { type: 'string', minLength: 2, maxLength: 1024 },
            dataPath: { type: 'string', minLength: 2, maxLength: 1024 },
            typeConflict: { type: 'string', enum: ['text', 'reject'] },
            invalidRecords: { type: 'string', enum: ['reject', 'isolate'] },
            projection: { type: 'array', minItems: 1, maxItems: 4096, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } } } },
      } } },
    }, async (request) => ({ requestId: request.id, preview: await service.previewRawJson(who(request.identity), request.params.id, request.body?.json) }))
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/parquet-preview', async (request) =>
      ({ requestId: request.id, preview: await service.previewRawParquet(who(request.identity), request.params.id) }))
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/schema', async (request) => ({ requestId: request.id, schema: service.getSchema(who(request.identity), request.params.id) }))
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/import-preview', async (request) => ({ requestId: request.id,
      result: await service.previewImportResult(who(request.identity), request.params.id) }))
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/versions', async (request) => ({ requestId: request.id,
      versions: service.listDatasetVersions(who(request.identity), request.params.id) }))
    app.post<{ Params: { id: string }; Body: { expectedRevision: string; patches: CellPatch[] } }>('/api/v1/resources/:id/edits', {
      schema: { body: { type: 'object', required: ['expectedRevision', 'patches'], additionalProperties: false,
        properties: { expectedRevision: { type: 'string', maxLength: 100 }, patches: { type: 'array', minItems: 1,
          maxItems: 10000, items: { type: 'object', required: ['rowId', 'columnId', 'expectedOldValue', 'newValue'],
            additionalProperties: false, properties: { rowId: { type: 'string', maxLength: 120 }, columnId: { type: 'string', maxLength: 40 },
              expectedOldValue: { type: 'string' }, newValue: { type: 'string' } } } } } } },
    }, async (request, reply) => {
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitCellEdits(who(request.identity), request.params.id, request.body.expectedRevision,
        request.body.patches, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/sheets', async (request) => ({ requestId: request.id, sheets: await service.workbookSheets(who(request.identity), request.params.id) }))
    app.post<{ Params: { id: string }; Body: { sheetName: string; csv?: CsvImportOptions } }>('/api/v1/resources/:id/sheets/preview', {
      schema: { body: { type: 'object', required: ['sheetName'], additionalProperties: false, properties: {
        sheetName: { type: 'string', minLength: 1, maxLength: 255 },
        csv: { type: 'object', required: ['encoding', 'delimiter', 'header'], additionalProperties: false, properties: {
          encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] },
          delimiter: { type: 'string', enum: [',', ';', '\t', '|'] }, header: { type: 'string', enum: ['first-row', 'none'] },
          quote: { type: 'string', enum: ['"', "'"] }, headerRow: { type: 'integer', minimum: 1, maximum: 1000000 },
          dataStartRow: { type: 'integer', minimum: 1, maximum: 1000000000 },
          dataEndRow: { type: ['integer', 'null'], minimum: 1, maximum: 1000000000 }, skipEmptyLines: { type: 'boolean' },
          invalidRows: { type: 'string', enum: ['reject', 'isolate'] },
          headerRowCount: { type: 'integer', minimum: 1, maximum: 5 }, headerJoin: { type: 'string', enum: ['space', 'slash', 'underscore'] },
          headerFill: { type: 'boolean' },
        } },
      } } },
    }, async (request) => ({ requestId: request.id, preview: await service.previewWorkbookSheet(who(request.identity), request.params.id, request.body.sheetName, request.body.csv) }))
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/download', async (request, reply) => {
      const file = await service.downloadPath(who(request.identity), request.params.id)
      const safeName = encodeURIComponent(file.name)
      const mime = file.format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
        file.format === 'xlsm' ? 'application/vnd.ms-excel.sheet.macroEnabled.12' :
        file.format === 'xlsb' ? 'application/vnd.ms-excel.sheet.binary.macroEnabled.12' :
        file.format === 'xls' ? 'application/vnd.ms-excel' :
        file.format === 'ods' ? 'application/vnd.oasis.opendocument.spreadsheet' :
        file.format === 'parquet' ? 'application/vnd.apache.parquet' :
        file.format === 'zip' ? 'application/zip' :
        file.format === 'json' ? 'application/json; charset=utf-8' :
        file.format === 'jsonl' || file.format === 'ndjson' ? 'application/x-ndjson; charset=utf-8' :
        file.format === 'tsv' ? 'text/tab-separated-values; charset=utf-8' : 'text/csv; charset=utf-8'
      reply.header('Content-Type', mime)
      reply.header('Content-Disposition', `attachment; filename="download.${file.format}"; filename*=UTF-8''${safeName}`)
      if (file.bytes !== null) reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })
    app.get<{ Params: { id: string; step: string; kind: 'errors' | 'duplicates' | 'empty-rows' } }>('/api/v1/resources/:id/clean-reports/:step/:kind', async (request, reply) => {
      const file = await service.cleanReportPath(who(request.identity), request.params.id, Number(request.params.step), request.params.kind)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })
    app.get<{ Params: { id: string; side: 'left' | 'right' } }>('/api/v1/resources/:id/relation-reports/:side', async (request, reply) => {
      const file = await service.relationReportPath(who(request.identity), request.params.id, request.params.side)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/json-import-report', async (request, reply) => {
      const file = await service.jsonImportReportPath(who(request.identity), request.params.id)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/json-conversion-report', async (request, reply) => {
      const file = await service.jsonConversionReportPath(who(request.identity), request.params.id)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })
    app.get<{ Params: { id: string } }>('/api/v1/resources/:id/csv-import-report', async (request, reply) => {
      const file = await service.csvImportReportPath(who(request.identity), request.params.id)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })
    app.get<{ Params: { id: string } }>('/api/v1/split-results/:id/manifest', async (request) =>
      ({ requestId: request.id, manifest: await service.getSplitManifest(who(request.identity), request.params.id) }))
    app.get<{ Params: { id: string; name: string } }>('/api/v1/split-results/:id/files/:name', async (request, reply) => {
      const file = await service.getSplitFile(who(request.identity), request.params.id, request.params.name)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="${file.name}"`)
      reply.header('Content-Length', file.bytes)
      return reply.send(createReadStream(file.path))
    })

    app.post('/api/v1/uploads', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const encoded = request.headers['x-file-name']
      if (typeof encoded !== 'string') throw new ServiceError(400, 'FILE_NAME_REQUIRED', '缺少文件名')
      let name: string
      try { name = decodeURIComponent(encoded) } catch { throw new ServiceError(400, 'INVALID_FILE_NAME', '文件名编码无效') }
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const contentLength = Number(request.headers['content-length'])
      const resource = await service.upload(who(request.identity), request.body as Readable, name, key, contentLength)
      reply.code(201)
      return { requestId: request.id, resource }
    })

    app.post('/api/v1/examples/orders/import', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const owner = who(request.identity)
      let raw: ReturnType<WorkbenchService['rawByUploadKey']> | null = null
      try { raw = service.rawByUploadKey(owner, ORDERS_EXAMPLE_UPLOAD_KEY) }
      catch (error) { if (!(error instanceof ServiceError && error.status === 404)) throw error }
      if (!raw) raw = await service.upload(owner, Readable.from([ORDERS_EXAMPLE_CONTENT]), ORDERS_EXAMPLE_NAME,
        ORDERS_EXAMPLE_UPLOAD_KEY, ORDERS_EXAMPLE_CONTENT.length)
      if (raw.metadata.originalName !== ORDERS_EXAMPLE_NAME || raw.contentHash !== ORDERS_EXAMPLE_HASH) {
        throw new ServiceError(409, 'EXAMPLE_CONFLICT', '示例上传键已被其他内容占用')
      }
      reply.code(202)
      return { requestId: request.id, ...service.submitImport(owner, raw.id, ORDERS_EXAMPLE_IMPORT_KEY) }
    })

    app.all('/api/v1/tus', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      await tus.handle(request, reply, who(request.identity))
    })
    app.all<{ Params: { id: string } }>('/api/v1/tus/:id', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      await tus.handle(request, reply, who(request.identity))
    })
    app.post<{ Params: { id: string } }>('/api/v1/tus/:id/commit', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const resource = await tus.commit(who(request.identity), request.params.id, key)
      reply.code(201)
      return { requestId: request.id, resource }
    })

    app.post<{ Body: { rawResourceId: string; csv?: CsvImportOptions; json?: JsonImportOptions; sheetName?: string;
      columnTypes?: Record<string, ColumnType> } }>('/api/v1/imports', {
      schema: { body: { type: 'object', required: ['rawResourceId'], additionalProperties: false, properties: {
        rawResourceId: { type: 'string', maxLength: 80 },
        sheetName: { type: 'string', maxLength: 255 },
        columnTypes: { type: 'object', maxProperties: 4096, additionalProperties: { type: 'string', enum: ['string', 'integer', 'decimal', 'boolean', 'date'] } },
        csv: { type: 'object', required: ['encoding', 'delimiter', 'header'], additionalProperties: false, properties: {
          encoding: { type: 'string', enum: ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'] },
          delimiter: { type: 'string', enum: [',', ';', '\t', '|'] },
          header: { type: 'string', enum: ['first-row', 'none'] },
          quote: { type: 'string', enum: ['"', "'"] }, headerRow: { type: 'integer', minimum: 1, maximum: 1000000 },
          dataStartRow: { type: 'integer', minimum: 1, maximum: 1000000000 },
          dataEndRow: { type: ['integer', 'null'], minimum: 1, maximum: 1000000000 }, skipEmptyLines: { type: 'boolean' },
          invalidRows: { type: 'string', enum: ['reject', 'isolate'] },
          headerRowCount: { type: 'integer', minimum: 1, maximum: 5 }, headerJoin: { type: 'string', enum: ['space', 'slash', 'underscore'] },
          headerFill: { type: 'boolean' },
        } },
        json: { type: 'object', required: ['nulls', 'missing'], additionalProperties: false, properties: {
          nulls: { type: 'string', enum: ['reject', 'empty'] }, missing: { type: 'string', enum: ['reject', 'empty'] },
          newFields: { type: 'string', enum: ['reject', 'ignore', 'include'] },
          nested: { type: 'string', enum: ['reject', 'flatten', 'stringify'] }, arrays: { type: 'string', enum: ['reject', 'stringify', 'explode'] },
          explodePath: { type: 'string', minLength: 2, maxLength: 1024 },
          dataPath: { type: 'string', minLength: 2, maxLength: 1024 },
          typeConflict: { type: 'string', enum: ['text', 'reject'] },
          invalidRecords: { type: 'string', enum: ['reject', 'isolate'] },
          projection: { type: 'array', minItems: 1, maxItems: 4096, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1024 } },
        } },
      } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitImport(who(request.identity), request.body.rawResourceId, key, null, request.body.csv, request.body.sheetName,
        request.body.json, request.body.columnTypes)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; columnId: string; mode: 'equals' | 'contains'; value: string } }>('/api/v1/filters', {
      schema: { body: { type: 'object', required: ['sourceId', 'columnId', 'mode', 'value'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, columnId: { type: 'string', pattern: '^c_[0-9]+$' },
          mode: { type: 'string', enum: ['equals', 'contains'] }, value: { type: 'string', maxLength: 512 } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitFilter(who(request.identity), request.body.sourceId, request.body.columnId, request.body.mode, request.body.value, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.post<{ Body: { sourceId: string; plan: ViewPlan } }>('/api/v1/filter-plans', {
      schema: { body: { type: 'object', required: ['sourceId', 'plan'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, plan: { type: 'object', required: ['combine', 'conditions', 'sorts'], additionalProperties: false,
          properties: { combine: { type: 'string', enum: ['and', 'or'] },
            conditions: { type: 'array', maxItems: 16, items: viewConditionSchema },
            groups: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', required: ['combine', 'conditions'], additionalProperties: false,
              properties: { combine: { type: 'string', enum: ['and', 'or'] },
                conditions: { type: 'array', minItems: 1, maxItems: 16, items: viewConditionSchema } } } },
            sorts: { type: 'array', maxItems: 4, items: { type: 'object', required: ['columnId', 'direction', 'empty'], additionalProperties: false,
              properties: { columnId: { type: 'string', pattern: '^c_[0-9]+$' }, direction: { type: 'string', enum: ['asc', 'desc'] },
                empty: { type: 'string', enum: ['first', 'last'] } } } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitFilterPlan(who(request.identity), request.body.sourceId, request.body.plan, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; columnId: string; mode: 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'replace' | 'fill-empty' | 'nfc' | 'nfkc' | 'date-iso'; find?: string; replacement?: string; dateFormat?: 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy' } }>('/api/v1/cleans', {
      schema: { body: { type: 'object', required: ['sourceId', 'columnId', 'mode'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, columnId: { type: 'string', pattern: '^c_[0-9]+$' },
          mode: { type: 'string', enum: ['trim', 'squeeze', 'squeeze0', 'lower', 'upper', 'replace', 'fill-empty', 'nfc', 'nfkc', 'date-iso'] },
          find: { type: 'string', maxLength: 512 }, replacement: { type: 'string', maxLength: 512 },
          dateFormat: { type: 'string', enum: ['yyyy-MM-dd', 'yyyy/MM/dd', 'dd/MM/yyyy', 'MM/dd/yyyy'] } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitClean(who(request.identity), request.body.sourceId, request.body.columnId, request.body.mode, key,
        null, request.body.find ?? '', request.body.replacement ?? '', request.body.dateFormat ?? 'yyyy-MM-dd')
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; plan: CleanPlan } }>('/api/v1/clean-plans', {
      schema: { body: { type: 'object', required: ['sourceId', 'plan'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, plan: { type: 'object', required: ['steps'],
          properties: { steps: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object' } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitCleanPlan(who(request.identity), request.body.sourceId, request.body.plan, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; plan: CleanPlan } }>('/api/v1/clean-plans/preview', {
      schema: { body: { type: 'object', required: ['sourceId', 'plan'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, plan: { type: 'object', required: ['steps'],
          properties: { steps: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object' } } } } } } },
    }, async (request) => ({ requestId: request.id,
      preview: await service.previewCleanPlan(who(request.identity), request.body.sourceId, request.body.plan) }))

    app.post<{ Body: { sourceId: string; format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'; safeText: boolean;
      textOptions?: TextExportOptions; jsonOptions?: JsonExportOptions; workbook?: { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number }; scope?: ExportScope } }>('/api/v1/exports/preflight', {
      schema: { body: { type: 'object', required: ['sourceId', 'format', 'safeText'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, format: { type: 'string', enum: ['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet'] },
          safeText: { type: 'boolean' }, textOptions: { type: 'object', required: ['encoding', 'delimiter', 'quote', 'newline', 'bom'],
            additionalProperties: false, properties: { encoding: { type: 'string', enum: ['utf-8','utf-16le','utf-16be','gb18030'] },
              delimiter: { type: 'string', enum: [',',';','\t','|'] }, quote: { type: 'string', enum: ['"', "'"] },
              newline: { type: 'string', enum: ['lf','crlf'] }, bom: { type: 'boolean' } } },
          jsonOptions: { type: 'object', required: ['emptyAsNull','types'], additionalProperties: false,
            properties: { emptyAsNull: { type: 'boolean' }, types: { type: 'object', maxProperties: 1024,
              additionalProperties: { type: 'string', enum: ['text','integer','decimal','boolean','date'] } } } },
          workbook: { type: 'object', required: ['sourceIds', 'sheetNames'], additionalProperties: false,
            properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', maxLength: 80 } },
              sheetNames: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 31 } },
              rowsPerSheet: { type: 'integer', minimum: 1, maximum: 1048575 } } },
          scope: { type: 'object', required: ['startRow', 'endRow', 'columnIds'], additionalProperties: false,
            properties: { startRow: { type: 'integer', minimum: 1 }, endRow: { type: 'integer', minimum: 1 },
              columnIds: { type: 'array', minItems: 1, maxItems: 4096, uniqueItems: true, items: { type: 'string', maxLength: 32 } } } } } } },
    }, async (request) => ({ requestId: request.id, preflight: await service.preflightExport(who(request.identity), request.body.sourceId,
      request.body.format, request.body.safeText, request.body.textOptions, request.body.jsonOptions, request.body.workbook, request.body.scope) }))

    app.post<{ Body: { sourceId: string; format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'; safeText: boolean;
      textOptions?: TextExportOptions; jsonOptions?: JsonExportOptions; workbook?: { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number }; scope?: ExportScope; outputName?: string } }>('/api/v1/exports', {
      schema: { body: { type: 'object', required: ['sourceId', 'format', 'safeText'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, format: { type: 'string', enum: ['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet'] }, safeText: { type: 'boolean' },
          outputName: { type: 'string', minLength: 1, maxLength: 120 },
          textOptions: { type: 'object', required: ['encoding', 'delimiter', 'quote', 'newline', 'bom'], additionalProperties: false,
            properties: { encoding: { type: 'string', enum: ['utf-8','utf-16le','utf-16be','gb18030'] }, delimiter: { type: 'string', enum: [',',';','\t','|'] },
              quote: { type: 'string', enum: ['"', "'"] }, newline: { type: 'string', enum: ['lf','crlf'] }, bom: { type: 'boolean' } } },
          jsonOptions: { type: 'object', required: ['emptyAsNull','types'], additionalProperties: false,
            properties: { emptyAsNull: { type: 'boolean' }, types: { type: 'object', maxProperties: 1024,
              additionalProperties: { type: 'string', enum: ['text','integer','decimal','boolean','date'] } } } },
          workbook: { type: 'object', required: ['sourceIds', 'sheetNames'], additionalProperties: false,
            properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', maxLength: 80 } },
              sheetNames: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 31 } },
              rowsPerSheet: { type: 'integer', minimum: 1, maximum: 1048575 } } },
          scope: { type: 'object', required: ['startRow', 'endRow', 'columnIds'], additionalProperties: false,
            properties: { startRow: { type: 'integer', minimum: 1 }, endRow: { type: 'integer', minimum: 1 },
              columnIds: { type: 'array', minItems: 1, maxItems: 4096, uniqueItems: true, items: { type: 'string', maxLength: 32 } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitExport(who(request.identity), request.body.sourceId, request.body.format, request.body.safeText, key,
        null, false, request.body.textOptions, request.body.jsonOptions, request.body.workbook, request.body.scope, request.body.outputName)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceIds: string[]; config: RelationConfig } }>('/api/v1/relations/preflight', {
      schema: { body: { type: 'object', required: ['sourceIds', 'config'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 2, maxItems: 2, uniqueItems: true, items: { type: 'string', maxLength: 80 } },
          config: { type: 'object', required: ['kind', 'cardinality', 'leftKeyIds', 'rightKeyIds'], additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['inner', 'left', 'right', 'full', 'left-semi', 'left-anti'] },
              cardinality: { type: 'string', enum: ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] },
              leftKeyIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 32 } },
              rightKeyIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', maxLength: 32 } },
              keyType: { type: 'string', enum: ['text', 'decimal'] }, matchEmptyKeys: { type: 'boolean' }, trimKeys: { type: 'boolean' },
              ignoreCase: { type: 'boolean' }, unicodeNormalization: { type: 'string', enum: ['none', 'nfc', 'nfkc'] },
              output: { type: 'object', required: ['columns', 'leftSuffix', 'rightSuffix', 'includeSourceRows'], additionalProperties: false,
                properties: { columns: { type: 'array', minItems: 1, maxItems: 8192, items: { type: 'object', required: ['side', 'id'],
                  additionalProperties: false, properties: { side: { type: 'string', enum: ['left', 'right'] }, id: { type: 'string', pattern: '^c_[0-9]+$' } } } },
                  leftSuffix: { type: 'string', maxLength: 32 }, rightSuffix: { type: 'string', maxLength: 32 },
                  includeSourceRows: { type: 'boolean' } } } } } } } },
    }, async (request) => ({ requestId: request.id,
      preflight: await service.previewRelation(who(request.identity), request.body.sourceIds, request.body.config) }))

    app.post<{ Body: { sourceIds: string[]; mode: 'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error' | 'relation' | 'set'; relationConfig?: RelationConfig; setConfig?: SetConfig } }>('/api/v1/combines', {
      schema: { body: { type: 'object', required: ['sourceIds', 'mode'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 2, maxItems: 20, uniqueItems: true,
          items: { type: 'string', maxLength: 80 } }, mode: { type: 'string', enum: ['strict', 'union', 'intersection', 'horizontal-pad', 'horizontal-error', 'relation', 'set'] },
          relationConfig: { type: 'object', required: ['kind', 'leftKeyIds', 'rightKeyIds', 'cardinality'], additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['inner', 'left', 'right', 'full', 'left-semi', 'left-anti'] },
              leftKeyIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } },
              rightKeyIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } },
              cardinality: { type: 'string', enum: ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] },
              keyType: { type: 'string', enum: ['text', 'decimal'] }, matchEmptyKeys: { type: 'boolean' }, trimKeys: { type: 'boolean' },
              ignoreCase: { type: 'boolean' }, unicodeNormalization: { type: 'string', enum: ['none', 'nfc', 'nfkc'] },
              output: { type: 'object', required: ['columns', 'leftSuffix', 'rightSuffix', 'includeSourceRows'], additionalProperties: false,
                properties: { columns: { type: 'array', minItems: 1, maxItems: 8192, items: { type: 'object', required: ['side', 'id'],
                  additionalProperties: false, properties: { side: { type: 'string', enum: ['left', 'right'] }, id: { type: 'string', pattern: '^c_[0-9]+$' } } } },
                  leftSuffix: { type: 'string', maxLength: 32 }, rightSuffix: { type: 'string', maxLength: 32 },
                  includeSourceRows: { type: 'boolean' } } } } },
          setConfig: { type: 'object', required: ['kind', 'leftKeyIds', 'rightKeyIds'], additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['intersection', 'left-difference', 'right-difference', 'union'] },
              leftKeyIds: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } },
              rightKeyIds: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitCombine(who(request.identity), request.body.sourceIds, request.body.mode, key, null, request.body.relationConfig, request.body.setConfig)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; config: ReshapeConfig } }>('/api/v1/reshapes', {
      schema: { body: { type: 'object', required: ['sourceId', 'config'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, config: { type: 'object', required: ['kind'],
          properties: { kind: { type: 'string', enum: ['split-column', 'group-join', 'transpose'] },
            columnId: { type: 'string', pattern: '^c_[0-9]+$' }, delimiter: { type: 'string', maxLength: 16 },
            direction: { type: 'string', enum: ['columns', 'rows'] }, maxParts: { type: 'integer', minimum: 2, maximum: 32 },
            keepEmpty: { type: 'boolean' }, overflow: { type: 'string', enum: ['error', 'join-last'] },
            keyIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } },
            valueId: { type: 'string', pattern: '^c_[0-9]+$' }, separator: { type: 'string', maxLength: 16 } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitCombine(who(request.identity), [request.body.sourceId], 'reshape', key,
        null, undefined, undefined, request.body.config)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; columnIds: string[] } }>('/api/v1/dedupes', {
      schema: { body: { type: 'object', required: ['sourceId', 'columnIds'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, columnIds: { type: 'array', minItems: 1, maxItems: 16,
          uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitDedupe(who(request.identity), request.body.sourceId, request.body.columnIds, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { leftId: string; rightId: string; config: CompareConfig } }>('/api/v1/compares/preflights', {
      schema: { body: { type: 'object', required: ['leftId', 'rightId', 'config'], additionalProperties: false,
        properties: { leftId: { type: 'string', maxLength: 80 }, rightId: { type: 'string', maxLength: 80 },
          config: { type: 'object' } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitComparePreflight(who(request.identity), request.body.leftId, request.body.rightId, request.body.config, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.post<{ Body: { leftId: string; rightId: string; config: CompareConfig; preflightJobId: string } }>('/api/v1/compares', {
      schema: { body: { type: 'object', required: ['leftId', 'rightId', 'config', 'preflightJobId'], additionalProperties: false,
        properties: { leftId: { type: 'string', maxLength: 80 }, rightId: { type: 'string', maxLength: 80 },
          preflightJobId: { type: 'string', pattern: '^job_[0-9a-f-]{36}$' },
          config: { type: 'object', required: ['leftKeyIds', 'rightKeyIds', 'fields', 'trimKeys', 'ignoreKeyCase'], additionalProperties: false,
            properties: {
              leftKeyIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } },
              rightKeyIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } },
              fields: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', required: ['leftColumnId', 'rightColumnId', 'mode'], additionalProperties: false,
                properties: { leftColumnId: { type: 'string', pattern: '^c_[0-9]+$' }, rightColumnId: { type: 'string', pattern: '^c_[0-9]+$' },
                  mode: { type: 'string', enum: ['text', 'decimal', 'calendar-date', 'instant'] },
                  tolerance: { type: 'string', maxLength: 40 }, relativeTolerance: { type: 'string', maxLength: 40 },
                  textTrim: { type: 'boolean' }, textIgnoreCase: { type: 'boolean' }, unicode: { type: 'string', enum: ['none', 'NFC', 'NFKC'] },
                  dayTolerance: { type: 'integer', minimum: 0, maximum: 365 },
                  timeToleranceSeconds: { type: 'integer', minimum: 0, maximum: 604800 } } } },
              trimKeys: { type: 'boolean' }, ignoreKeyCase: { type: 'boolean' },
              leftLabel: { type: 'string', maxLength: 120 }, rightLabel: { type: 'string', maxLength: 120 },
              duplicatePolicy: { type: 'string', enum: ['isolate', 'abort', 'aggregate'] },
              aggregateMethods: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', enum: ['sum', 'count'] } },
              emptyValuePolicy: { type: 'string', enum: ['mode-default', 'match-both', 'error'] },
              parseFailurePolicy: { type: 'string', enum: ['isolate', 'abort'] },
              contextLeftIds: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^c_[0-9]+$' } },
              contextRightIds: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^c_[0-9]+$' } },
            } },
        } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitCompare(who(request.identity), request.body.leftId, request.body.rightId, request.body.config, key,
        null, request.body.preflightJobId)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.get<{ Params: { id: string }; Querystring: { category?: string; key?: string; field?: string;
      fieldState?: string; value?: string; differenceMin?: string; differenceMax?: string;
      sourceRow?: string; annotationStatus?: string; offset?: string; limit?: string } }>('/api/v1/compare-results/:id/find', async (request) => {
      const { offset, limit } = pageRange(request.query)
      const result = await service.findCompareDetails(who(request.identity), request.params.id, {
        category: request.query.category, key: request.query.key, field: request.query.field,
        fieldState: request.query.fieldState, value: request.query.value,
        differenceMin: request.query.differenceMin, differenceMax: request.query.differenceMax,
        annotationStatus: request.query.annotationStatus,
        sourceRow: request.query.sourceRow === undefined ? undefined : Number(request.query.sourceRow),
      }, offset, limit)
      return { requestId: request.id, ...result }
    })
    app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>('/api/v1/compare-results/:id/annotations', async (request) => {
      const { offset, limit } = pageRange(request.query)
      return { requestId: request.id, ...service.listCompareAnnotations(who(request.identity), request.params.id, offset, limit) }
    })
    app.put<{ Params: { id: string }; Body: { edits: { detailRow: number; status: 'pending' | 'verified' | 'ignored' | null;
      note: string; expectedUpdatedAt: number | null }[] } }>('/api/v1/compare-results/:id/annotations', {
      schema: { body: { type: 'object', required: ['edits'], additionalProperties: false,
        properties: { edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object',
          required: ['detailRow', 'status', 'note', 'expectedUpdatedAt'], additionalProperties: false,
          properties: { detailRow: { type: 'integer', minimum: 1 }, status: { type: ['string', 'null'], enum: ['pending', 'verified', 'ignored', null] },
            note: { type: 'string', maxLength: 1000 }, expectedUpdatedAt: { type: ['integer', 'null'], minimum: 0 } } } } } } },
    }, async (request) => ({ requestId: request.id,
      ...service.setCompareAnnotations(who(request.identity), request.params.id, request.body.edits) }))
    app.post<{ Params: { id: string }; Body: { format: 'zip' | 'xlsx' } }>('/api/v1/compare-results/:id/reports', {
      schema: { body: { type: 'object', required: ['format'], additionalProperties: false,
        properties: { format: { type: 'string', enum: ['zip', 'xlsx'] } } } },
    }, async (request, reply) => {
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitExport(who(request.identity), request.params.id, request.body.format, true, key, null, true)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    const sqlParametersSchema = { type: 'object', required: ['definitions', 'values'], additionalProperties: false,
      properties: { definitions: { type: 'array', maxItems: 16, items: { type: 'object', required: ['name', 'type'], additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 32 }, type: { type: 'string', enum: ['text', 'integer', 'decimal', 'date'] } } } },
      values: { type: 'object', maxProperties: 16, additionalProperties: { type: 'string', maxLength: 1024 } } } }
    app.post<{ Body: { sourceIds: string[]; sql: string; parameters?: SqlParameters } }>('/api/v1/sql-queries/preview', {
      schema: { body: { type: 'object', required: ['sourceIds', 'sql'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true,
          items: { type: 'string', maxLength: 80 } }, sql: { type: 'string', minLength: 1, maxLength: 8192 }, parameters: sqlParametersSchema } } },
    }, async (request) => ({ requestId: request.id,
      preview: await service.previewSql(who(request.identity), request.body.sourceIds, request.body.sql, request.body.parameters) }))
    app.post<{ Body: { sourceIds: string[]; sql: string; parameters?: SqlParameters } }>('/api/v1/sql-queries', {
      schema: { body: { type: 'object', required: ['sourceIds', 'sql'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true,
          items: { type: 'string', maxLength: 80 } }, sql: { type: 'string', minLength: 1, maxLength: 8192 }, parameters: sqlParametersSchema } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitSql(who(request.identity), request.body.sourceIds, request.body.sql, key, null, request.body.parameters)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string } }>('/api/v1/analyses', {
      schema: { body: { type: 'object', required: ['sourceId'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitAnalyze(who(request.identity), request.body.sourceId, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.post<{ Body: { sourceId: string; columnId: string } }>('/api/v1/analyses/frequencies', {
      schema: { body: { type: 'object', required: ['sourceId', 'columnId'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, columnId: { type: 'string', pattern: '^c_[0-9]+$' } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitFrequencyAnalyze(who(request.identity), request.body.sourceId, request.body.columnId, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.post<{ Body: { sourceId: string; aggregate: AggregateConfig } }>('/api/v1/analyses/groups', {
      schema: { body: { type: 'object', required: ['sourceId', 'aggregate'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, aggregate: { type: 'object', required: ['groupColumnIds', 'measures'], additionalProperties: false,
          properties: { groupColumnIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true,
            items: { type: 'string', pattern: '^c_[0-9]+$' } }, measures: { type: 'array', minItems: 1, maxItems: 8,
            items: { type: 'object', required: ['operation', 'name'], additionalProperties: false,
              properties: { operation: { type: 'string', enum: ['count', 'sum', 'min', 'max', 'avg'] },
                columnId: { type: 'string', pattern: '^c_[0-9]+$' }, name: { type: 'string', minLength: 1, maxLength: 120 },
                precision: { type: 'integer', minimum: 0, maximum: 18 } } } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitGroupAnalyze(who(request.identity), request.body.sourceId, request.body.aggregate, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.post<{ Body: { sourceId: string; pivot: PivotConfig } }>('/api/v1/analyses/pivots', {
      schema: { body: { type: 'object', required: ['sourceId', 'pivot'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, pivot: { type: 'object', required: ['rowColumnId', 'pivotColumnId', 'measure'], additionalProperties: false,
          properties: { rowColumnId: { type: 'string', pattern: '^c_[0-9]+$' }, pivotColumnId: { type: 'string', pattern: '^c_[0-9]+$' },
            measure: { type: 'object', required: ['operation', 'name'], additionalProperties: false,
              properties: { operation: { type: 'string', enum: ['count', 'sum', 'min', 'max', 'avg'] },
                columnId: { type: 'string', pattern: '^c_[0-9]+$' }, name: { type: 'string', minLength: 1, maxLength: 120 },
                precision: { type: 'integer', minimum: 0, maximum: 18 } } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitPivotAnalyze(who(request.identity), request.body.sourceId, request.body.pivot, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { sourceId: string; rules: QualityRule[] } }>('/api/v1/quality-checks/preview', async (request) => ({
      requestId: request.id, preview: await service.previewQuality(who(request.identity), request.body.sourceId, request.body.rules),
    }))
    app.post<{ Body: { sourceId: string; rules: QualityRule[]; outputMode?: QualityOutputMode } }>('/api/v1/quality-checks', {
      schema: { body: { type: 'object', required: ['sourceId', 'rules'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, outputMode: { type: 'string', enum: ['report', 'valid', 'invalid'] }, rules: { type: 'array', minItems: 1, maxItems: 32,
          items: { type: 'object', required: ['kind'], additionalProperties: false,
            properties: { kind: { type: 'string', enum: ['required', 'length', 'enum', 'type', 'range', 'date-order', 'unique', 'pattern', 'arithmetic', 'reference'] }, columnId: { type: 'string', pattern: '^c_[0-9]+$' },
              min: { type: ['integer', 'string'] }, max: { type: ['integer', 'string'] },
              values: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 512 } },
              dataType: { type: 'string', enum: ['integer', 'decimal', 'date'] }, otherColumnId: { type: 'string', pattern: '^c_[0-9]+$' },
              pattern: { type: 'string', maxLength: 160 }, leftColumnId: { type: 'string', pattern: '^c_[0-9]+$' },
              rightColumnId: { type: 'string', pattern: '^c_[0-9]+$' }, tolerance: { type: 'string', maxLength: 80 },
              referenceId: { type: 'string', maxLength: 80 }, referenceColumnId: { type: 'string', pattern: '^c_[0-9]+$' },
              columnIds: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^c_[0-9]+$' } } } } } } } },
    }, async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitQuality(who(request.identity), request.body.sourceId, request.body.rules, key, null, request.body.outputMode)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.post<{ Body: { sourceId: string; config: SplitConfig } }>('/api/v1/splits/preflight', {
      schema: { body: { type: 'object', required: ['sourceId', 'config'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, config: { type: 'object', required: ['mode'], additionalProperties: false,
          properties: { mode: { type: 'string', enum: ['rows', 'value'] }, size: { type: 'integer', minimum: 1, maximum: 100000000 },
            columnId: { type: 'string', pattern: '^c_[0-9]+$' }, includeHeader: { type: 'boolean' } } } } } },
    }, async (request) => ({ requestId: request.id, preflight: await service.preflightSplit(who(request.identity), request.body.sourceId, request.body.config) }))
    app.post<{ Body: { sourceId: string; config: SplitConfig } }>('/api/v1/splits', {
      schema: { body: { type: 'object', required: ['sourceId', 'config'], additionalProperties: false,
        properties: { sourceId: { type: 'string', maxLength: 80 }, config: { type: 'object', required: ['mode'], additionalProperties: false,
          properties: { mode: { type: 'string', enum: ['rows', 'value'] }, size: { type: 'integer', minimum: 1, maximum: 100000000 },
            columnId: { type: 'string', pattern: '^c_[0-9]+$' }, includeHeader: { type: 'boolean' } } } } } },
    }, async (request, reply) => {
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitSplit(who(request.identity), request.body.sourceId, request.body.config, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.get('/api/v1/recipes', async (request) => ({ requestId: request.id, ...service.listRecipes(who(request.identity)) }))
    app.post<{ Body: { jobId: string; name: string; description: string; includeHistory?: boolean } }>('/api/v1/recipes/from-job', {
      schema: { body: { type: 'object', required: ['jobId', 'name', 'description'], additionalProperties: false,
        properties: { jobId: { type: 'string', maxLength: 80 }, name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 1000 }, includeHistory: { type: 'boolean' } } } },
    }, async (request, reply) => {
      const recipe = service.createRecipeFromJob(who(request.identity), request.body.jobId, request.body.name, request.body.description, request.body.includeHistory ?? false)
      reply.code(201)
      return { requestId: request.id, recipe }
    })
    app.post<{ Body: { format: 'qsv-recipe-v1'; name: string; description: string; spec: unknown } }>('/api/v1/recipes/import', {
      schema: { body: { type: 'object', required: ['format', 'name', 'description', 'spec'], additionalProperties: false,
        properties: { format: { const: 'qsv-recipe-v1' }, name: { type: 'string', minLength: 1, maxLength: 120 },
          description: { type: 'string', maxLength: 1000 }, spec: { type: 'object' } } } },
    }, async (request, reply) => {
      const recipe = service.importRecipe(who(request.identity), request.body.name, request.body.description, request.body.spec)
      reply.code(201)
      return { requestId: request.id, recipe }
    })
    app.get<{ Params: { id: string } }>('/api/v1/recipes/:id', async (request) =>
      ({ requestId: request.id, recipe: service.getRecipe(who(request.identity), request.params.id) }))
    app.get<{ Params: { id: string } }>('/api/v1/recipes/:id/versions', async (request) =>
      ({ requestId: request.id, ...service.listRecipeVersions(who(request.identity), request.params.id) }))
    app.post<{ Params: { id: string }; Body: { sourceIds: string[]; parameterValues?: Record<string, string> } }>('/api/v1/recipes/:id/preflight', {
      schema: { body: { type: 'object', required: ['sourceIds'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 80 } },
          parameterValues: { type: 'object', maxProperties: 16, additionalProperties: { type: 'string', maxLength: 1024 } } } } },
    }, async (request) => ({ requestId: request.id, preflight: service.preflightRecipe(who(request.identity), request.params.id,
      request.body.sourceIds, request.body.parameterValues) }))
    app.post<{ Params: { id: string }; Body: { sourceIds: string[]; parameterValues?: Record<string, string> } }>('/api/v1/recipes/:id/trial', {
      schema: { body: { type: 'object', required: ['sourceIds'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 80 } },
          parameterValues: { type: 'object', maxProperties: 16, additionalProperties: { type: 'string', maxLength: 1024 } } } } },
    }, async (request) => ({ requestId: request.id, trial: await service.trialRecipe(who(request.identity), request.params.id,
      request.body.sourceIds, request.body.parameterValues) }))
    app.patch<{ Params: { id: string }; Body: { name: string; description: string; expectedUpdatedAt: number; spec?: unknown } }>('/api/v1/recipes/:id', {
      schema: { body: { type: 'object', required: ['name', 'description', 'expectedUpdatedAt'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: 'string', maxLength: 1000 },
          expectedUpdatedAt: { type: 'integer', minimum: 0 }, spec: { type: 'object' } } } },
    }, async (request) => ({ requestId: request.id, recipe: service.versionRecipe(who(request.identity), request.params.id,
      request.body.name, request.body.description, request.body.expectedUpdatedAt, request.body.spec) }))
    app.post<{ Params: { id: string }; Body: { name: string } }>('/api/v1/recipes/:id/copy', {
      schema: { body: { type: 'object', required: ['name'], additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } } },
    }, async (request, reply) => {
      const recipe = service.copyRecipe(who(request.identity), request.params.id, request.body.name)
      reply.code(201)
      return { requestId: request.id, recipe }
    })
    app.delete<{ Params: { id: string }; Body: { expectedUpdatedAt: number } }>('/api/v1/recipes/:id', {
      schema: { body: { type: 'object', required: ['expectedUpdatedAt'], additionalProperties: false,
        properties: { expectedUpdatedAt: { type: 'integer', minimum: 0 } } } },
    }, async (request) => {
      service.deleteRecipe(who(request.identity), request.params.id, request.body.expectedUpdatedAt)
      return { requestId: request.id, deleted: true }
    })
    app.post<{ Params: { id: string }; Body: { groups: string[][]; parameterValues?: Record<string, string> } }>('/api/v1/recipes/:id/batches', {
      schema: { body: { type: 'object', required: ['groups'], additionalProperties: false,
        properties: { groups: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'array', minItems: 1, maxItems: 20,
          items: { type: 'string', maxLength: 80 } } }, parameterValues: { type: 'object', maxProperties: 16,
          additionalProperties: { type: 'string', maxLength: 1024 } } } } },
    }, async (request, reply) => {
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.submitRecipeBatch(who(request.identity), request.params.id, request.body.groups, key,
        request.body.parameterValues)
      reply.code(202)
      return { requestId: request.id, ...result }
    })
    app.get<{ Params: { id: string } }>('/api/v1/recipe-batches/:id', async (request) =>
      ({ requestId: request.id, ...service.getRecipeBatch(who(request.identity), request.params.id) }))
    app.post<{ Params: { id: string; index: string }; Body: { sourceIds: string[] } }>('/api/v1/recipe-batches/:id/groups/:index/retry', {
      schema: { body: { type: 'object', required: ['sourceIds'], additionalProperties: false,
        properties: { sourceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 80 } } } } },
    }, async (request, reply) => {
      const index = Number(request.params.index)
      if (!Number.isSafeInteger(index) || index < 0 || index >= 20) throw new ServiceError(400, 'INVALID_BATCH_GROUP', '分组编号无效')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const result = service.retryRecipeBatchGroup(who(request.identity), request.params.id, index, request.body.sourceIds, key)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.get<{ Querystring: { offset?: string; limit?: string; cursor?: string } }>('/api/v1/jobs', async (request) => {
      const { offset, limit } = pageRange(request.query)
      return { requestId: request.id, ...(request.query.cursor === undefined
        ? service.listJobs(who(request.identity), offset, limit)
        : service.listJobsAfter(who(request.identity), request.query.cursor, limit)) }
    })
    app.get<{ Querystring: { offset?: string; limit?: string; name?: string; kind?: string; state?: string; inputId?: string; from?: string; to?: string } }>('/api/v1/jobs/find', async (request) => {
      const { offset, limit } = pageRange(request.query)
      return { requestId: request.id, ...service.findJobs(who(request.identity), {
        name: request.query.name, kind: request.query.kind, state: request.query.state, inputId: request.query.inputId,
        from: request.query.from === undefined ? undefined : Number(request.query.from),
        to: request.query.to === undefined ? undefined : Number(request.query.to),
      }, offset, limit) }
    })
    app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (request) => ({ requestId: request.id, job: service.getJob(who(request.identity), request.params.id) }))
    app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/cancel', async (request) => ({ requestId: request.id, job: service.cancelJob(who(request.identity), request.params.id) }))
    app.post<{ Params: { id: string } }>('/api/v1/jobs/:id/retry', async (request, reply) => {
      const job = service.getJob(who(request.identity), request.params.id)
      if (!['import', 'filter', 'clean', 'edit', 'export', 'combine', 'dedup', 'compare', 'sql', 'analyze', 'quality', 'split'].includes(job.kind)) throw new ServiceError(422, 'RETRY_UNSUPPORTED', '该任务尚不支持重试')
      if (!['failed', 'interrupted', 'cancelled'].includes(job.state)) throw new ServiceError(409, 'RETRY_NOT_ALLOWED', '该任务当前不能重试')
      if (job.error?.retryable === false) throw new ServiceError(422, 'RETRY_NOT_ALLOWED', '原文件需要修正后重新导入')
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string') throw new ServiceError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少幂等键')
      const rawId = job.inputIds[0]
      if (!rawId) throw new ServiceError(422, 'INVALID_JOB', '原任务缺少输入')
      const originalSpec = job.spec as { operation?: string; sourceHash?: string; patches?: CellPatch[]; csv?: CsvImportOptions; json?: JsonImportOptions; columnTypes?: Record<string, ColumnType>; sheetName?: string | null; columnId?: string; columnIds?: string[]; mode?: string; value?: string; find?: string; replacement?: string; dateFormat?: 'yyyy-MM-dd' | 'yyyy/MM/yyyy' | 'dd/MM/yyyy' | 'MM/dd/yyyy'; format?: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet' | 'zip'; safeText?: boolean; report?: boolean; textOptions?: TextExportOptions; jsonOptions?: JsonExportOptions; workbook?: { sourceIds: string[]; sheetNames: string[]; rowsPerSheet?: number }; scope?: ExportScope; outputName?: string; config?: CompareConfig | SplitConfig; sql?: string; parameters?: SqlParameters; rules?: QualityRule[]; plan?: ViewPlan | CleanPlan; aggregate?: AggregateConfig; pivot?: PivotConfig; frequencyColumnId?: string; relationConfig?: RelationConfig; setConfig?: SetConfig; reshapeConfig?: ReshapeConfig; outputMode?: QualityOutputMode }
      const result = job.kind === 'filter'
        ? originalSpec.plan ? service.submitFilterPlan(who(request.identity), rawId, originalSpec.plan as ViewPlan, key, job.id)
          : service.submitFilter(who(request.identity), rawId, originalSpec.columnId ?? '', originalSpec.mode as 'equals' | 'contains', originalSpec.value ?? '', key, job.id)
        : job.kind === 'clean'
          ? originalSpec.operation === 'clean.plan' && originalSpec.plan
            ? service.submitCleanPlan(who(request.identity), rawId, originalSpec.plan as CleanPlan, key, job.id)
            : service.submitClean(who(request.identity), rawId, originalSpec.columnId ?? '', originalSpec.mode as 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'replace' | 'fill-empty' | 'nfc' | 'nfkc' | 'date-iso', key, job.id, originalSpec.find ?? '', originalSpec.replacement ?? '', (originalSpec.dateFormat ?? 'yyyy-MM-dd') as DateInputFormat)
          : job.kind === 'edit'
            ? service.submitCellEdits(who(request.identity), rawId, originalSpec.sourceHash ?? '', originalSpec.patches ?? [], key, job.id)
          : job.kind === 'export'
            ? service.submitExport(who(request.identity), rawId, originalSpec.format as 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet' | 'zip', Boolean(originalSpec.safeText), key, job.id, Boolean(originalSpec.report), originalSpec.textOptions, originalSpec.jsonOptions, originalSpec.workbook, originalSpec.scope, originalSpec.outputName)
            : job.kind === 'dedup'
              ? service.submitDedupe(who(request.identity), rawId, originalSpec.columnIds ?? [], key, job.id)
            : job.kind === 'compare'
              ? service.submitCompare(who(request.identity), rawId, job.inputIds[1] ?? '', originalSpec.config as CompareConfig, key, job.id)
            : job.kind === 'split'
              ? service.submitSplit(who(request.identity), rawId, originalSpec.config as SplitConfig, key, job.id)
            : job.kind === 'sql'
              ? service.submitSql(who(request.identity), job.inputIds, originalSpec.sql ?? '', key, job.id, originalSpec.parameters)
            : job.kind === 'analyze'
              ? service.submitAnalyze(who(request.identity), rawId, key, job.id, originalSpec.aggregate, originalSpec.pivot,
                originalSpec.frequencyColumnId)
            : job.kind === 'quality'
              ? service.submitQuality(who(request.identity), rawId, originalSpec.rules ?? [], key, job.id, originalSpec.outputMode)
            : job.kind === 'combine'
              ? service.submitCombine(who(request.identity), job.inputIds, originalSpec.mode as 'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error' | 'relation' | 'set' | 'reshape', key, job.id, originalSpec.relationConfig, originalSpec.setConfig, originalSpec.reshapeConfig)
              : service.submitImport(who(request.identity), rawId, key, job.id, originalSpec.csv, originalSpec.sheetName ?? undefined,
                originalSpec.json, originalSpec.columnTypes)
      reply.code(202)
      return { requestId: request.id, ...result }
    })

    app.post<{ Body: { resourceId: string } }>('/api/v1/views', {
      schema: { body: { type: 'object', required: ['resourceId'], additionalProperties: false, properties: {
        resourceId: { type: 'string', maxLength: 80 },
      } } },
    }, async (request) => {
      return { requestId: request.id, view: await service.createView(who(request.identity), request.body.resourceId) }
    })
    app.get<{ Params: { id: string }; Querystring: { offset?: string; limit?: string } }>('/api/v1/views/:id/rows', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const abort = new AbortController()
      const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
      reply.raw.once('close', onClose)
      try {
        return { requestId: request.id, block: await service.rows(who(request.identity), request.params.id, Number(request.query.offset ?? 0), Number(request.query.limit ?? 128), abort.signal) }
      } finally { reply.raw.off('close', onClose) }
    })
    app.get<{ Params: { id: string; rowIndex: string; columnId: string } }>('/api/v1/views/:id/cells/:rowIndex/:columnId', async (request, reply) => {
      if (!probe.verified) throw new ServiceError(503, 'ENGINE_UNAVAILABLE', 'qsv 引擎尚不可用')
      const abort = new AbortController()
      const onClose = () => { if (!reply.raw.writableEnded) abort.abort() }
      reply.raw.once('close', onClose)
      try {
        return { requestId: request.id, cell: await service.cell(who(request.identity), request.params.id, Number(request.params.rowIndex), request.params.columnId, abort.signal) }
      } finally { reply.raw.off('close', onClose) }
    })

  }

  app.setNotFoundHandler(async (request, reply) => {
    if (options.webDist && request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/auth/')) {
      let pathname: string
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) }
      catch { return reply.code(400).send('路径无效') }
      if (pathname.includes('\0') || pathname.split('/').includes('..') || pathname.split('/').some((part) => part.startsWith('.'))) {
        return reply.code(404).send('文件不存在')
      }
      const base = resolve(options.webDist)
      const requested = resolve(base, pathname.slice(1))
      if (requested !== base && !requested.startsWith(`${base}${sep}`)) return reply.code(404).send('文件不存在')
      let file = requested
      let info = await stat(file).catch(() => null)
      if (!info?.isFile() && !pathname.includes('.', pathname.lastIndexOf('/') + 1)) {
        file = resolve(base, 'index.html')
        info = await stat(file).catch(() => null)
      }
      if (info?.isFile()) {
        const ext = file.slice(file.lastIndexOf('.') + 1)
        const mime: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
          svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', ico: 'image/x-icon', woff2: 'font/woff2', json: 'application/json' }
        reply.type(mime[ext] ?? 'application/octet-stream')
        reply.header('Cache-Control', ext === 'html' ? 'no-store' : 'public, max-age=31536000, immutable')
        return reply.send(createReadStream(file))
      }
    }
    reply.code(404)
    return { requestId: request.id, error: { code: 'NOT_FOUND', message: '接口不存在' } }
  })

  return app
}
