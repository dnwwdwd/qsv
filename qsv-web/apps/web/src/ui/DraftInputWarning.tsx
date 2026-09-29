import { Banner } from './Feedback'
import { useT } from './locale'

export function DraftInputWarning({ ids, availableIds, loading }: {
  ids: string[]; availableIds: string[]; loading: boolean
}) {
  const t = useT()
  if (loading) return null
  const available = new Set(availableIds)
  const missing = [...new Set(ids.filter((id) => id && !available.has(id)))]
  if (!missing.length) return null
  return <Banner tone="warn">{t(`已保存的配置引用了 ${missing.length} 个当前不可选的数据集。原选择已保留，请重新选择输入并检查字段设置后再提交。`, `The saved settings refer to ${missing.length} dataset(s) that are no longer available. The original selection has been kept. Select valid inputs and check field settings before submitting.`)}</Banner>
}
