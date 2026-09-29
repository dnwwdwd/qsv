/** 菜单分组：按用户要做的事分组，而不是按 qsv 命令分组 */
import type { Locale } from '@/ui/locale'

export interface NavItem {
  id: string
  /** PRD 页面编号，界面上保留编号便于与需求文档对照 */
  code: string
  label: string
  path: string
  description: string
  keyword: string
  input?: string
  output?: string
  limit?: string
  /** 图标名：收成图标栏时使用（见 AppShell 的 NAV_ICON 映射） */
  icon: string
}

export interface NavGroup {
  id: string
  label: string
  hint: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'start',
    label: '开始',
    hint: '找到要做的事',
    items: [
      {
        id: 'home',
        code: 'P01',
        label: '概览',
        path: '/',
        description: '查看当前空间状态、需处理任务和最近活动',
        keyword: '首页 概览 状态 最近 任务 资源',
        icon: 'LayoutDashboard',
      },
    ],
  },
  {
    id: 'data',
    label: '数据',
    hint: '导入与浏览',
    items: [
      {
        id: 'resources',
        code: 'P02',
        label: '文件与数据集',
        path: '/resources',
        description: '查看原文件和数据集，下载原文件',
        keyword: '文件 数据集 资源 版本 删除 恢复',
        icon: 'Database',
      },
      {
        id: 'import',
        code: 'P03',
        label: '导入与解析',
        path: '/import',
        description: '上传并解析文件，建立可浏览的数据集',
        keyword: '导入 上传 解析 sheet 编码 表头 预览',
        input: '本机 CSV/TSV、工作簿、JSON/JSONL、Parquet',
        output: '原文件与数据集',
        limit: '文件大小以设置页上限为准',
        icon: 'FileUp',
      },
    ],
  },
  {
    id: 'transform',
    label: '处理',
    hint: '改变数据内容',
    items: [
      {
        id: 'clean',
        code: 'P05',
        label: '清洗与转换规则',
        path: '/clean',
        description: '全表文本、Unicode、日期清洗与按键去重',
        keyword: '清洗 去空格 空值 日期 数值 去重 字段 过滤',
        input: '1 份可用数据集',
        output: '新数据集与处理报告',
        limit: '样本试跑与全表任务分开',
        icon: 'Wand2',
      },
      {
        id: 'convert',
        code: 'P06',
        label: '格式转换与导出',
        path: '/convert',
        description: '导出完整数据集为 CSV、TSV、工作簿、JSON 或 Parquet',
        keyword: '转换 导出 格式 csv excel json parquet',
        input: '1 至 20 份可用数据集',
        output: 'CSV、TSV、工作簿、JSON 或 Parquet 文件',
        limit: '提交前检查所选格式和范围',
        icon: 'Repeat',
      },
      {
        id: 'join',
        code: 'P07',
        label: '合并、关联与集合',
        path: '/join',
        description: '纵横合并、按键关联和集合运算',
        keyword: '合并 关联 join 交集 差集 并集 多对多',
        input: '合并 2 至 20 份；关联或集合 2 份',
        output: '新数据集与可用的未匹配清单',
        limit: '关联先检查完整匹配键与预计行数',
        icon: 'Combine',
      },
      {
        id: 'split',
        code: 'P08',
        label: '拆分与重组',
        path: '/split',
        description: '拆分文件、分隔字段、组合记录或转置',
        keyword: '拆分 分割 展开 合并列 转置 打包',
        input: '数据集或已上传工作簿',
        output: '拆分文件包或新数据集',
        limit: '文件拆分最多 1000 份',
        icon: 'Scissors',
      },
    ],
  },
  {
    id: 'compare',
    label: '核对',
    hint: '双表差异',
    items: [
      {
        id: 'compare-config',
        code: 'P09',
        label: '双表核对配置',
        path: '/compare',
        description: '复合键匹配、文本比较与十进制容差核对',
        keyword: '核对 对账 差异 键 容差 映射 预检',
        input: '2 份可用数据集',
        output: '分类明细与核对报告',
        limit: '正式运行前检查全部匹配键',
        icon: 'SlidersHorizontal',
      },
      {
        id: 'compare-result',
        code: 'P10',
        label: '双表核对结果',
        path: '/compare/result',
        description: '查看核对分类、数量守恒与完整明细',
        keyword: '核对结果 明细 键冲突 仅左 仅右 报告',
        icon: 'GitCompareArrows',
      },
    ],
  },
  {
    id: 'quality',
    label: '质量与分析',
    hint: '看清数据',
    items: [
      {
        id: 'validate',
        code: 'P11',
        label: '数据质量检查',
        path: '/quality',
        description: '设置规则并扫描全表，查看异常行与报告',
        keyword: '质检 校验 规则 唯一性 必填 跨字段',
        input: '1 份数据集，可附固定参考数据',
        output: '检查报告或有效/异常记录副本',
        limit: '样本检查与全表检查分开',
        icon: 'ShieldCheck',
      },
      {
        id: 'analyze',
        code: 'P12',
        label: '统计与透视',
        path: '/analyze',
        description: '逐字段统计、频率、分组汇总和透视',
        keyword: '统计 汇总 透视 分组 图表 频率',
        input: '1 份可用数据集',
        output: '统计、聚合或透视结果数据集',
        limit: '高基数结果只展示有界范围',
        icon: 'BarChart3',
      },
      {
        id: 'sql',
        code: 'P13',
        label: 'SQL 查询',
        path: '/sql',
        description: '绑定本人数据集并执行受限 SELECT 查询',
        keyword: 'sql 查询 select 聚合 视图',
        input: '1 至 4 份本人数据集',
        output: '可浏览的新数据集',
        limit: '只接受受限 SELECT/CTE 查询',
        icon: 'Braces',
      },
    ],
  },
  {
    id: 'automation',
    label: '自动化',
    hint: '重复执行与查看',
    items: [
      {
        id: 'recipes',
        code: 'P14',
        label: '模板与流程',
        path: '/recipes',
        description: '保存任务规则，替换输入并逐组运行',
        keyword: '模板 流程 复用 批处理 参数 试跑',
        input: '已有工具规则与可用数据集',
        output: '按组保存的任务与多个指定结果',
        limit: '正式批量运行前检查并试跑样本',
        icon: 'ListChecks',
      },
      {
        id: 'jobs',
        code: 'P15',
        label: '任务与结果',
        path: '/jobs',
        description: '查看各类任务，取消、重试及下载结果',
        keyword: '任务 队列 进度 取消 重试 日志 下载',
        icon: 'Activity',
      },
    ],
  },
  {
    id: 'system',
    label: '系统',
    hint: '空间与设置',
    items: [
      {
        id: 'settings',
        code: 'P16',
        label: '设置、空间与关于',
        path: '/settings',
        description: '查看当前空间、已登记文件和引擎状态',
        keyword: '设置 空间 配额 清理 版本 引擎 关于',
        icon: 'Settings2',
      },
    ],
  },
]

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items)

