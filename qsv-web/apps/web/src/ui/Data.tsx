import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * 指标条：横向排列的关键数字，窄屏自动折成 2 列。
 * 只提供 2/3/4/6 四种列数，用静态类名保证 Tailwind 能扫到。
 */
const METRIC_COLUMNS: Record<number, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 xl:grid-cols-4',
  6: 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6',
}

export function MetricStrip({
  children,
  className,
  columns = 3,
}: {
  children: ReactNode
  className?: string
  columns?: 2 | 3 | 4 | 6
}) {
  return (
    <div
      className={cn(
        'grid divide-x divide-y divide-hairline-soft overflow-hidden rounded-panel bg-surface shadow-card',
        METRIC_COLUMNS[columns] ?? METRIC_COLUMNS[3],
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Metric({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  className,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  hint?: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'violet' | 'cyan' | 'orange'
  className?: string
}) {
  const valueTone: Record<string, string> = {
    neutral: 'text-ink',
    ok: 'text-ok-ink',
    warn: 'text-warn-ink',
    danger: 'text-danger-ink',
    accent: 'text-accent-ink',
    info: 'text-info-ink',
    violet: 'text-violet-ink',
    cyan: 'text-cyan-ink',
    orange: 'text-orange-ink',
  }
  return (
    <div
      title={typeof hint === 'string' ? hint : undefined}
      className={cn('flex min-w-0 flex-col items-start gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-3', className)}
    >
      <p className="min-w-0 flex-1 truncate text-meta text-ink-3">{label}</p>
      <p className={cn('figure flex shrink-0 items-baseline gap-1 text-figure font-semibold', valueTone[tone])}>
        <span>{value}</span>
        {unit ? <span className="text-meta font-normal text-ink-3">{unit}</span> : null}
      </p>
    </div>
  )
}

/** 键值列表：详情面板里的字段展示 */
export function KeyValueList({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode; mono?: boolean }[]
  className?: string
}) {
  return (
    <dl className={cn('divide-y divide-hairline-soft', className)}>
      {items.map((item, index) => (
        <div key={index} className="flex items-start justify-between gap-6 py-2 first:pt-0 last:pb-0">
          <dt className="shrink-0 text-meta text-ink-3">{item.label}</dt>
          <dd className={cn('min-w-0 [overflow-wrap:anywhere] text-right text-cell text-ink', item.mono && 'figure break-all')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 数字单元格：右对齐 + 等宽 */
export function Figure({
  children,
  align = 'right',
  tone,
  className,
}: {
  children: ReactNode
  align?: 'left' | 'right'
  tone?: 'neutral' | 'ok' | 'danger' | 'warn' | 'muted'
  className?: string
}) {
  const toneClass = {
    neutral: 'text-ink',
    ok: 'text-ok-ink',
    danger: 'text-danger-ink',
    warn: 'text-warn-ink',
    muted: 'text-ink-3',
  }[tone ?? 'neutral']
  return (
    <span className={cn('figure block truncate tabular-nums', align === 'right' && 'text-right', toneClass, className)}>
      {children}
    </span>
  )
}
