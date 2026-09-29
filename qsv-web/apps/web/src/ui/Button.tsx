import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-meta',
  md: 'h-8.5 gap-1.5 px-3 text-cell',
  lg: 'h-9.5 gap-2 px-4 text-body',
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-ink-inverse shadow-rail hover:bg-accent-hover',
  secondary: 'bg-surface text-ink shadow-rail hover:bg-surface-hover',
  ghost: 'text-ink-2 hover:bg-surface-hover hover:text-ink',
  quiet: 'text-ink-3 hover:bg-surface-hover hover:text-ink',
  danger: 'bg-danger text-ink-inverse shadow-rail hover:bg-danger-hover',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 图标放左侧 */
  leading?: ReactNode
  /** 图标放右侧（常用于方向性动作） */
  trailing?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  leading,
  trailing,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'press inline-flex shrink-0 items-center justify-center rounded-control font-medium whitespace-nowrap select-none',
        'disabled:cursor-not-allowed disabled:opacity-40',
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
      {trailing}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 必填：无障碍名称，图标按钮不能只靠图标表达含义 */
  label: string
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const box = size === 'sm' ? 'size-7' : size === 'lg' ? 'size-9' : 'size-8'
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'press inline-flex shrink-0 items-center justify-center rounded-control',
        'disabled:cursor-not-allowed disabled:opacity-40',
        box,
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** 成组的图标按钮：共享一个外框，靠细线区分 */
export function IconButtonGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('inline-flex items-center gap-0.5 rounded-control bg-surface p-0.5 shadow-rail', className)}>
      {children}
    </div>
  )
}
