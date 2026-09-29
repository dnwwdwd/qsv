import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from './cn'

/** 表单字段外壳：标签、说明、错误三者位置固定，避免校验后布局跳动 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  children,
  className,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  required?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="flex items-center gap-1 text-cell font-medium text-ink-2">
        {label}
        {required ? <span className="text-danger">*</span> : null}
      </label>
      {hint ? <p className="mt-1 text-meta text-ink-3">{hint}</p> : null}
      <div className="mt-2">{children}</div>
      {error ? (
        <p role="alert" className="mt-1.5 text-meta text-danger-ink">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const CONTROL =
  'w-full rounded-control bg-surface px-3 text-cell text-ink shadow-rail transition-shadow duration-140 ease-standard ' +
  'placeholder:text-ink-3 disabled:cursor-not-allowed disabled:bg-surface-sunk disabled:text-ink-3 ' +
  'hover:bg-surface-hover focus:bg-surface focus-visible:shadow-none'

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(CONTROL, 'h-8.5', className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(CONTROL, 'min-h-22 py-2 leading-relaxed', className)} {...rest} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(CONTROL, 'h-8.5 cursor-pointer appearance-none pr-8', className)} {...rest}>
      {children}
    </select>
  )
}

export function Checkbox({
  label,
  description,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn('flex items-start gap-2.5 text-cell text-ink', className)}>
      <input type="checkbox" className="check mt-0.5" {...rest} />
      <span className="min-w-0">
        {label ? <span className="block">{label}</span> : null}
        {description ? <span className="mt-1 block text-meta text-ink-3">{description}</span> : null}
      </span>
    </label>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-cell text-ink">{label}</p>
        {description ? <p className="mt-1 text-meta text-ink-3">{description}</p> : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'press relative h-5 w-9 shrink-0 rounded-chip transition-colors duration-140 ease-standard',
          checked ? 'bg-accent' : 'bg-hairline-strong',
          disabled && 'cursor-not-allowed opacity-40',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-4 rounded-full bg-surface shadow-card transition-[translate] duration-150 ease-quart',
            checked ? 'translate-x-4.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  )
}

/** 分段控件：少量互斥选项，比下拉框更快 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T
  onChange: (next: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div role="group" className={cn('inline-flex items-center gap-1 rounded-control bg-surface-sunk p-1', className)}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'press rounded-xs font-medium whitespace-nowrap transition-colors duration-140 ease-standard',
              size === 'sm' ? 'h-6 px-2 text-meta' : 'h-7 px-2.5 text-cell',
              active ? 'bg-surface text-ink shadow-rail' : 'text-ink-3 hover:text-ink',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** 只读字段展示 */
export function ReadOnlyValue({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return <span className={cn('text-cell text-ink', mono && 'figure break-all')}>{children}</span>
}
