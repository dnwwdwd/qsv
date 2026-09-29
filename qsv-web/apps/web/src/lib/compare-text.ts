import { getLocale } from '@/ui/locale'

const REASONS_EN: Record<string, string> = {
  '复合键含空值': 'Combined key contains an empty value',
  '右侧无此键；左侧组保留全部来源行': 'Key absent on the right; all left group source rows retained',
  '左侧无此键；右侧组保留全部来源行': 'Key absent on the left; all right group source rows retained',
  '左侧复合键重复': 'Duplicate combined key on the left',
  '右侧复合键重复': 'Duplicate combined key on the right',
  '至少一侧复合键重复': 'Duplicate combined key on at least one side',
  '两侧复合键均重复': 'Duplicate combined keys on both sides',
  '左侧复合键重复，右侧成员受影响': 'Duplicate combined key on the left; right-side members are also affected',
  '右侧复合键重复，左侧成员受影响': 'Duplicate combined key on the right; left-side members are also affected',
  '比较字段含空值，按所选规则归为解析异常': 'A compared field is empty; classified as a parse error by the selected rule',
  '两侧均为空值，按所选规则视为一致': 'Both compared values are empty; treated as equal by the selected rule',
  '只有一侧为空值，按所选规则视为差异': 'Only one compared value is empty; treated as different by the selected rule',
  '数值不是受支持的十进制文本': 'Value is not supported decimal text',
  '日历日期必须为有效的 YYYY-MM-DD': 'Calendar date must be a valid YYYY-MM-DD value',
  '时间点必须带 Z 或 ±HH:MM 时区偏移': 'Instant must include Z or a ±HH:MM time zone offset',
  '时间点须带明确偏移，或指定有效且唯一的本地时区时间': 'Instant needs an explicit offset or an unambiguous local time in the selected time zone',
}

export function localizedCompareState(value: string) {
  if (getLocale() !== 'en-US') return value
  return ({ equal: 'Equal', different: 'Different', error: 'Parse error' } as Record<string, string>)[value] ?? value
}

export function localizedCompareReason(reason: string): string {
  if (getLocale() !== 'en-US' || !reason) return reason
  const aggregated = /^按 (SUM|COUNT) 聚合；左侧来源行 ([\d,]+)；右侧来源行 ([\d,]+)；(.+)$/u.exec(reason)
  if (aggregated) return `Aggregated by ${aggregated[1]}; left source rows ${aggregated[2]}; right source rows ${aggregated[3]}; ${localizedCompareReason(aggregated[4]!)}`
  if (REASONS_EN[reason]) return REASONS_EN[reason]
  let match = /^文本比较；首尾空白(忽略|保留)，大小写(忽略|区分)，Unicode (none|NFC|NFKC)$/u.exec(reason)
  if (match) return `Text comparison; ${match[1] === '忽略' ? 'ignore' : 'preserve'} leading and trailing spaces; ${match[2] === '忽略' ? 'ignore' : 'respect'} case; Unicode ${match[3]}`
  match = /^绝对差值 ≤ (.+)，或 ≤ (.+) × max\(\|左值\|,\|右值\|\)；两值均为零时相对容差为零$/u.exec(reason)
  if (match) return `Absolute difference ≤ ${match[1]}, or ≤ ${match[2]} × max(|left|, |right|); relative tolerance is zero when both values are zero`
  match = /^相差日历日不超过 (\d+) 天$/u.exec(reason)
  if (match) return `Calendar-day difference ≤ ${match[1]}`
  match = /^按 UTC 时间点比较，相差不超过 (\d+) 秒$/u.exec(reason)
  if (match) return `Compared as UTC instants; difference ≤ ${match[1]} seconds`
  match = /^按 UTC 时间点比较，相差不超过 (\d+) 秒；无偏移输入时区：左 (.+)，右 (.+)$/u.exec(reason)
  if (match) return `Compared as UTC instants; difference ≤ ${match[1]} seconds; local input time zones: left ${match[2] === '未设置' ? 'not set' : match[2]}, right ${match[3] === '未设置' ? 'not set' : match[3]}`
  return /[\p{Script=Han}]/u.test(reason) ? 'Comparison rule or data issue; inspect the saved rule and source rows' : reason
}
