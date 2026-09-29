/** 有界的正则子集：字符、字符类和精确重复次数。不接受回溯型量词、分组或引用。 */
export class PatternError extends Error {}
type Token = { matcher: RegExp; repeat: number }

export function compileSafePattern(raw: string) {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 160) throw new PatternError('表达式长度需在 1 至 160 字符之间')
  let pattern = raw
  if (pattern.startsWith('^')) pattern = pattern.slice(1)
  if (pattern.endsWith('$')) pattern = pattern.slice(0, -1)
  const tokens: Token[] = []
  let expanded = 0
  for (let i = 0; i < pattern.length;) {
    let atom: string
    if (pattern[i] === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end < 0 || end - i > 64) throw new PatternError('字符类未结束或过长')
      atom = pattern.slice(i, end + 1)
      if (!/^\[[A-Za-z0-9_\-\\d\\w\\s]+\]$/u.test(atom)) throw new PatternError('字符类只支持字母、数字、下划线、连字符及 \\d/\\w/\\s')
      i = end + 1
    } else if (pattern[i] === '\\') {
      const next = pattern[i + 1]
      if (!next || !'dws.-_@+#/'.includes(next)) throw new PatternError('转义字符不受支持')
      atom = `\\${next}`
      i += 2
    } else {
      const char = Array.from(pattern.slice(i))[0]!
      if ('*+?(){}|^$'.includes(char)) throw new PatternError('只支持精确重复 {次数}，不支持分组和可变次数')
      atom = /[.\\[\]]/u.test(char) ? `\\${char}` : char
      i += char.length
    }
    let repeat = 1
    if (pattern[i] === '{') {
      const match = /^\{(\d{1,3})\}/u.exec(pattern.slice(i))
      if (!match) throw new PatternError('重复次数格式应为 {整数}')
      repeat = Number(match[1])
      if (repeat < 1 || repeat > 256) throw new PatternError('单段重复次数最多 256')
      i += match[0].length
    }
    expanded += repeat
    if (tokens.length >= 64 || expanded > 1024) throw new PatternError('表达式超过 64 段或 1024 字符上限')
    try { tokens.push({ matcher: new RegExp(`^(?:${atom})$`, 'u'), repeat }) }
    catch { throw new PatternError('字符类格式无效') }
  }
  if (!tokens.length) throw new PatternError('表达式不能为空')
  return (value: string) => {
    const characters = Array.from(value)
    if (characters.length !== expanded) return false
    let at = 0
    for (const token of tokens) for (let count = 0; count < token.repeat; count += 1) {
      if (!token.matcher.test(characters[at++]!)) return false
    }
    return true
  }
}

export function validSafePattern(raw: string) {
  try { compileSafePattern(raw); return true } catch { return false }
}
