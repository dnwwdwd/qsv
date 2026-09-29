import { MAX_UPLOAD_BYTES, MAX_WORKBOOK_BYTES } from './files.ts'

export interface AppLimits {
  fileBytes: number
  workbookBytes: number
  ownerQuotaBytes: number
  globalQuotaBytes: number
  minFreeBytes: number
  maxActiveOwnerJobs: number
  maxActiveGlobalJobs: number
  maxOwnerUploads: number
  maxGlobalUploads: number
  maxOwnerResources: number
  maxGlobalResources: number
  taskTimeoutMinutes: number
}

export const DEFAULT_APP_LIMITS: AppLimits = {
  fileBytes: MAX_UPLOAD_BYTES, workbookBytes: MAX_WORKBOOK_BYTES,
  ownerQuotaBytes: 40 * 1024 ** 3, globalQuotaBytes: 100 * 1024 ** 3, minFreeBytes: 1024 ** 3,
  maxActiveOwnerJobs: 32, maxActiveGlobalJobs: 256, maxOwnerUploads: 32, maxGlobalUploads: 256,
  maxOwnerResources: 10_000, maxGlobalResources: 100_000, taskTimeoutMinutes: 30,
}

export class LimitsError extends Error {}

export function validateAppLimits(value: unknown): AppLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LimitsError('保护上限配置无效')
  const limits = value as Record<string, unknown>
  const keys = Object.keys(DEFAULT_APP_LIMITS) as (keyof AppLimits)[]
  if (Object.keys(limits).length !== keys.length || keys.some((key) => !Number.isSafeInteger(limits[key]) ||
    (limits[key] as number) < 1 || (limits[key] as number) > DEFAULT_APP_LIMITS[key])) throw new LimitsError('保护上限必须是现有安全范围内的正整数')
  const result = Object.fromEntries(keys.map((key) => [key, limits[key]])) as unknown as AppLimits
  if (result.workbookBytes > result.fileBytes || result.ownerQuotaBytes > result.globalQuotaBytes ||
    result.maxActiveOwnerJobs > result.maxActiveGlobalJobs || result.maxOwnerUploads > result.maxGlobalUploads ||
    result.maxOwnerResources > result.maxGlobalResources) throw new LimitsError('用户上限不能超过对应的全局上限')
  return result
}