const GROUP_EN: Record<string, { label: string; hint: string }> = {
  start: { label: 'Start', hint: 'Find what to do' }, data: { label: 'Data', hint: 'Import and browse' },
  transform: { label: 'Process', hint: 'Change data' }, compare: { label: 'Compare', hint: 'Find differences' },
  quality: { label: 'Quality and analysis', hint: 'Understand data' },
  automation: { label: 'Automation', hint: 'Repeat work and inspect results' },
  system: { label: 'System', hint: 'Workspace and settings' },
}

const ITEM_EN: Record<string, Partial<Pick<NavItem, 'label' | 'description' | 'keyword' | 'input' | 'output' | 'limit'>>> = {
  home: { label: 'Overview', description: 'See workspace status, tasks needing attention, and recent activity', keyword: 'home overview status recent tasks resources' },
  resources: { label: 'Files and datasets', description: 'Browse source files and datasets, and download files', keyword: 'files datasets resources versions delete restore' },
  import: { label: 'Import and parse', description: 'Upload and parse files into browsable datasets', keyword: 'import upload parse sheet encoding header preview', input: 'Local CSV/TSV, workbooks, JSON/JSONL, or Parquet', output: 'Source file and dataset', limit: 'File size follows the limit in Settings' },
  clean: { label: 'Clean and transform', description: 'Clean text, Unicode and dates, and remove duplicate keys across all rows', keyword: 'clean whitespace null date number deduplicate columns filter', input: 'One available dataset', output: 'New dataset and processing report', limit: 'Sample trial and full run are separate' },
  convert: { label: 'Convert and export', description: 'Export complete datasets as CSV, TSV, workbook, JSON, or Parquet', keyword: 'convert export format csv excel json parquet', input: 'One to 20 available datasets', output: 'CSV, TSV, workbook, JSON, or Parquet file', limit: 'Check the selected format and range before running' },
  join: { label: 'Combine and join', description: 'Combine tables by rows or columns, join by key, or compare sets', keyword: 'combine join intersection difference union many-to-many', input: 'Two to 20 for combine; two for joins or sets', output: 'New dataset and available unmatched reports', limit: 'Check every join key and estimated row count first' },
  split: { label: 'Split and reshape', description: 'Split files, split columns, combine records, or transpose', keyword: 'split reshape transpose package', input: 'Dataset or uploaded workbook', output: 'Split file package or new dataset', limit: 'At most 1,000 split files' },
  'compare-config': { label: 'Compare two datasets', description: 'Match composite keys and compare text or decimal values', keyword: 'compare reconcile difference key tolerance mapping preflight', input: 'Two available datasets', output: 'Classified differences and comparison report', limit: 'Check all matching keys before the full run' },
  'compare-result': { label: 'Comparison results', description: 'Inspect categories, count reconciliation, and full details', keyword: 'comparison results details key conflicts left only right only report' },
  validate: { label: 'Data quality checks', description: 'Define rules and scan all rows for failures', keyword: 'quality validate rule unique required cross-field', input: 'One dataset, optionally with reference data', output: 'Check report or valid/invalid copies', limit: 'Sample and full checks are separate' },
  analyze: { label: 'Statistics and pivot', description: 'Column statistics, frequencies, grouped summaries, and pivots', keyword: 'statistics aggregate pivot group chart frequency', input: 'One available dataset', output: 'Statistics, grouped, or pivot dataset', limit: 'High-cardinality results show a bounded range' },
  sql: { label: 'SQL query', description: 'Bind your datasets and run a restricted SELECT query', keyword: 'sql query select aggregate view', input: 'One to four of your datasets', output: 'New browsable dataset', limit: 'Only restricted SELECT/CTE queries' },
  recipes: { label: 'Templates and pipelines', description: 'Save task rules, replace inputs, and run groups', keyword: 'template pipeline reuse batch parameters trial', input: 'Existing tool rules and available datasets', output: 'Tasks and selected results saved per group', limit: 'Check and trial samples before a full batch run' },
  jobs: { label: 'Tasks and results', description: 'Inspect, cancel, retry, and download tasks', keyword: 'jobs queue progress cancel retry logs download' },
  settings: { label: 'Settings and workspace', description: 'Inspect your workspace, stored files, and engine status', keyword: 'settings workspace quota cleanup version engine about' },
}

