import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import * as oidc from 'openid-client'
import type { Identity } from './identity.ts'

const TRANSACTION_MS = 10 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const TX_COOKIE = 'qsv_oidc_tx'
const SESSION_COOKIE = 'qsv_session'

function cookie(request: FastifyRequest, key: string) {
  const raw = request.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === key) return rest.join('=')
  }
  return null
}

function setCookie(reply: FastifyReply, name: string, value: string, maxAge: number, secure: boolean) {
  const previous = reply.getHeader('Set-Cookie')
  const values = previous === undefined ? [] : Array.isArray(previous) ? previous.map(String) : [String(previous)]
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  reply.header('Set-Cookie', [...values, `${name}=${value}; ${flags}`])
}

function equal(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 仅回环地址允许 http issuer，便于本机用 stub 提供方跑通链路；其余一律要求 HTTPS。 */
function isLoopbackHttp(url: URL) {
  if (url.protocol !== 'http:') return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]'
}

type Transaction = { verifier: string; nonce: string; expires: number }
type Session = { identity: Identity; expires: number }

/**
 * 懒猫模式的登录入口契约。生产实现是 OidcAuth；测试可注入等价实现，
 * 但线上只有 OIDC 会话能产生身份，不存在请求头或其他旁路。
 */
export interface AuthProvider {
  identityFor(request: FastifyRequest): Identity | null
  login(reply: FastifyReply): Promise<unknown>
  callback(request: FastifyRequest, reply: FastifyReply): Promise<unknown>
  logout(request: FastifyRequest, reply: FastifyReply): { signedOut: boolean }
}

export class OidcAuth implements AuthProvider {
  private transactions = new Map<string, Transaction>()
  private sessions = new Map<string, Session>()
  private readonly config: oidc.Configuration
  private readonly issuer: string
  private readonly origin: string
  private readonly secure: boolean
  private constructor(config: oidc.Configuration, issuer: string, origin: string) {
    this.config = config
    this.issuer = issuer
    this.origin = origin
    this.secure = origin.startsWith('https://')
  }

  // discovery 阶段已把 allowInsecureRequests 应用到 Configuration，后续调用沿用该实例。

  static async create(environment: NodeJS.ProcessEnv) {
    const issuer = environment.QSV_OIDC_ISSUER
    const clientId = environment.QSV_OIDC_CLIENT_ID
    const clientSecret = environment.QSV_OIDC_CLIENT_SECRET
    // 应用自身来源优先取显式配置；懒猫部署由 manifest 注入应用域名。
    const explicitOrigin = environment.QSV_APP_ORIGIN
    const domain = environment.LAZYCAT_APP_DOMAIN
    if (!issuer || !clientId || !clientSecret) {
      throw new Error('懒猫 OIDC 配置不完整，拒绝启动多人模式')
    }
    const origin = explicitOrigin && explicitOrigin.trim()
      ? explicitOrigin.trim().replace(/\/+$/, '')
      : domain && /^[a-z0-9.-]+$/i.test(domain) ? `https://${domain}` : ''
    if (!origin) throw new Error('缺少应用来源：请设置 QSV_APP_ORIGIN 或懒猫应用域名')
    let originUrl: URL
    try { originUrl = new URL(origin) }
    catch { throw new Error('应用来源不是有效地址') }
    if (originUrl.protocol !== 'https:' && !isLoopbackHttp(originUrl)) {
      throw new Error('应用来源必须使用 HTTPS')
    }
    const issuerUrl = new URL(issuer)
    // 本机端到端验证需要回环 http 的 stub 提供方；生产一律 HTTPS。
    // 只有显式设置 QSV_OIDC_ALLOW_INSECURE=1 且 issuer 确实是回环地址时才放行。
    const allowInsecure = environment.QSV_OIDC_ALLOW_INSECURE === '1' && isLoopbackHttp(issuerUrl)
    if (issuerUrl.protocol === 'http:' && !allowInsecure) {
      throw new Error('OIDC issuer 必须使用 HTTPS（本机验证需显式设置 QSV_OIDC_ALLOW_INSECURE=1）')
    }
    const config = allowInsecure
      ? await oidc.discovery(issuerUrl, clientId, clientSecret, undefined, { execute: [oidc.allowInsecureRequests] })
      : await oidc.discovery(issuerUrl, clientId, clientSecret)
    oidc.enableNonRepudiationChecks(config)
    return new OidcAuth(config, config.serverMetadata().issuer, origin)
  }

