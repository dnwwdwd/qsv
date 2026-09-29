import { createHash } from 'node:crypto'

export interface Identity {
  ownerKey: string
  workspaceId: string
  displayName: string
  source: 'local' | 'lazycat'
  role?: 'admin' | 'normal'
}

function opaque(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

export function localIdentity(): Identity {
  const ownerKey = opaque('qsv-web:local:single-user')
  return { ownerKey, workspaceId: ownerKey.slice(0, 24), displayName: '本机用户', source: 'local', role: 'admin' }
}
