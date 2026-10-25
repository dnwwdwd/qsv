import {
  runCompare,
  GOLDEN_LEFT,
  GOLDEN_RIGHT,
  GOLDEN_CONFIG,
  GOLDEN_DUPLICATE_LEFT,
  GOLDEN_DUPLICATE_RIGHT,
  decimalDiff,
  parseDecimal,
} from './src/mock/compare.ts'

function show(label: string, output: ReturnType<typeof runCompare>) {
  console.log('=== ' + label + ' ===')
  console.log('overview', JSON.stringify(output.overview))
  console.log('balances', JSON.stringify(output.balances))
  console.log('details', output.details.map((d) => ({ cat: d.category, key: d.key, field: d.field, left: d.leftRaw, right: d.rightRaw, diff: d.diff, reason: d.reason })))
}

show('GOLDEN_CONFIG', runCompare(GOLDEN_LEFT, GOLDEN_RIGHT, GOLDEN_CONFIG))

// tolerance boundary demo: amount 100.004 vs 100.014
const tolLeft = { columns: ['订单号', 'SKU', '金额'], rows: [['A001', 'P1', '100.004']] }
const tolRight = { columns: ['订单号', 'SKU', '金额'], rows: [['A001', 'P1', '100.014']] }
const baseCfg = {
  leftKeys: ['订单号', 'SKU'],
  rightKeys: ['订单号', 'SKU'],
  fields: [{ leftColumn: '金额', rightColumn: '金额', label: '金额', type: 'decimal' as const, absoluteTolerance: '0.01' }],
  duplicatePolicy: 'quarantine' as const,
  keyNullPolicy: 'reject' as const,
  emptyPolicy: 'empty_equals_empty' as const,
}
show('tolerance 0.01', runCompare(tolLeft, tolRight, baseCfg))
show('tolerance 0.009', runCompare(tolLeft, tolRight, { ...baseCfg, fields: [{ leftColumn: '金额', rightColumn: '金额', label: '金额', type: 'decimal' as const, absoluteTolerance: '0.009' }] }))

// duplicate key demo
const dupCfg = {
  leftKeys: ['订单号', 'SKU'],
  rightKeys: ['订单号', 'SKU'],
  fields: [{ leftColumn: '金额', rightColumn: '金额', label: '金额', type: 'decimal' as const }],
  duplicatePolicy: 'quarantine' as const,
  keyNullPolicy: 'reject' as const,
  emptyPolicy: 'empty_equals_empty' as const,
}
show('duplicate left2 right1', runCompare(GOLDEN_DUPLICATE_LEFT, GOLDEN_DUPLICATE_RIGHT, dupCfg))

console.log('decimalDiff 100.004 vs 100.014 =', decimalDiff('100.004', '100.014'))
console.log('decimalDiff 100.014 vs 100.004 =', decimalDiff('100.014', '100.004'))
console.log('parseDecimal 0.01 =', JSON.stringify(parseDecimal('0.01'), (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v))
console.log('parseDecimal 0.010 =', JSON.stringify(parseDecimal('0.010'), (_, v) => typeof v === 'bigint' ? v.toString() + 'n' : v))
