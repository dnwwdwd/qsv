import { getLocale } from '@/ui/locale'

const ENGLISH_STAGES: Record<string, string> = {
  '排队中': 'Queued',
  '正在停止': 'Stopping',
  '排队中取消': 'Cancelled while queued',
  '服务停止，任务已中断': 'Service stopped; job interrupted',
  '文件已写入，等待恢复检查': 'File written; awaiting recovery check',
  '已中断': 'Interrupted',
  '已取消': 'Cancelled',
  '失败': 'Failed',
  '完成': 'Completed',
  '提交各组任务': 'Submitting group jobs',
  '全部组完成': 'All groups completed',
  '按完整记录拆分': 'Splitting complete records',
  '打包拆分文件': 'Packaging split files',
  '检查全部记录': 'Checking all records',
  '建立报告索引': 'Indexing report',
  '统计全部记录': 'Analyzing all records',
  '建立统计结果索引': 'Indexing analysis result',
  '扫描输入并执行 SQL': 'Scanning inputs and executing SQL',
  '建立查询结果索引': 'Indexing query result',
  '检查全部匹配键': 'Checking all match keys',
  '排序并检查重复键': 'Sorting and checking duplicate keys',
  '计算预计分类和差异样本': 'Calculating expected categories and difference samples',
  '全量预检完成': 'Full preliminary check completed',
  '准备复合键': 'Preparing composite keys',
  '外排序全部记录': 'Sorting all records',
  '逐组核对': 'Comparing groups',
  '建立结果索引': 'Indexing result',
  '合并全部记录': 'Combining all records',
  '写出完整数据': 'Writing complete data',
  '检查工作簿单元格长度': 'Checking workbook cell lengths',
  '按键排序并去重': 'Sorting keys and removing duplicates',
  '清洗全部记录': 'Cleaning all records',
  '生成修正版本': 'Creating corrected version',
  '扫描全部记录': 'Scanning all records',
  '校验 CSV': 'Validating CSV',
  '复制原文件': 'Copying original file',
  '按配置解析 CSV': 'Parsing CSV with selected settings',
  '按配置解析 JSON': 'Parsing JSON with selected settings',
  '读取 Parquet 列': 'Reading Parquet columns',
  '读取工作表': 'Reading workbook sheet',
  '建立索引': 'Building index',
  '检查已选字段类型': 'Checking selected field types',
  '正在解析文件，首批数据尚未写入': 'Parsing file; first rows are not available yet',
  '数据集已可用': 'Dataset is ready',
  '文件已解析，索引仍在建立': 'File parsed; index is still building',
}

export function localizedStage(stage: string | null | undefined): string {
  if (!stage) return getLocale() === 'en-US' ? 'Unknown' : '未知'
  if (getLocale() !== 'en-US') return stage
  const batchRunning = /^(\d+) 组完成，(\d+) 组仍在运行$/.exec(stage)
  if (batchRunning) return `${batchRunning[1]} groups completed, ${batchRunning[2]} still running`
  const batchFailed = /^(\d+) 组成功，(\d+) 组失败$/.exec(stage)
  if (batchFailed) return `${batchFailed[1]} groups succeeded, ${batchFailed[2]} failed`
  return ENGLISH_STAGES[stage] ?? 'Processing'
}
