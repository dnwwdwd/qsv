import { Parser } from 'node-sql-parser'

const parser = new Parser()
const options = { database: 'Postgresql' }
const allowedFunctions = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'ROUND', 'COALESCE', 'ABS', 'LOWER', 'UPPER', 'TRIM'])
const forbiddenTypes = new Set(['param', 'var_string', 'origin', 'insert', 'update', 'delete', 'drop', 'create', 'alter', 'replace', 'use'])

export class SqlValidationError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SqlValidationError('SQL 结构不受支持')
  return value as Record<string, unknown>
}

function nameOf(value: unknown): string {
  if (typeof value === 'string') return value
  const item = record(value)
  if (typeof item.value === 'string') return item.value
  throw new SqlValidationError('SQL 名称不受支持')
}

/** 只允许已绑定表或在同一语句中定义的 CTE；所有子查询都递归检查。 */
export function validateReadOnlySql(sql: string, tableNames: string[]) {
  if (typeof sql !== 'string' || sql.length < 1 || sql.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(sql)) {
    throw new SqlValidationError('SQL 长度或字符不符合要求')
  }
  let ast: unknown
  try { ast = parser.astify(sql, options) }
  catch { throw new SqlValidationError('SQL 语法无法解析') }
  if (Array.isArray(ast)) throw new SqlValidationError('每次只能执行一条 SELECT 查询')
  const seen = new WeakSet<object>()
  const visit = (value: unknown, available: Set<string>, depth: number): void => {
    if (value === null || typeof value !== 'object') return
    if (depth > 48) throw new SqlValidationError('SQL 嵌套过深')
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) { for (const item of value) visit(item, available, depth + 1); return }
    const node = value as Record<string, unknown>
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
    if (forbiddenTypes.has(type)) throw new SqlValidationError('SQL 包含不允许的语句或参数')
    if (type === 'function' || type === 'aggr_func') {
      const rawName = type === 'aggr_func' ? node.name : record(node.name).name
      const functionName = type === 'aggr_func' ? nameOf(rawName) : Array.isArray(rawName) ? rawName.map(nameOf).join('.') : nameOf(rawName)
      if (!allowedFunctions.has(functionName.toUpperCase())) throw new SqlValidationError(`函数 ${functionName} 不在允许列表中`)
    }
    if (type === 'select') {
      if (node.into != null || node.set_op != null || node._next != null || node.locking_read != null) {
        throw new SqlValidationError('查询包含不支持的输出、集合或锁定语法')
      }
      const local = new Set(available)
      if (node.with != null) {
        if (!Array.isArray(node.with) || node.with.length > 8) throw new SqlValidationError('CTE 数量超过限制')
        for (const cte of node.with) {
          const definition = record(cte)
          const cteName = nameOf(definition.name)
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(cteName) || local.has(cteName.toLowerCase())) {
            throw new SqlValidationError('CTE 名称无效或重复')
          }
          const statement = record(definition.stmt)
          visit(statement.ast ?? statement, local, depth + 1)
          local.add(cteName.toLowerCase())
        }
      }
      if (!Array.isArray(node.from) || node.from.length < 1 || node.from.length > 8) throw new SqlValidationError('查询必须引用已绑定的数据表')
      for (const source of node.from) {
        const table = record(source)
        if (table.db != null || typeof table.table !== 'string' || !local.has(table.table.toLowerCase())) {
          throw new SqlValidationError('SQL 只能读取当前任务绑定的数据表')
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== 'with' && key !== 'from') visit(child, local, depth + 1)
      }
      for (const source of node.from) {
        const table = record(source)
        if (table.on != null) visit(table.on, local, depth + 1)
      }
      return
    }
    for (const child of Object.values(node)) visit(child, available, depth + 1)
  }
  visit(ast, new Set(tableNames.map((name) => name.toLowerCase())), 0)
  try { return parser.sqlify(ast as Parameters<Parser['sqlify']>[0], options) }
  catch { throw new SqlValidationError('SQL 无法转换为受控查询') }
}
