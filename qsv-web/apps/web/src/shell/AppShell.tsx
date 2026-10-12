import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Activity, BarChart3, Braces, ChevronDown, Combine, Database, FileUp, GitCompareArrows, LayoutDashboard, ListChecks, Repeat, Scissors, Search, Settings2, ShieldCheck, SlidersHorizontal, Table2, Wand2 } from 'lucide-react'
import { api, ApiError } from '@/api/client'
import { cn } from '@/ui/cn'
import { StatusDot } from '@/ui/Chip'
import { DraftScopeProvider } from '@/ui/useSessionDraft'
import { setLocale, useLocale, useT } from '@/ui/locale'
import { setDisplayTimezone } from '@/ui/timezone'
import { NAV_GROUPS, activeNavId, groupOfNavItem, localizedNavGroups } from './nav'
import { CommandPalette } from './CommandPalette'

const NAV_ICON: Record<string, typeof LayoutDashboard> = { LayoutDashboard, Database, FileUp, Table2, Wand2, Repeat, Combine, Scissors, SlidersHorizontal, GitCompareArrows, ShieldCheck, BarChart3, Braces, ListChecks, Activity, Settings2 }

function BrandMark() {
  return <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden className="shrink-0"><rect x="0.5" y="0.5" width="23" height="23" rx="7" className="fill-ink" /><path d="M6 16.5V8M9.3 16.5V11.6M12.6 16.5V6M15.9 16.5V12.4M19.2 16.5V9.4" className="stroke-ink-inverse" strokeWidth="1.7" strokeLinecap="round" /></svg>
}

function Sidebar() {
  const locale = useLocale()
  const t = useT()
  const groups = localizedNavGroups(locale)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const session = useQuery({ queryKey: ['session'], queryFn: api.session })
  const selectedId = activeNavId(pathname)
  const activeGroup = selectedId ? groupOfNavItem(selectedId) : undefined
  const [openGroups, setOpenGroups] = useState<string[]>(() => NAV_GROUPS.map((group) => group.id))
  useEffect(() => { if (activeGroup && !openGroups.includes(activeGroup.id)) setOpenGroups((current) => [...current, activeGroup.id]) }, [activeGroup?.id])
  return <aside className="row-span-2 flex min-h-0 flex-col border-r border-hairline bg-rail">
    <div className="flex h-16 shrink-0 items-center justify-center gap-3 px-2 lg:justify-start lg:px-5"><BrandMark /><div className="hidden min-w-0 lg:block"><p className="truncate text-body font-semibold tracking-tight text-ink">{t('qsv 数据工作台', 'qsv Data Workbench')}</p><p className="truncate text-meta text-ink-3">{session.data?.source === 'lazycat' ? t('懒猫用户空间', 'Lazycat workspace') : t('本机开发空间', 'Local workspace')}</p></div></div>
    <nav aria-label={t('主导航', 'Main navigation')} className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 lg:px-3">{groups.map((group) => {
      const open = openGroups.includes(group.id)
      return <div key={group.id} className="mb-1"><button type="button" aria-expanded={open} onClick={() => setOpenGroups((current) => current.includes(group.id) ? current.filter((id) => id !== group.id) : [...current, group.id])} className="press hidden w-full items-center gap-2 rounded-control px-2 py-1.5 text-left hover:bg-surface/60 lg:flex"><span className={cn('eyebrow flex-1', activeGroup?.id === group.id && 'text-ink')}>{group.label}</span><ChevronDown aria-hidden className={cn('size-3.5 text-ink-3', open ? '' : '-rotate-90')} /></button><span aria-hidden className="mx-1 my-1.5 block h-px bg-hairline lg:mx-2 lg:my-2" /><ul className={cn('space-y-0.5', !open && 'lg:hidden')}>{group.items.map((item) => {
        const active = item.id === selectedId
        const Icon = NAV_ICON[item.icon] ?? LayoutDashboard
        return <li key={item.id}><Link to={item.path} activeOptions={{ exact: true, includeSearch: false }} title={item.description} aria-label={item.label} aria-current={active ? 'page' : undefined} className={cn('press flex h-10 items-center justify-center gap-2.5 rounded-control px-2.5 text-cell lg:h-8 lg:justify-start', active ? 'bg-surface font-semibold text-ink shadow-rail' : 'text-ink-2 hover:bg-surface/70 hover:text-ink')}><Icon aria-hidden className={cn('size-4 shrink-0', active ? 'text-accent' : 'text-ink-3')} /><span className="hidden min-w-0 flex-1 truncate lg:block">{item.label}</span></Link></li>
      })}</ul></div>
    })}</nav>
    <div className="shrink-0 border-t border-hairline px-2 py-3 lg:px-4"><div className="flex items-center justify-center gap-2.5 lg:justify-start"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface text-meta font-semibold text-ink-2 shadow-rail">{session.data?.user.name.slice(0, 1) ?? t('用', 'U')}</span><div className="hidden min-w-0 flex-1 lg:block"><p className="truncate text-meta text-ink-2">{session.data?.user.name ?? t('读取用户中', 'Loading user')}</p><p className="figure truncate text-meta text-ink-3">{session.data?.user.workspaceId ?? '—'}</p></div><Link to="/settings" className="press hidden rounded-xs px-1 py-0.5 text-meta text-ink-3 hover:text-ink lg:block">{t('设置', 'Settings')}</Link></div></div>
  </aside>
}

