import { clsx, type ClassValue } from 'clsx'

/**
 * 合并类名。项目未引入 tailwind-merge：基础组件通过 className 只接收布局类
 * （宽高、外边距、排列），颜色与圆角必须由组件变体决定，避免互相覆盖。
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs)
}
