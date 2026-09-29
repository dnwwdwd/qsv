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

function setCookie(reply: FastifyReply, name: string, value: string, maxAge: number) {
  const previous = reply.getHeader('Set-Cookie')
  const values = previous === undefined ? [] : Array.isArray(previous) ? previous.map(String) : [String(previous)]
  reply.header('Set-Cookie', [...values, `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`])
}

function equal(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

type Transaction = { verifier: string; nonce: string; expires: number }
type Session = { identity: Identity; expires: number }

export class OidcAuth {
  private transactions = new Map<string, Transaction>()
  private sessions = new Map<string, Session>()
  private constructor(private readonly config: oidc.Configuration, private readonly issuer: string,
    private readonly origin: string) {}

  static async create(environment: NodeJS.ProcessEnv) {
    const issuer = environment.QSV_OIDC_ISSUER
    const clientId = environment.QSV_OIDC_CLIENT_ID
    const clientSecret = environment.QSV_OIDC_CLIENT_SECRET
    const domain = environment.LAZYCAT_APP_DOMAIN
    if (!issuer || !clientId || !clientSecret || !domain || !/^[a-z0-9.-]+$/i.test(domain)) {
      throw new Error('懒猫 OIDC 配置不完整，拒绝启动多人模式')
    }
    const issuerUrl = new URL(issuer)
    if (issuerUrl.protocol !== 'https:') throw new Error('OIDC issuer 必须使用 HTTPS')
    const config = await oidc.discovery(issuerUrl, clientId, clientSecret)
    oidc.enableNonRepudiationChecks(config)
    return new OidcAuth(config, config.serverMetadata().issuer, `https://${domain}`)
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
    setCookie(reply, TX_COOKIE, state, TRANSACTION_MS / 1000)
    return reply.redirect(redirect.href)
  }

  async callback(request: FastifyRequest, reply: FastifyReply) {
    this.prune()
    const providedState = cookie(request, TX_COOKIE)
    const queryState = (request.query as { state?: string }).state
    if (!providedState || !queryState || !equal(providedState, queryState)) {
      return reply.code(400).send('登录状态无效，请重新进入应用')
    }
    const transaction = this.transactions.get(queryState)
    this.transactions.delete(queryState)
    setCookie(reply, TX_COOKIE, '', 0)
    if (!transaction || transaction.expires <= Date.now()) return reply.code(400).send('登录已过期，请重新进入应用')
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
      return reply.code(401).send('平台登录验证失败，请重新进入应用')
    }
    if (!claims || typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 512) {
      return reply.code(401).send('平台未返回有效用户身份')
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
    setCookie(reply, SESSION_COOKIE, id, SESSION_MS / 1000)
    return reply.redirect('/')
  }

  logout(request: FastifyRequest, reply: FastifyReply) {
    const id = cookie(request, SESSION_COOKIE)
    if (id) this.sessions.delete(id)
    setCookie(reply, SESSION_COOKIE, '', 0)
    return { signedOut: true }
  }
}
