import { getLocale } from '@/ui/locale'

const ENGLISH_ERRORS: Record<string, string> = {
  ANALYZE_FAILED: 'Analysis failed. Check the input data and settings.',
  BATCH_PARTIAL_FAILURE: 'Some groups failed. Open the batch details to review them.',
  COMBINE_FAILED: 'The combine operation failed. Check the input data and rules.',
  COMMIT_PENDING: 'The file is still being committed. Try again shortly.',
  COMPARE_FAILED: 'Comparison failed. Check the input data and rules.',
  EXPORT_FAILED: 'Export failed. Check the selected format and settings.',
  EXPORT_PREFLIGHT_FAILED: 'The export check failed. Review the selected data and settings.',
  EXPORT_TIMEOUT: 'Export exceeded the time limit.',
  IMPORT_FAILED: 'Import failed. Check the file and parsing settings.',
  IMPORT_TIMEOUT: 'Import exceeded the time limit.',
  INPUT_CHANGED: 'An input changed after the operation was prepared. Check it and try again.',
  INPUT_MISSING: 'An input is no longer available. Select another input.',
  INTERNAL_ERROR: 'The server could not complete this request.',
  INVALID_CSV: 'The CSV file could not be parsed. Check its structure and settings.',
  INVALID_REQUEST: 'The request is invalid. Check the entered values.',
  NOT_FOUND: 'The requested item was not found or is unavailable.',
  PREFLIGHT_FAILED: 'The preliminary check failed. Review its findings before continuing.',
  PREFLIGHT_TIMEOUT: 'The preliminary check exceeded the time limit.',
  RECIPE_TRIAL_EMPTY_SCOPE: 'The sample has no records for checking the export range.',
  QUALITY_FAILED: 'The quality check failed. Review its rules and input.',
  REFERENCE_CHANGED: 'A referenced resource changed. Refresh and check it again.',
  REQUEST_HEADER_REQUIRED: 'A required request header is missing.',
  REQUEST_FAILED: 'The request failed. Please try again.',
  SERVICE_STOPPED: 'The service is shutting down. Try again when it is available.',
  SPLIT_FAILED: 'The split operation failed. Check the input and settings.',
  SQL_FAILED: 'The SQL query failed. Check the query and its inputs.',
  TASK_TIMEOUT: 'The job exceeded the time limit.',
  UNAUTHENTICATED: 'Your session is not available. Sign in again.',
  WORKBOOK_LIMIT: 'The workbook exceeds its row, column or 20-sheet limit. Adjust the split size or choose CSV or TSV.',
}

const ERROR_TERMS: Record<string, string> = {
  ADMIN: 'administrator access', AGGREGATE: 'aggregation', ANNOTATION: 'annotation', BATCH: 'batch job',
  CELL: 'cell', CLEAN: 'cleaning rule', COLUMN: 'column', COMBINE: 'combination', COMPARE: 'comparison',
  CSV: 'CSV', CURSOR: 'page cursor', DATASET: 'dataset', DATE: 'date', DIGEST: 'file digest',
  DOWNLOAD: 'download', ENGINE: 'qsv engine', EXAMPLE: 'example', EXPORT: 'export', FILE: 'file',
  FILTER: 'filter', FREQUENCY: 'frequency analysis', IDENTITY: 'identity', IMPORT: 'import',
  INPUT: 'input', JOB: 'job', JSON: 'JSON', LIMITS: 'limits', OUTPUT: 'output', PAGE: 'page',
  PARQUET: 'Parquet', PIPELINE: 'pipeline', PIVOT: 'pivot table', PREFLIGHT: 'preflight check',
  QUALITY: 'quality rule', RAW: 'source file', RECIPE: 'template', REFERENCE: 'reference data',
  RELATION: 'join', RESOURCE: 'resource', RETRY: 'retry', REVISION: 'version', ROW: 'row',
  SCHEMA: 'schema', SEARCH: 'search', SETTINGS: 'settings', SHEET: 'worksheet', SPLIT: 'split',
  SQL: 'SQL query', STORAGE: 'storage', TASK: 'job', UPLOAD: 'upload', VERSION: 'version',
  VIEW: 'data view', WORKBOOK: 'workbook',
}

function errorSubject(code: string) {
  const token = code.split('_')[0] ?? ''
  return ERROR_TERMS[token] ?? 'operation'
}

function englishErrorFromCode(code: string) {
  const subject = errorSubject(code)
  if (code.startsWith('INVALID_')) return `The ${errorSubject(code.slice(8))} settings are invalid. Check the entered values.`
  if (code.endsWith('_NOT_FOUND')) return `The ${subject} was not found or is no longer available.`
  if (code.endsWith('_UNAVAILABLE')) return `The ${subject} is unavailable.`
  if (code.endsWith('_CHANGED') || code.endsWith('_STALE') || code.endsWith('_MISMATCH'))
    return `The ${subject} changed after this request was prepared. Refresh and check it again.`
  if (code.endsWith('_BUSY') || code.endsWith('_RATE_LIMIT')) return `The ${subject} is busy. Try again shortly.`
  if (code.endsWith('_TOO_LARGE') || code.endsWith('_LIMIT')) return `The ${subject} exceeds the supported limit.`
  if (code.endsWith('_UNSUPPORTED')) return `This ${subject} operation is not supported.`
  if (code.endsWith('_FAILED')) return `The ${subject} failed. Check its inputs and settings.`
  if (code.endsWith('_CONFLICT') || code.endsWith('_IN_USE')) return `The ${subject} conflicts with an existing operation or is in use.`
  if (code.endsWith('_INCOMPLETE')) return `The ${subject} is incomplete.`
  if (code.endsWith('_REQUIRED') || code.startsWith('MISSING_')) return `The ${subject} is required.`
  return `The operation could not continue (${code}).`
}

function errorLocation(originalMessage: string) {
  const row = /第\s*(\d+)\s*(?:行|条记录)/u.exec(originalMessage)?.[1]
  const field = /字段[“「]([^”」]{1,120})[”」]/u.exec(originalMessage)?.[1]
  return [row ? `row ${row}` : null, field ? `field ${field}` : null].filter(Boolean).join(', ')
}

export function localizedErrorMessage(code: string, originalMessage: string): string {
  if (getLocale() !== 'en-US') return originalMessage
  const summary = ENGLISH_ERRORS[code] ?? englishErrorFromCode(code)
  const location = errorLocation(originalMessage)
  return location ? `${summary} Location: ${location}.` : summary
}

export function localizedCleanReason(reason: string): string {
  if (getLocale() !== 'en-US' || !/[\p{Script=Han}]/u.test(reason)) return reason
  if (reason.includes('本地时间不存在或有两个可能的时间点')) return 'This local time is missing or repeated in the selected time zone; use an explicit offset.'
  if (reason.includes('须使用不含偏移的 ISO 日期时间')) return 'Use an ISO local date and time without an offset.'
  if (reason.includes('不符合所选格式')) return 'The date does not match the selected format.'
  if (reason.includes('不是有效日历日期') || reason.includes('日期时间无效')) return 'The date or time is invalid.'
  if (reason.includes('数值格式无效')) return 'The decimal value is invalid.'
  if (reason.includes('时区偏移含秒')) return 'The historical time zone offset includes seconds and cannot be written without loss.'
  return 'The value cannot be converted under the selected rule.'
}