export function localizeNavItem(item: NavItem, locale: Locale): NavItem {
  const copy = ITEM_EN[item.id]
  return locale === 'en-US' && copy ? { ...item, ...copy, keyword: `${item.keyword} ${copy.keyword ?? ''}` }
    : { ...item, keyword: `${item.keyword} ${copy?.keyword ?? ''}` }
}

export function localizedNavGroups(locale: Locale): NavGroup[] {
  return NAV_GROUPS.map((group) => ({ ...group, ...(locale === 'en-US' ? GROUP_EN[group.id] ?? {} : {}),
    items: group.items.map((item) => localizeNavItem(item, locale)) }))
}

export function findNavItem(pathname: string): NavItem | undefined {
  if (pathname.startsWith('/datasets/')) return NAV_ITEMS.find((item) => item.id === 'resources')
  const exact = NAV_ITEMS.find((item) => item.path === pathname)
  if (exact) return exact
  return NAV_ITEMS.filter((item) => item.path !== '/' && pathname.startsWith(`${item.path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0]
}

export function activeNavId(pathname: string): string | undefined {
  return findNavItem(pathname)?.id
}

export function groupOfNavItem(id: string): NavGroup | undefined {
  return NAV_GROUPS.find((group) => group.items.some((item) => item.id === id))
}
