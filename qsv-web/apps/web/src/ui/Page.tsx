import type { ReactNode } from 'react'
import { cn } from './cn'

/** 页头与正文共用左右间距，页头始终贴合主内容区的完整宽度。 */
const PAGE_GUTTER = 'px-4 lg:px-6 xl:px-7'

/**
 * 页面顶部条：页面顶部的唯一一行，标题、事实、本页控件与主操作都在这一行里。
 * 不再有单独的页头区块（原来的白底页头占 136px，且与内容各占一条左边缘）。
 * 表格类页面把自己的筛选/排序等控件作为 children 传进来，与标题合并成一行。
 * below 用于这一行下方的展开区（例如筛选条件编辑器），仍属于同一条分隔线。
 */
export function PageTopBar({
  title,
  hint,
  facts,
  actions,
  children,
  below,
}: {
  title: ReactNode
  /** 标题的悬浮说明，原来页头上的说明句放这里 */
  hint?: string
  facts?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  below?: ReactNode
}) {
  return (
    <div className="box-border w-full min-w-0 shrink-0 rounded-none border-b border-hairline bg-surface shadow-none">
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 py-2', PAGE_GUTTER)}>
        <h1 className="min-w-0 max-w-full truncate text-title font-semibold text-ink" title={hint}>
          {title}
        </h1>
        {facts ? <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">{facts}</div> : null}
        {children}
        <span className="min-w-0 flex-1" />
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {below ? <div className={cn('border-t border-hairline bg-canvas py-2', PAGE_GUTTER)}>{below}</div> : null}
    </div>
  )
}

/** 事实项：标签 + 值，值用等宽数字 */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-2 text-meta">
      <span className="text-ink-3">{label}</span>
      <span className="figure text-cell font-medium text-ink">{children}</span>
    </span>
  )
}

/** 页面主体：统一使用页面内边距；表格类页面也用同一内边距，避免各页左边缘不一致 */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('box-border w-full min-w-0 min-h-0 flex-1 overflow-auto py-4', PAGE_GUTTER, className)}>{children}</div>
}

/** 区块标题：靠留白分组，不套卡片 */
export function SectionTitle({
  title,
  hint,
  actions,
  className,
}: {
  title: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-end justify-between gap-3', className)}>
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h2 className="text-title font-semibold text-ink">{title}</h2>
        {hint ? <span className="text-meta text-ink-3">{hint}</span> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