function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const t = useT()
  const locale = useLocale()
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 2000 })
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities })
  const running = overview.data?.running ?? 0
  return <header className="flex h-14 shrink-0 items-center gap-2 px-4 lg:gap-4 lg:px-6 xl:px-7"><button type="button" onClick={onOpenPalette} className="press flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-control bg-surface px-3 text-left text-cell text-ink-3 shadow-rail hover:bg-surface-hover lg:max-w-md"><Search aria-hidden className="size-4 shrink-0" /><span className="flex-1 truncate">{t('搜索工具、资源和任务', 'Search tools, resources, and tasks')}</span><kbd className="kbd hidden rounded-xs bg-surface-sunk px-1.5 py-0.5 lg:block">⌘K</kbd></button><div className="hidden flex-1 lg:block" /><label className="shrink-0"><span className="sr-only">{t('界面语言', 'Interface language')}</span><select aria-label={t('界面语言', 'Interface language')} value={locale} onChange={(event) => setLocale(event.target.value === 'en-US' ? 'en-US' : 'zh-CN')} className="h-9 rounded-control border border-line bg-surface px-1 text-meta text-ink sm:px-2"><option value="zh-CN">中文</option><option value="en-US">English</option></select></label><Link to="/jobs" className="press hidden shrink-0 items-center gap-2 text-meta text-ink-2 sm:flex"><StatusDot tone={running > 0 ? 'info' : 'neutral'} pulse={running > 0} /><span className="figure">{t(`运行 ${running}`, `Running ${running}`)}</span></Link><span className="hidden h-4 w-px bg-hairline lg:block" /><span className="hidden shrink-0 text-meta text-ink-3 sm:inline" title={capabilities.data?.engine.reason ?? undefined}>{capabilities.data?.engine.verified ? t('引擎已验证', 'Engine verified') : t('引擎不可用', 'Engine unavailable')}</span></header>
}

function StatusBar() {
  const t = useT()
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 2000 })
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: api.capabilities })
  return <footer className="col-start-2 row-start-2 flex h-7.5 shrink-0 items-center gap-3 overflow-hidden border-t border-hairline bg-rail px-4 text-meta text-ink-3 lg:px-6 xl:px-7"><span className="figure hidden whitespace-nowrap sm:inline">{caps.data?.engine.verified ? 'qsv 23.0.1' : t('qsv 未就绪', 'qsv unavailable')}</span><span className="figure shrink-0 whitespace-nowrap">{t(`资源 ${overview.data?.resources ?? '—'}`, `Resources ${overview.data?.resources ?? '—'}`)}</span><span className="flex-1" /><Link to="/jobs" className="press figure shrink-0 whitespace-nowrap hover:text-ink"><span className="hidden sm:inline">{t(`运行 ${overview.data?.running ?? 0} · 排队 ${overview.data?.queued ?? 0} · 需处理 ${overview.data?.needsAttention ?? 0}`, `Running ${overview.data?.running ?? 0} · Queued ${overview.data?.queued ?? 0} · Attention ${overview.data?.needsAttention ?? 0}`)}</span><span className="sm:hidden">{t(`任务 ${(overview.data?.running ?? 0) + (overview.data?.queued ?? 0)} · 待处理 ${overview.data?.needsAttention ?? 0}`, `Tasks ${(overview.data?.running ?? 0) + (overview.data?.queued ?? 0)} · Attention ${overview.data?.needsAttention ?? 0}`)}</span></Link></footer>
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useT()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // 登录页是独立入口：不套工作台外壳，也不做会话拦截，否则未登录时会被 401 分支挡住。
  const isLoginRoute = pathname === '/login'
  const session = useQuery({ queryKey: ['session'], queryFn: api.session, enabled: !isLoginRoute })
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings, enabled: Boolean(session.data) })
  const navigate = useNavigate()
  useEffect(() => { if (settings.data?.settings.timezone) setDisplayTimezone(settings.data.settings.timezone) }, [settings.data?.settings.timezone])
  useEffect(() => { const onKeyDown = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(true) } if (event.key === 'g' && event.altKey) void navigate({ to: '/' }) }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown) }, [navigate])
  if (isLoginRoute) return <>{children}</>
  if (session.error instanceof ApiError && session.error.status === 401) {
    return <main className="flex min-h-screen items-center justify-center bg-canvas px-4"><div className="w-full max-w-md rounded-control bg-surface p-6 shadow-rail"><h1 className="text-title text-ink">{t('需要重新登录', 'Sign in again')}</h1><p className="mt-3 text-cell text-ink-2">{t('当前应用会话已结束。重新登录后，可以继续读取此空间内已保存的数据。', 'Your session has ended. Sign in again to access saved data in this workspace.')}</p><a href="/login" className="mt-5 inline-flex rounded-control bg-accent px-4 py-2 text-cell text-white">{t('重新登录', 'Sign in again')}</a></div></main>
  }
  return <div className="grid h-screen grid-cols-[60px_minmax(0,1fr)] grid-rows-[1fr_30px] overflow-hidden bg-canvas lg:grid-cols-[200px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)]"><Sidebar /><div className="col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col"><TopBar onOpenPalette={() => setPaletteOpen(true)} /><main className="flex min-h-0 min-w-0 flex-1 flex-col">{session.data ? <DraftScopeProvider key={session.data.user.workspaceId} workspaceId={session.data.user.workspaceId}>{children}</DraftScopeProvider> : <div className="p-6 text-cell text-ink-2">{session.error ? <><p>{t('无法读取当前会话：', 'Could not load the current session: ')}{session.error.message}</p><button className="mt-3 text-accent-ink hover:underline" onClick={() => void session.refetch()}>{t('重试', 'Retry')}</button></> : t('正在读取当前会话…', 'Loading your session…')}</div>}</main></div><StatusBar /><CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} /></div>
}
