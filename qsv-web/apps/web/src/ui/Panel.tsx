import type { ReactNode } from 'react'
import { cn } from './cn'

/**
 * 面板：只在内容确实需要独立边界时使用（配置区、结果区、详情区）。
 * 页面级区块优先用留白与分隔线分组，不要把每个区块都套成同款卡片。
 */
export function Panel({
  children,
  className,
  flush = false,
}: {
  children: ReactNode
  className?: string
  /** 内容自带内边距时使用 */
  flush?: boolean
}) {
  return (
    <section className={cn('rounded-panel bg-surface shadow-card', flush ? 'overflow-hidden' : 'p-5', className)}>
      {children}
    </section>
  )
}

export function PanelHeader({
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
    <header className={cn('flex items-start justify-between gap-4', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-ink-3">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-title font-semibold text-ink">{title}</h2>
          {description ? <p className="mt-1 text-cell text-ink-3">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** 面板内小节：用留白与细线分组，不再套卡片 */
export function PanelSection({
  title,
  hint,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('border-t border-hairline-soft pt-4 first:border-t-0 first:pt-0', className)}>
      {title || actions ? (
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            {title ? <h3 className="text-cell font-semibold text-ink">{title}</h3> : null}
            {hint ? <span className="text-meta text-ink-3">{hint}</span> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}

/** 工具栏：操作条与内容之间用一条细线分隔 */
export function Toolbar({
  children,
  className,
  sticky = false,
}: {
  children: ReactNode
  className?: string
  sticky?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-hairline bg-surface px-4 py-2.5 lg:px-6 xl:px-7',
        sticky && 'sticky top-0 z-20',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function ToolbarSpacer() {
  return <div className="min-w-0 flex-1" />
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px bg-hairline" />
}
