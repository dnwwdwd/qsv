import type { ReactNode } from 'react'
import { cn } from './cn'
import { useT } from './locale'

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'cyan' | 'orange'

const CHIP_TONES: Record<Tone, string> = {
  neutral: 'bg-surface-sunk text-ink-2',
  accent: 'bg-accent-soft text-accent-ink',
  ok: 'bg-ok-soft text-ok-ink',
  warn: 'bg-warn-soft text-warn-ink',
  danger: 'bg-danger-soft text-danger-ink',
  info: 'bg-info-soft text-info-ink',
  violet: 'bg-violet-soft text-violet-ink',
  cyan: 'bg-cyan-soft text-cyan-ink',
  orange: 'bg-orange-soft text-orange-ink',
}

export const DOT_TONES: Record<Tone, string> = {
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

/** 状态标签：颜色不单独承载含义，旁边始终有文字 */
export function Chip({
  tone = 'neutral',
  children,
  icon,
  className,
}: {
  tone?: Tone
  children: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-chip px-2 py-0.5 text-meta font-medium whitespace-nowrap',
        CHIP_TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  )
}

export function StatusDot({ tone = 'neutral', pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span aria-hidden className={cn('relative inline-flex size-1.5 rounded-full', DOT_TONES[tone])}>
      {pulse ? (
        <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', DOT_TONES[tone])} />
      ) : null}
    </span>
  )
}

/** 计数徽标 */
export function CountBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'figure inline-flex min-w-5 items-center justify-center rounded-chip bg-surface-sunk px-1.5 text-meta text-ink-2',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** 范围标识：样本 / 全量 / 当前筛选，必须始终可见（PRD G-01） */
export function ScopeTag({ scope, className }: { scope: 'sample' | 'full' | 'view' | 'unknown'; className?: string }) {
  const t = useT()
  const map = {
    sample: { tone: 'warn' as Tone, text: t('样本', 'Sample'), title: t('结果来自抽样预览，不代表全量结论', 'Results come from a sample and do not represent the full dataset') },
    full: { tone: 'ok' as Tone, text: t('全量', 'Full dataset'), title: t('作用范围为完整数据集', 'Applies to the full dataset') },
    view: { tone: 'info' as Tone, text: t('当前视图', 'Current view'), title: t('作用范围为当前筛选后的视图', 'Applies to the current filtered view') },
    unknown: { tone: 'neutral' as Tone, text: t('范围未知', 'Scope unknown'), title: t('尚未确定作用范围', 'The scope has not been determined') },
  }[scope]

  return (
    <span
      title={map.title}
      className={cn(
        'inline-flex items-center rounded-xs px-1.5 py-px text-meta font-medium',
        CHIP_TONES[map.tone],
        className,
      )}
    >
      {map.text}
    </span>
  )
}
