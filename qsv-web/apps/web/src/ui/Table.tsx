import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from './cn'
import { useT } from './locale'

export interface ColumnDef<T> {
  id: string
  header: ReactNode
  /** 单元格渲染 */
  cell: (row: T, index: number) => ReactNode
  align?: 'left' | 'right' | 'center'
  width?: string
  sortable?: boolean
  /** 表头附注，例如单位、口径说明 */
  hint?: string
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  sort?: { columnId: string; direction: 'asc' | 'desc' } | null
  onSortChange?: (next: { columnId: string; direction: 'asc' | 'desc' } | null) => void
  onRowClick?: (row: T, index: number) => void
  activeRowKey?: string | null
  /** 行级强调色，用于核对分类等语义分组 */
  rowTone?: (row: T) => 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'cyan' | 'orange' | null
  emptyMessage?: ReactNode
  className?: string
  density?: 'dense' | 'normal'
  /** 行号列：显示从 1 开始的连续序号 */
  showIndex?: boolean
}

const TONE_ROW: Record<string, string> = {
  neutral: '',
  ok: 'bg-ok-soft/50',
  warn: 'bg-warn-soft/50',
  danger: 'bg-danger-soft/50',
  info: 'bg-info-soft/50',
  violet: 'bg-violet-soft/50',
  cyan: 'bg-cyan-soft/50',
  orange: 'bg-orange-soft/50',
}

/**
 * 常规表格：任务列表、核对明细、聚合结果等行数有界的场景。
 * 百万行浏览请使用 VirtualDataTable（行块 + 虚拟滚动）。
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  onRowClick,
  activeRowKey,
  rowTone,
  emptyMessage,
  className,
  density = 'normal',
  showIndex = false,
}: DataTableProps<T>) {
  const t = useT()
  const cellPadding = density === 'dense' ? 'px-3 py-1.5' : 'px-4 py-2.5'

  const toggleSort = (columnId: string) => {
    if (!onSortChange) return
    if (!sort || sort.columnId !== columnId) {
      onSortChange({ columnId, direction: 'asc' })
      return
    }
    if (sort.direction === 'asc') {
      onSortChange({ columnId, direction: 'desc' })
      return
    }
    onSortChange(null)
  }

  return (
    <div className={cn('min-h-0 overflow-auto bg-surface', className)}>
      <table className="w-full border-collapse text-cell">
        <thead className="sticky top-0 z-10">
          <tr className="border-b border-hairline bg-surface">
            {showIndex ? (
              <th scope="col" className={cn('w-14 text-right text-meta font-medium text-ink-3', cellPadding)}>
                {t('行号', 'Row')}
              </th>
            ) : null}
            {columns.map((column) => {
              const isSorted = sort?.columnId === column.id
              return (
                <th
                  key={column.id}
                  scope="col"
                  style={column.width ? { width: column.width } : undefined}
                  aria-sort={isSorted ? (sort?.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cn(
                    'font-medium whitespace-nowrap text-ink-3',
                    cellPadding,
                    column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left',
                  )}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column.id)}
                      className="press inline-flex items-center gap-1 rounded-xs px-1 py-0.5 text-meta text-ink-3 hover:bg-surface-hover hover:text-ink-2"
                      title={column.hint ?? t('点击切换排序：升序 → 降序 → 取消', 'Click to sort: ascending → descending → clear')}
                    >
                      {column.header}
                      {isSorted ? (
                        sort?.direction === 'asc' ? (
                          <ArrowUp aria-hidden className="size-3 text-accent-ink" />
                        ) : (
                          <ArrowDown aria-hidden className="size-3 text-accent-ink" />
                        )
                      ) : null}
                    </button>
                  ) : (
                    <span className="text-meta" title={column.hint}>
                      {column.header}
                    </span>
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (showIndex ? 1 : 0)} className="px-4 py-12 text-center text-ink-3">
                {emptyMessage ?? t('当前筛选条件下没有记录。', 'No records match the current filters.')}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const key = rowKey(row, index)
              const tone = rowTone?.(row) ?? null
              return (
                <tr
                  key={key}
                  onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                  className={cn(
                    'border-b border-hairline-soft',
                    tone ? TONE_ROW[tone] : null,
                    activeRowKey === key && 'bg-accent-soft',
                    onRowClick && 'cursor-pointer',
                    'hover:bg-surface-hover',
                  )}
                >
                  {showIndex ? (
                    <td className={cn('figure text-right text-meta text-ink-3', cellPadding)}>{index + 1}</td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        cellPadding,
                        'align-top text-ink',
                        column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : 'text-left',
                      )}
                    >
                      {column.cell(row, index)}
                    </td>
                  ))}
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
