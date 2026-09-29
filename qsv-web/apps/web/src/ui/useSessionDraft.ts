import { createContext, createElement, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

const DraftScope = createContext<string | null>(null)

export function DraftScopeProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  return createElement(DraftScope.Provider, { value: workspaceId }, children)
}

/** 仅保存尚未提交的表单选项；文件、服务端结果和任务状态不能存入草稿。 */
export function useSessionDraft<T>(name: string, initial: T): [T, Dispatch<SetStateAction<T>>, boolean] {
  const workspaceId = useContext(DraftScope)
  const key = workspaceId ? `qsv-web:draft:v1:${workspaceId}:${name}` : null
  const [saved] = useState(() => {
    if (typeof window === 'undefined' || !key) return { value: initial, restored: false }
    try {
      const raw = window.sessionStorage.getItem(key)
      if (raw === null) return { value: initial, restored: false }
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(initial)) return Array.isArray(parsed)
        ? { value: parsed as T, restored: true } : { value: initial, restored: false }
      if (initial !== null && typeof initial === 'object') {
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { value: parsed as T, restored: true } : { value: initial, restored: false }
      }
      return typeof parsed === typeof initial
        ? { value: parsed as T, restored: true } : { value: initial, restored: false }
    } catch { return { value: initial, restored: false } }
  })
  const [value, setValue] = useState<T>(saved.value)
  useEffect(() => {
    if (!key) return
    try { window.sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* 存储不可用时仍可在当前页面编辑。 */ }
  }, [key, value])
  return [value, setValue, saved.restored]
}
