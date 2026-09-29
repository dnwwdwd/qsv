import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { finished, pipeline } from 'node:stream/promises'
import { parse } from 'csv-parse'
import * as yazl from 'yazl'
import type { CompareConfig, CompareSummary } from './compare.ts'

const categories = ['equal', 'different', 'pair_error', 'left_only', 'right_only', 'key_conflict',
  'invalid_left_key', 'invalid_right_key'] as const
const labels: Record<string, string> = { equal: '一致', different: '字段差异', pair_error: '字段解析异常',
  left_only: '仅左', right_only: '仅右', key_conflict: '键冲突', invalid_left_key: '左侧无效键',
  invalid_right_key: '右侧无效键' }
const excelRows = 1_048_575
const maxSheets = 200

export interface CompareReportInfo {
  resultId: string
  resultHash: string
  resultCreatedAt: number
  comparedAt: number
  generatedAt: number
  jobId: string
  engineVersion: string
  left: { id: string; name: string; hash: string }
  right: { id: string; name: string; hash: string }
  config: CompareConfig
  summary: CompareSummary
  annotations: (detailRows: number[]) => Map<number, { status: string; note: string }>
}

export class CompareReportError extends Error {}

function csvCell(value: string) {
  const protectedValue = /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? `'${value}` : value
  return /[",\r\n]/u.test(protectedValue) ? `"${protectedValue.replaceAll('"', '""')}"` : protectedValue
}
function csvLine(row: string[]) { return `${row.map(csvCell).join(',')}\n` }
function xml(value: string) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/gu, '�')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}
function column(index: number) {
  let value = index + 1
  let name = ''
  while (value > 0) { value -= 1; name = String.fromCharCode(65 + value % 26) + name; value = Math.floor(value / 26) }
  return name
}
function sheetRow(values: string[], number: number) {
  return `<row r="${number}">${values.map((value, index) => {
    if (value.length > 32_767) throw new CompareReportError(`第 ${number} 行、第 ${index + 1} 列超过 Excel 单元格长度上限`)
    return `<c r="${column(index)}${number}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
  }).join('')}</row>`
}
async function write(stream: WriteStream, content: string) { if (!stream.write(content)) await once(stream, 'drain') }
type Sheet = { name: string; file: string; stream: WriteStream; rows: number; category: string }

function reportFacts(info: CompareReportInfo) {
  const summary = info.summary
  return [
    ['报告生成时间', new Date(info.generatedAt).toISOString()],
    ['核对运行时间', new Date(info.comparedAt).toISOString()],
    ['结果创建时间', new Date(info.resultCreatedAt).toISOString()],
    ['结果 ID', info.resultId], ['结果版本 SHA256', info.resultHash], ['核对任务 ID', info.jobId],
    ['引擎版本', info.engineVersion],
    ['左侧业务名称', info.config.leftLabel ?? info.left.name], ['右侧业务名称', info.config.rightLabel ?? info.right.name],
    ['左侧名称', info.left.name], ['左侧资源 ID', info.left.id], ['左侧版本 SHA256', info.left.hash],
    ['右侧名称', info.right.name], ['右侧资源 ID', info.right.id], ['右侧版本 SHA256', info.right.hash],
    ['左侧输入记录', String(summary.leftRows)], ['右侧输入记录', String(summary.rightRows)],
    ['一致匹配对', String(summary.equalPairs)], ['字段差异匹配对', String(summary.differentPairs)],
    ['字段解析异常对', String(summary.pairErrors)], ['仅左记录', String(summary.leftOnly)],
    ['仅右记录', String(summary.rightOnly)], ['左侧无效键记录', String(summary.leftInvalid)],
    ['右侧无效键记录', String(summary.rightInvalid)], ['左侧键冲突记录', String(summary.leftConflict)],
    ['右侧键冲突记录', String(summary.rightConflict)], ['重复键组', String(summary.conflictGroups)],
    ['左侧聚合额外记录', String(summary.leftAggregatedExtra ?? 0)],
    ['右侧聚合额外记录', String(summary.rightAggregatedExtra ?? 0)],
    ['字段差异数', String(summary.differentFields)], ['明细总行数', String(summary.detailRows)],
    ['左侧数量核对', String(summary.leftInvalid + summary.leftConflict + summary.leftOnly + summary.equalPairs + summary.differentPairs + summary.pairErrors + (summary.leftAggregatedExtra ?? 0) === summary.leftRows)],
    ['右侧数量核对', String(summary.rightInvalid + summary.rightConflict + summary.rightOnly + summary.equalPairs + summary.differentPairs + summary.pairErrors + (summary.rightAggregatedExtra ?? 0) === summary.rightRows)],
    ['规则快照 JSON', JSON.stringify(info.config)],
    ['CSV 安全策略', '以电子表格打开可能被解释为公式的内容时，在原值前加单引号；XLSX 中所有单元格强制按文本写入。'],
  ]
}

function workbookXml(sheets: Sheet[]) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) =>
    `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`
}

/** 单次扫描固定核对结果，生成含汇总、分类明细和人工标注的 CSV ZIP 或 XLSX。 */
export async function writeCompareReport(inputPath: string, outputPath: string, workDir: string,
  format: 'zip' | 'xlsx', info: CompareReportInfo, signal?: AbortSignal) {
  await mkdir(workDir, { mode: 0o700 })
  const sheets: Sheet[] = []
  const latest = new Map<string, Sheet>()
  const header = ['明细行号', '分类', '字段状态', '键', '左侧行号', '右侧行号', '比较字段',
    '左原值', '右原值', '左规范化值', '右规范化值', '差值', '依据', '左组成员行', '右组成员行',
    '左侧上下文', '右侧上下文', '人工状态', '人工备注']
  const openSheet = async (category: string) => {
    if (sheets.length >= maxSheets) throw new CompareReportError('核对报告超过 200 个工作表，请下载完整 CSV 明细')
    const part = sheets.filter((sheet) => sheet.category === category).length + 1
    const name = category === 'summary' ? 'summary' : `${category}_${part}`
    const file = join(workDir, `sheet_${String(sheets.length + 1).padStart(3, '0')}.${format === 'zip' ? 'csv' : 'xml'}`)
    const stream = createWriteStream(file, { flags: 'wx', mode: 0o600 })
    const sheet = { name, file, stream, rows: 0, category }
    sheets.push(sheet)
    latest.set(category, sheet)
    if (format === 'xlsx') await write(stream, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>')
    await append(sheet, category === 'summary' ? ['项目', '值'] : header)
    return sheet
  }
  const append = async (sheet: Sheet, row: string[]) => {
    if (signal?.aborted) throw new CompareReportError('报告导出已取消')
    await write(sheet.stream, format === 'zip' ? csvLine(row) : sheetRow(row, sheet.rows + 1))
    sheet.rows += 1
  }
  const facts = reportFacts(info)
  const parser = parse({ bom: true, relax_quotes: false, relax_column_count: false, max_record_size: 8 * 1024 * 1024 })
  const source = createReadStream(inputPath, { signal })
  source.on('error', (error) => parser.destroy(error))
  source.pipe(parser)
  let scanned = 0
  let seenHeader = false
  const pending: { number: number; row: string[] }[] = []
  const flush = async () => {
    if (!pending.length) return
    const notes = info.annotations(pending.map((item) => item.number))
    for (const item of pending) {
      const category = item.row[0]!
      if (!categories.includes(category as typeof categories[number])) throw new CompareReportError('核对明细包含未知分类')
      let sheet = latest.get(category)
      if (!sheet || format === 'xlsx' && sheet.rows > excelRows) sheet = await openSheet(category)
      const oldCells = item.row.length === 10 ? [...item.row.slice(0, 8), '', '', ...item.row.slice(8), '', '']
        : item.row.length === 12 ? [...item.row, '', ''] : item.row
      const normalized = oldCells.length === 14 ? [...oldCells, '', ''] : oldCells
      const annotation = notes.get(item.number)
      await append(sheet, [String(item.number), labels[category]!, ...normalized.slice(1), annotation?.status ?? '', annotation?.note ?? ''])
    }
    pending.length = 0
  }
  try {
    const summarySheet = await openSheet('summary')
    for (const fact of facts) await append(summarySheet, fact)
    for await (const value of parser as AsyncIterable<string[]>) {
      if (!seenHeader) { seenHeader = true; continue }
      if (signal?.aborted) throw new CompareReportError('报告导出已取消')
      const row = value
      if (![10, 12, 14, 16].includes(row.length)) throw new CompareReportError('核对明细列数无效')
      scanned += 1
      pending.push({ number: scanned, row })
      if (pending.length >= 100) await flush()
    }
    await flush()
    if (!seenHeader || scanned !== info.summary.detailRows) throw new CompareReportError('核对明细行数与汇总不一致')
    for (const category of categories) if (!latest.has(category)) await openSheet(category)
    for (const sheet of sheets) {
      if (format === 'xlsx') await write(sheet.stream, '</sheetData></worksheet>')
      sheet.stream.end()
      await finished(sheet.stream)
    }
    const zip = new yazl.ZipFile()
    const mtime = new Date('1980-01-01T00:00:00Z')
    if (format === 'zip') {
      for (const sheet of sheets) zip.addFile(sheet.file, `${sheet.name}.csv`, { mtime, mode: 0o100600 })
    } else {
      const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`
      const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
      const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`
      zip.addBuffer(Buffer.from(contentTypes), '[Content_Types].xml', { mtime })
      zip.addBuffer(Buffer.from(rels), '_rels/.rels', { mtime })
      zip.addBuffer(Buffer.from(workbookXml(sheets)), 'xl/workbook.xml', { mtime })
      zip.addBuffer(Buffer.from(workbookRels), 'xl/_rels/workbook.xml.rels', { mtime })
      for (let index = 0; index < sheets.length; index += 1) zip.addFile(sheets[index]!.file,
        `xl/worksheets/sheet${index + 1}.xml`, { mtime, mode: 0o100600 })
    }
    zip.end()
    await pipeline(zip.outputStream, createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }), { signal })
    return { detailRows: scanned, sheets: sheets.length }
  } finally {
    source.destroy(); parser.destroy()
    for (const sheet of sheets) sheet.stream.destroy()
    await rm(workDir, { recursive: true, force: true })
  }
}
