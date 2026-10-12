import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import type { Identity } from './identity.ts'
import type { AuthProvider } from './oidc-auth.ts'

/**
 * 仅供测试使用的 AuthProvider 替身。
 *
 * 生产环境只通过 OidcAuth 的 OIDC 会话认定身份；`main.ts` 永远不会构造这个类，
 * 也不会读取任何请求头来认定用户。这里用请求头只是为了在单元测试里方便地
 * 模拟“不同用户”，不代表线上存在请求头旁路。
 */
export class StubAuth implements AuthProvider {
  private readonly identities = new Map<string, Identity>()
  private readonly header: string

  constructor(header = 'x-test-user-id') { this.header = header }

  identityFor(request: FastifyRequest): Identity | null {
    const raw = request.headers[this.header]
    const account = Array.isArray(raw) ? raw[0] : raw
    if (!account) return null
    const existing = this.identities.get(account)
    if (existing) return existing
    const ownerKey = createHash('sha256').update(`qsv-web:test:${account}`).digest('hex')
    const roleRaw = request.headers['x-test-user-role']
    const role = (Array.isArray(roleRaw) ? roleRaw[0] : roleRaw) === 'ADMIN' ? 'admin' : 'normal'
    const identity: Identity = { ownerKey, workspaceId: ownerKey.slice(0, 24), displayName: account, source: 'lazycat', role }
    this.identities.set(account, identity)
    return identity
  }

  async login(reply: FastifyReply) { return reply.redirect('/') }
  async callback(_request: FastifyRequest, reply: FastifyReply) { return reply.redirect('/') }
  logout() { return { signedOut: true } }
}
