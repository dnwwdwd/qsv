import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react'
import { create } from 'zustand'
import { cn } from './cn'
import type { Tone } from './Chip'
import { useT } from './locale'

const BANNER_TONES: Record<'info' | 'ok' | 'warn' | 'danger', { wrap: string; icon: ReactNode }> = {
  info: {
    wrap: 'bg-info-soft/70 text-info-ink',
    icon: <Info aria-hidden className="mt-0.5 size-4 shrink-0" />,
  },
  ok: {
    wrap: 'bg-ok-soft/70 text-ok-ink',
    icon: <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />,
  },
  warn: {
    wrap: 'bg-warn-soft/70 text-warn-ink',
    icon: <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />,
  },
  danger: {
    wrap: 'bg-danger-soft/70 text-danger-ink',
    icon: <XCircle aria-hidden className="mt-0.5 size-4 shrink-0" />,
  },
}

/** 行内提示条：说明影响、限制或异常，不使用弹窗打断流程 */
export function Banner({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger'
  title?: ReactNode
  children?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  const conf = BANNER_TONES[tone]
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn('flex items-start gap-2.5 rounded-panel px-4 py-3', conf.wrap, className)}
    >
      {conf.icon}
      <div className="min-w-0 flex-1">
        {title ? <p className="text-cell font-semibold">{title}</p> : null}
        {children ? <div className={cn('text-meta leading-relaxed', title && 'mt-1')}>{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

/** 不确定进度：只表示"正在处理"，不伪造百分比 */
export function LoadingLine({ active, className }: { active: boolean; className?: string }) {
  const t = useT()
  if (!active) return null
  return (
    <div role="progressbar" aria-label={t('正在处理', 'Processing')} className={cn('indeterminate h-0.5 w-full bg-accent-soft', className)} />
  )
}

/** 确定进度条：用于已知阶段比例的任务 */
export function Meter({ value, tone = 'accent', className }: { value: number; tone?: Tone; className?: string }) {
  const safe = Math.max(0, Math.min(100, value))
  const bar: Record<Tone, string> = {
    neutral: 'bg-ink-3',
    accent: 'bg-accent',
    ok: 'bg-ok',
    warn: 'bg-warn',
    danger: 'bg-danger',
    info: 'bg-info',
    violet: 'bg-violet',
    cyan: 'bg-cyan',
    orange: 'bg-orange',
  }
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(safe)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-1 w-full overflow-hidden rounded-chip bg-hairline-soft', className)}
    >
      <div
        className={cn('h-full rounded-chip transition-[width] duration-300 ease-quart', bar[tone])}
        style={{ width: `${safe}%` }}
      />
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-xs bg-hairline-soft', className)} />
}

export function Spinner({ className, label = '正在加载' }: { className?: string; label?: string }) {
  const t = useT()
  return <Loader2 aria-label={label === '正在加载' ? t('正在加载', 'Loading') : label} className={cn('size-4 animate-spin text-ink-3', className)} />
}

/** 空状态：说明为什么空、下一步做什么；不用居中大插画 */
export function EmptyState({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-start gap-3.5 px-6 py-12', className)}>
      <div className="flex size-10 items-center justify-center rounded-panel bg-surface-sunk text-ink-3">
        {icon ?? <Info aria-hidden className="size-4" />}
      </div>
      <div>
        <p className="text-title font-semibold text-ink">{title}</p>
        {description ? <p className="mt-1.5 max-w-prose text-cell text-ink-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2 pt-1">{actions}</div> : null}
    </div>
  )
}

/* 轻量提示：动作完成后的确认，3 秒自动消失 */
interface Toast {
  id: number
  message: string
  tone: 'neutral' | 'ok' | 'danger'
}

interface ToastStore {
  items: Toast[]
  push: (message: string, tone?: Toast['tone']) => void
  dismiss: (id: number) => void
}

let toastSeq = 0

export const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (message, tone = 'neutral') => {
    const id = ++toastSeq
    set((state) => ({ items: [...state.items, { id, message, tone }] }))
    setTimeout(() => set((state) => ({ items: state.items.filter((item) => item.id !== id) })), 3200)
  },
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}))

export function toast(message: string, tone: Toast['tone'] = 'neutral') {
  useToastStore.getState().push(message, tone)
}

const TOAST_TONES: Record<Toast['tone'], string> = {
  neutral: 'bg-ink text-ink-inverse',
  ok: 'bg-ok-ink text-ink-inverse',
  danger: 'bg-danger-ink text-ink-inverse',
}

export function Toaster() {
  const items = useToastStore((state) => state.items)
  const dismiss = useToastStore((state) => state.dismiss)
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-14 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => dismiss(item.id)}
          className={cn(
            'enter-block pointer-events-auto max-w-xl rounded-control px-4 py-2.5 text-center text-cell shadow-pop',
            TOAST_TONES[item.tone],
          )}
        >
          {item.message}
        </button>
      ))}
    </div>
  )
}