  private prune() {
    const now = Date.now()
    for (const [key, value] of this.transactions) if (value.expires <= now) this.transactions.delete(key)
    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key)
  }

  identityFor(request: FastifyRequest): Identity | null {
    this.prune()
    const id = cookie(request, SESSION_COOKIE)
    if (!id || !/^[a-f0-9]{64}$/.test(id)) return null
    const session = this.sessions.get(id)
    return session && session.expires > Date.now() ? session.identity : null
  }

  async login(reply: FastifyReply) {
    this.prune()
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const verifier = oidc.randomPKCECodeVerifier()
    this.transactions.set(state, { nonce, verifier, expires: Date.now() + TRANSACTION_MS })
    const redirect = oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: `${this.origin}/auth/oidc/callback`, scope: 'openid profile email groups',
      response_type: 'code', state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    })
    setCookie(reply, TX_COOKIE, state, TRANSACTION_MS / 1000, this.secure)
    return reply.redirect(redirect.href)
  }

  async callback(request: FastifyRequest, reply: FastifyReply) {
    this.prune()
    const providedState = cookie(request, TX_COOKIE)
    const queryState = (request.query as { state?: string }).state
    if (!providedState || !queryState || !equal(providedState, queryState)) {
      return reply.redirect('/login?authError=state')
    }
    const transaction = this.transactions.get(queryState)
    this.transactions.delete(queryState)
    setCookie(reply, TX_COOKIE, '', 0, this.secure)
    if (!transaction || transaction.expires <= Date.now()) return reply.redirect('/login?authError=expired')
    let claims: { sub?: unknown; groups?: unknown; preferred_username?: unknown } | undefined
    let profile: { groups?: unknown; preferred_username?: unknown } | undefined
    try {
      const tokens = await oidc.authorizationCodeGrant(this.config,
        new URL(request.url, this.origin), {
          expectedState: queryState, expectedNonce: transaction.nonce,
          pkceCodeVerifier: transaction.verifier, idTokenExpected: true,
        })
      claims = tokens.claims() ?? undefined
      if (typeof claims?.sub === 'string') profile = await oidc.fetchUserInfo(this.config, tokens.access_token, claims.sub)
    } catch {
      return reply.redirect('/login?authError=failed')
    }
    if (!claims || typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 512) {
      return reply.redirect('/login?authError=identity')
    }
    const ownerKey = createHash('sha256').update(`qsv-web:oidc:${this.issuer}:${claims.sub}`).digest('hex')
    const groups = Array.isArray(profile?.groups) ? profile.groups : Array.isArray(claims.groups) ? claims.groups : []
    const identity: Identity = {
      ownerKey, workspaceId: ownerKey.slice(0, 24),
      displayName: typeof profile?.preferred_username === 'string' && profile.preferred_username ? profile.preferred_username.slice(0, 128) :
        typeof claims.preferred_username === 'string' && claims.preferred_username ? claims.preferred_username.slice(0, 128) : claims.sub.slice(0, 128),
      source: 'lazycat', role: groups.includes('ADMIN') ? 'admin' : 'normal',
    }
    const id = randomBytes(32).toString('hex')
    this.sessions.set(id, { identity, expires: Date.now() + SESSION_MS })
    setCookie(reply, SESSION_COOKIE, id, SESSION_MS / 1000, this.secure)
    return reply.redirect('/')
  }

  logout(request: FastifyRequest, reply: FastifyReply) {
    const id = cookie(request, SESSION_COOKIE)
    if (id) this.sessions.delete(id)
    setCookie(reply, SESSION_COOKIE, '', 0, this.secure)
    return { signedOut: true }
  }
}
