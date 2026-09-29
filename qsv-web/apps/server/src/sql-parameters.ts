export class SqlParameterError extends Error {}
export interface SqlParameterDefinition { name: string; type: 'text' | 'integer' | 'decimal' | 'date' }
export interface SqlParameters { definitions: SqlParameterDefinition[]; values: Record<string, string> }

function literal(value: string, type: SqlParameterDefinition['type']) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f\\]/u.test(value)) throw new SqlParameterError('SQL 参数值含不受支持的字符或过长')
  if (type === 'text') return `'${value.replaceAll("'", "''")}'`
  if (type === 'integer') {
    if (!/^-?(?:0|[1-9]\d{0,17})$/u.test(value)) throw new SqlParameterError('整数参数必须是最多 18 位的十进制整数')
    return value
  }
  if (type === 'decimal') {
    if (!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/u.test(value)) throw new SqlParameterError('小数参数格式或精度无效')
    return value
  }
  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new SqlParameterError('日期参数必须使用 YYYY-MM-DD')
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(0)
    date.setUTCFullYear(year!, month! - 1, day!); date.setUTCHours(0, 0, 0, 0)
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) throw new SqlParameterError('日期参数不是有效日历日期')
    return `'${value}'`
  }
  throw new SqlParameterError('SQL 参数类型无效')
}

/** 仅在 SQL 字符串和注释之外识别 {{name}}，并输出受类型约束的 SQL 字面量。 */
export function bindSqlParameters(template: string, parameters?: SqlParameters) {
  if (!parameters) {
    if (template.includes('{{') || template.includes('}}')) throw new SqlParameterError('SQL 含参数占位符，请填写参数类型和值')
    return template
  }
  if (typeof template !== 'string' || template.length < 1 || template.length > 8192 || !Array.isArray(parameters.definitions) ||
    parameters.definitions.length > 16 || !parameters.values || typeof parameters.values !== 'object' || Array.isArray(parameters.values)) {
    throw new SqlParameterError('SQL 参数配置无效')
  }
  const definitions = new Map<string, SqlParameterDefinition['type']>()
  for (const definition of parameters.definitions) {
    if (!definition || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/u.test(definition.name) ||
      !['text','integer','decimal','date'].includes(definition.type) || definitions.has(definition.name)) throw new SqlParameterError('SQL 参数名称或类型无效')
    definitions.set(definition.name, definition.type)
  }
  if (Object.keys(parameters.values).length !== definitions.size || [...definitions.keys()].some((name) => !Object.hasOwn(parameters.values, name))) {
    throw new SqlParameterError('SQL 参数值与定义不一致')
  }
  const used = new Set<string>()
  let output = '', state: 'normal' | 'single' | 'double' | 'line' | 'block' = 'normal'
  for (let i = 0; i < template.length;) {
    const pair = template.slice(i, i + 2)
    if (state === 'normal' && pair === '{{') {
      const end = template.indexOf('}}', i + 2)
      if (end < 0) throw new SqlParameterError('SQL 参数占位符未结束')
      const name = template.slice(i + 2, end)
      const type = definitions.get(name)
      if (!type) throw new SqlParameterError(`参数 ${name.slice(0, 32)} 未定义`)
      output += literal(parameters.values[name]!, type)
      used.add(name); i = end + 2; continue
    }
    if (state === 'normal' && pair === '--') { state = 'line'; output += pair; i += 2; continue }
    if (state === 'normal' && pair === '/*') { state = 'block'; output += pair; i += 2; continue }
    if (state === 'block' && pair === '*/') { state = 'normal'; output += pair; i += 2; continue }
    const char = template[i]!
    if (state === 'normal' && char === "'") state = 'single'
    else if (state === 'normal' && char === '"') state = 'double'
    else if (state === 'single' && char === "'") {
      if (template[i + 1] === "'") { output += "''"; i += 2; continue }
      state = 'normal'
    } else if (state === 'double' && char === '"') {
      if (template[i + 1] === '"') { output += '""'; i += 2; continue }
      state = 'normal'
    } else if (state === 'line' && char === '\n') state = 'normal'
    output += char; i += 1
  }
  if (used.size !== definitions.size) throw new SqlParameterError('存在未使用的 SQL 参数')
  if (output.includes('{{') || output.includes('}}')) throw new SqlParameterError('SQL 中存在字符串或注释内的参数占位符')
  if (output.length > 8192) throw new SqlParameterError('填入参数后的 SQL 超过长度限制')
  return output
}
