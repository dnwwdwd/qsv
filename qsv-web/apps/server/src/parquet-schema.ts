import { asyncBufferFromFile, parquetMetadataAsync, parquetSchema } from 'hyparquet'

export class ParquetSchemaError extends Error {}

export interface ParquetColumn {
  name: string
  physical: string
  logical: string | null
  nullable: boolean
}

/** 只接受可表示为单层表格的 Parquet 字段；嵌套结构必须另选明确策略。 */
export async function readFlatParquetSchema(path: string): Promise<ParquetColumn[]> {
  let tree: ReturnType<typeof parquetSchema>
  try { tree = parquetSchema(await parquetMetadataAsync(await asyncBufferFromFile(path))) }
  catch { throw new ParquetSchemaError('Parquet 元数据无法读取或文件已损坏') }
  if (!tree.children.length || tree.children.length > 4096) throw new ParquetSchemaError('Parquet 字段数无效')
  const columns: ParquetColumn[] = []
  for (const child of tree.children) {
    const field = child.element
    if (child.children.length || !field.type || field.repetition_type === 'REPEATED' ||
      field.logical_type?.type === 'LIST' || field.logical_type?.type === 'MAP' || field.logical_type?.type === 'VARIANT') {
      throw new ParquetSchemaError(`字段“${field.name}”含嵌套或重复结构；当前导入尚无对应的展开或字符串化规则`)
    }
    if (field.type === 'INT96' || field.type === 'FIXED_LEN_BYTE_ARRAY' ||
      field.type === 'BYTE_ARRAY' && !['STRING', 'JSON', 'ENUM'].includes(field.logical_type?.type ?? '') &&
        !['UTF8', 'JSON', 'ENUM'].includes(field.converted_type ?? '')) {
      throw new ParquetSchemaError(`字段“${field.name}”的二进制或旧时间类型没有已确认的无损文本转换规则`)
    }
    if (field.name.length > 4096 || /[\x00-\x1f\x7f]/u.test(field.name)) {
      throw new ParquetSchemaError('Parquet 字段名无效')
    }
    columns.push({ name: field.name, physical: field.type,
      logical: field.logical_type?.type ?? field.converted_type ?? null,
      nullable: field.repetition_type !== 'REQUIRED' })
  }
  return columns
}
