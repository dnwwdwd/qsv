import { createHash } from 'node:crypto'

export const ORDERS_EXAMPLE_NAME = '[内置示例] 订单.csv'
export const ORDERS_EXAMPLE_UPLOAD_KEY = 'builtin_orders_v1_upload'
export const ORDERS_EXAMPLE_IMPORT_KEY = 'builtin_orders_v1_import'
export const ORDERS_EXAMPLE_CONTENT = Buffer.from([
  'order_id,month,category,quantity,amount,status',
  'EX-001,2026-01,文具,2,19.80,已完成',
  'EX-002,2026-01,图书,1,42.00,已完成',
  'EX-003,2026-02,文具,3,12.50,待处理',
  'EX-004,2026-02,电子配件,1,89.00,已完成',
  '',
].join('\n'), 'utf8')
export const ORDERS_EXAMPLE_HASH = `sha256:${createHash('sha256').update(ORDERS_EXAMPLE_CONTENT).digest('hex')}`
