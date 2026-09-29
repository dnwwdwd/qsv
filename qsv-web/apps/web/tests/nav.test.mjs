import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NAV_ITEMS, activeNavId } from '../src/shell/nav.ts'

test('navigation IDs are unique and only one compare item is active', () => {
  assert.equal(new Set(NAV_ITEMS.map((item) => item.id)).size, NAV_ITEMS.length)
  assert.equal(activeNavId('/compare'), 'compare-config')
  assert.equal(activeNavId('/compare/result'), 'compare-result')
  assert.equal(activeNavId('/compare/result/details'), 'compare-result')
  assert.equal(activeNavId('/datasets/res_example'), 'resources')
  assert.equal(activeNavId('/compare-other'), undefined)
})
