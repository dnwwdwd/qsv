import { getLocale } from '@/ui/locale'
import { formatNumber } from '@/lib/format'

export function localizedExportFinding(value: string) {
  if (getLocale() !== 'en-US') return value
  if (value === '所有工作表按文本写入；已检查选定范围内每个单元格的长度。') return 'All workbook cells are written as text; every selected cell was checked for length.'
  let match = /^将创建 (\d+) 张工作表。$/u.exec(value)
  if (match) return `${formatNumber(Number(match[1]))} worksheets will be created.`
  if (value === '所有字段在 Parquet 中写为字符串；编号、长整数和原文本不会转为数值。') return 'All Parquet fields are strings; IDs, long integers and original text are not converted to numbers.'
  match = /^已检查 (\d+) 行的字段类型转换；(\d+) 个空文本将写为 null。$/u.exec(value)
  if (match) return `Checked field type conversions in ${formatNumber(Number(match[1]))} rows; ${formatNumber(Number(match[2]))} empty text values will become null.`
  match = /^逐行检查了编码；(\d+) 个可能被表格软件解释为公式的值将在导出副本中加文本前缀。$/u.exec(value)
  if (match) return `Checked encoding row by row; ${formatNumber(Number(match[1]))} formula-like values will receive a text prefix in the export.`
  match = /^逐行检查了编码；(\d+) 个值可能被表格软件解释为公式，当前未启用文本保护。$/u.exec(value)
  if (match) return `Checked encoding row by row; ${formatNumber(Number(match[1]))} values may be interpreted as formulas because text protection is off.`
  match = /^(.+) 超过 (XLSX|ODS) 的行列限制（已计入表头）$/u.exec(value)
  if (match) return `${match[1]} exceeds the ${match[2]} row or column limit, including the header.`
  match = /^(.+) 需要超过 20 张工作表；请增大每张工作表的行数或选择文本格式$/u.exec(value)
  if (match) return `${match[1]} needs more than 20 worksheets. Increase the rows per sheet or choose a text format.`
  return /[\p{Script=Han}]/u.test(value) ? 'The export check reported a problem. Review the selected data and format.' : value
}
