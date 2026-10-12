import { useEffect, useState } from 'react'
import { LogIn, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button } from '@/ui/Button'
import { getLocale, useT } from '@/ui/locale'

/** 懒猫认证回调失败时服务端会带上的错误标识。 */
const ERROR_TEXT: Record<string, { zh: string; en: string }> = {
  state: { zh: '登录状态无效，请重新发起登录。', en: 'The sign-in state was invalid. Please start again.' },
  expired: { zh: '登录已过期，请重新发起登录。', en: 'The sign-in request expired. Please start again.' },
  failed: { zh: '平台登录验证失败，请重新尝试。', en: 'The platform could not verify your sign-in. Please try again.' },
  identity: { zh: '平台未返回有效用户身份。', en: 'The platform did not return a valid identity.' },
}

function BrandMark() {
  return <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden className="shrink-0"><rect x="0.5" y="0.5" width="23" height="23" rx="7" className="fill-ink" /><path d="M6 16.5V8M9.3 16.5V11.6M12.6 16.5V6M15.9 16.5V12.4M19.2 16.5V9.4" className="stroke-ink-inverse" strokeWidth="1.7" strokeLinecap="round" /></svg>
}

/**
 * 登录页。懒猫模式下必须完成 OIDC 登录才能进入工作台；
 * 登录按钮直接跳到服务端 /auth/login，由服务端带 PKCE 与 state 跳转平台。
 */
export function LoginPage() {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [redirecting, setRedirecting] = useState(false)

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('authError')
    const entry = code ? ERROR_TEXT[code] ?? ERROR_TEXT.failed! : null
    setError(entry ? (getLocale() === 'en-US' ? entry.en : entry.zh) : null)
  }, [])

  const signIn = () => {
    setRedirecting(true)
    window.location.assign('/auth/login')
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-md rounded-panel bg-surface p-7 shadow-pop">
        <div className="flex items-center gap-3">
          <BrandMark />
          <div className="min-w-0">
            <p className="truncate text-title font-semibold tracking-tight text-ink">{t('qsv 数据工作台', 'qsv Data Workbench')}</p>
            <p className="truncate text-meta text-ink-3">{t('懒猫用户空间', 'Lazycat workspace')}</p>
          </div>
        </div>

        <h1 className="mt-6 text-title text-ink">{t('登录后继续', 'Sign in to continue')}</h1>
        <p className="mt-2 text-cell leading-relaxed text-ink-2">
          {t('使用懒猫账号登录后，才能导入、整理、核对和导出你自己的数据。本机工作台不会读取其他用户的空间。',
            'Sign in with your Lazycat account to import, clean, compare, and export your own data. This workbench never reads another user’s workspace.')}
        </p>

        {error ? (
          <div role="alert" className="mt-5 flex items-start gap-2.5 rounded-panel bg-warn-soft/70 px-4 py-3 text-warn-ink">
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p className="text-meta leading-relaxed">{error}</p>
          </div>
        ) : null}

        <Button variant="primary" size="lg" className="mt-6 w-full" leading={<LogIn aria-hidden className="size-4" />} disabled={redirecting} onClick={signIn}>
          {redirecting ? t('正在跳转登录…', 'Redirecting to sign in…') : t('使用懒猫账号登录', 'Continue with Lazycat')}
        </Button>

        <p className="mt-5 flex items-start gap-2 text-meta leading-relaxed text-ink-3">
          <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {t('登录授权由懒猫微服认证服务处理；工作台只保存短期的应用会话，不保存平台密码。',
            'Authentication is handled by the Lazycat authentication service. The workbench stores only a short-lived app session, never your platform password.')}
        </p>
      </div>
    </main>
  )
}
