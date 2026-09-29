import type { CompareConfig, CompareField } from './compare.ts'
import type { QualityRule } from './quality.ts'
import type { SplitConfig } from './split.ts'
import type { ViewPlan, FilterCondition } from './view-operation.ts'
import type { AggregateConfig, AggregateMeasure } from './aggregate.ts'
import type { RelationConfig } from './relation.ts'
import type { SetConfig } from './set-operation.ts'
import type { ReshapeConfig } from './reshape.ts'
import { compileSafePattern, PatternError } from './safe-pattern.ts'
import type { PivotConfig } from './pivot.ts'
import { validateCleanPlan, type CleanPlan, type CleanStep } from './clean-plan.ts'
import type { SqlParameterDefinition } from './sql-parameters.ts'
import { validateTextExportOptions, type TextExportOptions, type JsonExportOptions } from './export.ts'
import type { ExportScope } from './export-scope.ts'
import { validIanaTimeZone } from './transform.ts'

type NamedViewPlan = { combine: ViewPlan['combine']; conditions: Array<Omit<FilterCondition, 'columnId'> & { column: string }>;
  sorts: Array<Omit<ViewPlan['sorts'][number], 'columnId'> & { column: string }>;
  groups?: { combine: ViewPlan['combine']; conditions: Array<Omit<FilterCondition, 'columnId'> & { column: string }> }[] }
type NamedAggregate = { groupColumns: string[]; measures: Array<Omit<AggregateMeasure, 'columnId'> & { column?: string }> }
type NamedPivot = { rowColumn: string; pivotColumn: string;
  measure: Omit<AggregateMeasure, 'columnId'> & { column?: string } }
type NamedCompareField = Omit<CompareField, 'leftColumnId' | 'rightColumnId'> & { left: string; right: string }
type NamedReshape = { kind: 'split-column'; column: string; delimiter: string; direction: 'columns' | 'rows'; maxParts: number;
  keepEmpty: boolean; overflow: 'error' | 'join-last' } | { kind: 'group-join'; keys: string[]; value: string; separator: string } | { kind: 'transpose' }

type NamedQualityRule = { kind: 'required'; column: string } | { kind: 'length'; column: string; min: number; max: number } |
  { kind: 'enum'; column: string; values: string[] } | { kind: 'type'; column: string; dataType: 'integer' | 'decimal' | 'date' } |
  { kind: 'range'; column: string; min: string; max: string } | { kind: 'date-order'; column: string; otherColumn: string } |
  { kind: 'pattern'; column: string; pattern: string } |
  { kind: 'arithmetic'; column: string; leftColumn: string; rightColumn: string; tolerance: string } |
  { kind: 'reference'; column: string; referenceInput: number; referenceColumn: string } |
  { kind: 'unique'; columns: string[] }

export type SingleRecipeSpec =
  | { version: 1; operation: 'filter'; column: string; mode: 'equals' | 'contains'; value: string }
  | { version: 1; operation: 'filter-plan'; plan: NamedViewPlan }
  | { version: 1; operation: 'clean'; column: string; mode: 'trim' | 'squeeze' | 'squeeze0' | 'lower' | 'upper' | 'replace' | 'fill-empty' | 'nfc' | 'nfkc' | 'date-iso'; find: string; replacement: string; dateFormat: 'yyyy-MM-dd' | 'yyyy/MM/dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy' }
  | { version: 1; operation: 'clean-plan'; plan: { steps: Record<string, unknown>[] } }
  | { version: 1; operation: 'dedup'; columns: string[] }
  | { version: 1; operation: 'quality'; rules: NamedQualityRule[]; outputMode: 'report' | 'valid' | 'invalid' }
  | { version: 1; operation: 'analyze'; aggregate?: NamedAggregate; pivot?: NamedPivot; frequencyColumn?: string }
  | { version: 1; operation: 'split'; config: ({ mode: 'rows'; size: number } | { mode: 'value'; column: string }) & { includeHeader?: boolean } }
  | { version: 1; operation: 'export'; format: 'csv' | 'tsv' | 'xlsx' | 'ods' | 'json' | 'jsonl' | 'parquet'; safeText: boolean;
    textOptions?: TextExportOptions; jsonOptions?: JsonExportOptions; outputName?: string;
    workbook?: { sheetNames: string[]; rowsPerSheet?: number }; scope?: { startRow: number; endRow: number; columns: string[] } }
  | { version: 1; operation: 'combine'; mode: 'strict' | 'union' | 'intersection' | 'horizontal-pad' | 'horizontal-error'; inputCount: number }
  | { version: 1; operation: 'relation'; config: { kind: RelationConfig['kind']; leftKeys: string[]; rightKeys: string[];
    cardinality: RelationConfig['cardinality']; keyType?: RelationConfig['keyType']; matchEmptyKeys?: boolean; trimKeys?: boolean; ignoreCase?: boolean;
    unicodeNormalization?: RelationConfig['unicodeNormalization'];
    output?: { columns: { side: 'left' | 'right'; name: string }[]; leftSuffix: string; rightSuffix: string;
      includeSourceRows: boolean } } }
  | { version: 1; operation: 'set'; config: { kind: SetConfig['kind']; leftKeys: string[]; rightKeys: string[] } }
  | { version: 1; operation: 'reshape'; config: NamedReshape }
  | { version: 1; operation: 'sql'; sql: string; inputCount: number; requiredHeaders: string[][];
    parameterDefinitions?: SqlParameterDefinition[] }
  | { version: 1; operation: 'compare'; config: {
    leftKeys: string[]; rightKeys: string[]; fields: NamedCompareField[];
    trimKeys: boolean; ignoreKeyCase: boolean;
    leftLabel?: string; rightLabel?: string;
    duplicatePolicy?: CompareConfig['duplicatePolicy']; aggregateMethods?: CompareConfig['aggregateMethods'];
    emptyValuePolicy?: CompareConfig['emptyValuePolicy']; parseFailurePolicy?: CompareConfig['parseFailurePolicy'];
    contextLeft?: string[]; contextRight?: string[]
  } }

export type RecipeRef = `input:${number}` | `step:${string}`
export interface PipelineRecipeSpec {
  version: 1
  operation: 'pipeline'
  inputs: { name: string; requiredHeaders: string[] }[]
  steps: { id: string; enabled?: boolean; inputs: RecipeRef[]; rule: SingleRecipeSpec }[]
  output: RecipeRef
  outputs?: RecipeRef[]
}
export type RecipeSpec = SingleRecipeSpec | PipelineRecipeSpec

export type BoundRecipe =
  | (Extract<SingleRecipeSpec, { operation: 'filter' }> & { columnId: string })
  | { version: 1; operation: 'filter-plan'; plan: ViewPlan }
  | (Extract<SingleRecipeSpec, { operation: 'clean' }> & { columnId: string })
  | { version: 1; operation: 'clean-plan'; plan: CleanPlan }
  | (Extract<SingleRecipeSpec, { operation: 'dedup' }> & { columnIds: string[] })
  | (Omit<Extract<SingleRecipeSpec, { operation: 'quality' }>, 'rules'> & { operation: 'quality'; rules: QualityRule[] })
  | (Omit<Extract<SingleRecipeSpec, { operation: 'split' }>, 'config'> & { operation: 'split'; config: SplitConfig })
  | { version: 1; operation: 'analyze'; aggregate?: AggregateConfig; pivot?: PivotConfig; frequencyColumnId?: string }
  | { version: 1; operation: 'relation'; config: RelationConfig }
  | { version: 1; operation: 'set'; config: SetConfig }
  | { version: 1; operation: 'reshape'; config: ReshapeConfig }
  | (Omit<Extract<SingleRecipeSpec, { operation: 'export' }>, 'scope'> & { scope?: ExportScope })
  | Extract<SingleRecipeSpec, { operation: 'combine' | 'sql' }>
  | (Omit<Extract<SingleRecipeSpec, { operation: 'compare' }>, 'config'> & { operation: 'compare'; config: CompareConfig })

export class RecipeValidationError extends Error {}

const cleanParameterFields: Record<string, string[]> = {
  text: ['find', 'replacement'], fill: ['value'], number: ['prefix', 'suffix'],
  add: ['value', 'separator'], filter: ['value'],
}

export function cleanPlanParameterNames(plan: { steps: Record<string, unknown>[] }) {
  const names = new Set<string>()
  for (const step of plan.steps) {
    if (step.enabled === false) continue
    for (const field of cleanParameterFields[String(step.type)] ?? []) {
      const value = step[field]
      if (typeof value !== 'string') continue
      for (const match of value.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/gu)) names.add(match[1]!)
    }
  }
  if (names.size > 16) throw new RecipeValidationError('清洗模板最多使用 16 个参数')
  return [...names]
}

export function applyCleanPlanParameters(plan: { steps: Record<string, unknown>[] }, values: Record<string, string>) {
  const names = cleanPlanParameterNames(plan)
  for (const name of names) {
    const value = values[name]
    if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
      throw new RecipeValidationError(`清洗参数 ${name} 缺失或内容无效`)
    }
  }
  return { steps: plan.steps.map((step) => {
    const next = { ...step }
    if (step.enabled === false) return next
    for (const field of cleanParameterFields[String(step.type)] ?? []) {
      const value = next[field]
      if (typeof value === 'string') next[field] = value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/gu,
        (_token: string, name: string) => values[name]!)
    }
    return next
  }) }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecipeValidationError('模板结构无效')
  return value as Record<string, unknown>
}

function shortText(value: unknown, label: string, max = 255): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/u.test(value)) {
    throw new RecipeValidationError(`${label}无效`)
  }
  return value
}

function names(value: unknown, label: string, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item || item.length > 255)) {
    throw new RecipeValidationError(`${label}无效`)
  }
  return value as string[]
}

/** 导入及修改模板时重新建立受限的规则结构，不直接信任浏览器提交的 JSON。 */
export function validateRecipeSpec(raw: unknown): RecipeSpec {
  const value = object(raw)
  if (value.version !== 1 || typeof value.operation !== 'string') throw new RecipeValidationError('模板版本或操作无效')
  if (value.operation === 'pipeline') {
    if (!Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 20 ||
      !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 64) {
      throw new RecipeValidationError('流程输入或步骤数量无效')
    }
    const inputs = value.inputs.map((rawInput) => {
      const input = object(rawInput)
      return { name: shortText(input.name, '输入名称', 120), requiredHeaders: names(input.requiredHeaders, '字段要求', 4096) }
    })
    const available = new Set<string>(inputs.map((_, index) => `input:${index}`))
    const fileOutputs = new Set<string>()
    const stepIds = new Set<string>()
    const steps: PipelineRecipeSpec['steps'] = value.steps.map((rawStep) => {
      const step = object(rawStep)
      const id = shortText(step.id, '步骤编号', 40)
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(id) || stepIds.has(id)) throw new RecipeValidationError('步骤编号重复或无效')
      if (step.enabled !== undefined && typeof step.enabled !== 'boolean') throw new RecipeValidationError(`步骤 ${id} 的启用状态无效`)
      stepIds.add(id)
      const rule = validateRecipeSpec(step.rule)
      if (rule.operation === 'pipeline') throw new RecipeValidationError('流程不能嵌套流程')
      if (!Array.isArray(step.inputs) || step.inputs.length !== recipeInputCount(rule) ||
        step.inputs.some((ref) => typeof ref !== 'string' || !available.has(ref))) {
        throw new RecipeValidationError(`步骤 ${id} 引用了不存在或数量不符的输入`)
      }
      if (step.inputs.some((ref) => fileOutputs.has(ref))) throw new RecipeValidationError(`步骤 ${id} 不能将导出或拆分文件作为数据集输入`)
      if (new Set(step.inputs).size !== step.inputs.length) throw new RecipeValidationError(`步骤 ${id} 的多个输入不能重复引用同一结果`)
      if (step.enabled !== false) {
        available.add(`step:${id}`)
        if (rule.operation === 'export' || rule.operation === 'split') fileOutputs.add(`step:${id}`)
      }
      return { id, enabled: step.enabled !== false, inputs: step.inputs as RecipeRef[], rule }
    })
    if (typeof value.output !== 'string' || !available.has(value.output)) throw new RecipeValidationError('流程输出引用无效')
    const lastEnabled = [...steps].reverse().find((step) => step.enabled !== false)
    if (!lastEnabled || value.output !== `step:${lastEnabled.id}`) {
      throw new RecipeValidationError('流程至少需要一个启用步骤，输出须为最后一个启用步骤')
    }
    const outputs = value.outputs === undefined ? [value.output as RecipeRef] : value.outputs
    if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > steps.length ||
      outputs.some((ref) => typeof ref !== 'string' || !ref.startsWith('step:') || !available.has(ref)) ||
      new Set(outputs).size !== outputs.length || !outputs.includes(value.output)) {
      throw new RecipeValidationError('流程结果引用无效；只能选择已启用步骤，并包含最终步骤')
    }
    return { version: 1, operation: 'pipeline', inputs, steps, output: value.output as RecipeRef,
      outputs: outputs as RecipeRef[] }
  }
  if (value.operation === 'filter') {
    if (value.mode !== 'equals' && value.mode !== 'contains') throw new RecipeValidationError('筛选方式无效')
    return { version: 1, operation: 'filter', column: shortText(value.column, '字段名'), mode: value.mode,
      value: shortText(value.value, '筛选值', 4096) }
  }
  if (value.operation === 'filter-plan') {
    const plan = object(value.plan)
    const rawGroups = plan.groups
    if (!['and', 'or'].includes(String(plan.combine)) || !Array.isArray(plan.conditions) || !Array.isArray(plan.sorts) ||
      plan.conditions.length > 16 || plan.sorts.length > 4 ||
      (rawGroups !== undefined && (!Array.isArray(rawGroups) || rawGroups.length < 1 || rawGroups.length > 4 || plan.conditions.length > 0 ||
        rawGroups.some((rawGroup: unknown) => {
          const group = object(rawGroup)
          return !['and', 'or'].includes(String(group.combine)) || !Array.isArray(group.conditions) || group.conditions.length < 1
        })))) {
      throw new RecipeValidationError('筛选排序规则无效')
    }
    if ((rawGroups ? (rawGroups as { conditions: unknown[] }[]).reduce((sum, group) => sum + group.conditions.length, 0) : plan.conditions.length) > 16 ||
      !(rawGroups ? (rawGroups as { conditions: unknown[] }[]).length : plan.conditions.length) && !plan.sorts.length) {
      throw new RecipeValidationError('筛选条件数量无效')
    }
    const parseCondition = (rawCondition: unknown): NamedViewPlan['conditions'][number] => {
      const condition = object(rawCondition)
      if (!['equals', 'not-equals', 'contains', 'starts', 'ends', 'is-empty', 'not-empty', 'between', 'in', 'pattern'].includes(String(condition.operator))) {
        throw new RecipeValidationError('筛选运算符无效')
      }
      const column = shortText(condition.column, '筛选字段')
      const operator = condition.operator as FilterCondition['operator']
      if (operator === 'in') {
        if (!Array.isArray(condition.values) || !condition.values.length || condition.values.length > 100) throw new RecipeValidationError('集合值无效')
        return { column, operator, values: condition.values.map((item) => shortText(item, '集合值', 512)) }
      }
      if (operator === 'between') return { column, operator, value: shortText(condition.value, '范围起点', 512),
        other: shortText(condition.other, '范围终点', 512) }
      if (operator === 'is-empty' || operator === 'not-empty') return { column, operator }
      if (operator === 'pattern') {
        const value = shortText(condition.value, '表达式', 160)
        try { compileSafePattern(value) }
        catch (error) { throw new RecipeValidationError(error instanceof PatternError ? error.message : '表达式无效') }
        return { column, operator, value }
      }
      return { column, operator, value: shortText(condition.value, '筛选值', 512) }
    }
    const conditions: NamedViewPlan['conditions'] = plan.conditions.map(parseCondition)
    const groups: NamedViewPlan['groups'] = rawGroups ? (rawGroups as { combine: 'and' | 'or'; conditions: unknown[] }[])
      .map((group) => ({ combine: group.combine, conditions: group.conditions.map(parseCondition) })) : undefined
    const sorts: NamedViewPlan['sorts'] = plan.sorts.map((rawSort) => {
      const sort = object(rawSort)
      if (!['asc', 'desc'].includes(String(sort.direction)) || !['first', 'last'].includes(String(sort.empty))) {
        throw new RecipeValidationError('排序方式无效')
      }
      return { column: shortText(sort.column, '排序字段'), direction: sort.direction as 'asc' | 'desc', empty: sort.empty as 'first' | 'last' }
    })
    return { version: 1, operation: 'filter-plan', plan: { combine: plan.combine as 'and' | 'or', conditions, sorts, groups } }
  }
  if (value.operation === 'clean') {
    const allowed = ['trim', 'squeeze', 'squeeze0', 'lower', 'upper', 'replace', 'fill-empty', 'nfc', 'nfkc', 'date-iso']
    const formats = ['yyyy-MM-dd', 'yyyy/MM/dd', 'dd/MM/yyyy', 'MM/dd/yyyy']
    if (!allowed.includes(String(value.mode)) || !formats.includes(String(value.dateFormat))) throw new RecipeValidationError('清洗规则无效')
    return { version: 1, operation: 'clean', column: shortText(value.column, '字段名'),
      mode: value.mode as Extract<SingleRecipeSpec, { operation: 'clean' }>['mode'],
      find: shortText(value.find, '查找内容', 4096), replacement: shortText(value.replacement, '替换内容', 4096),
      dateFormat: value.dateFormat as Extract<SingleRecipeSpec, { operation: 'clean' }>['dateFormat'] }
  }
  if (value.operation === 'clean-plan') {
    const plan = object(value.plan)
    if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 24 ||
      JSON.stringify(plan).length > 64 * 1024) throw new RecipeValidationError('多步清洗模板无效或过大')
    const steps = plan.steps.map((item) => {
      const step = object(item)
      if (!['text','fill','number','date','rename','columns','add','empty-row','filter','dedupe'].includes(String(step.type))) {
        throw new RecipeValidationError('多步清洗模板含不支持的操作')
      }
      if (step.enabled !== undefined && typeof step.enabled !== 'boolean') throw new RecipeValidationError('步骤启用状态无效')
      if (step.type === 'fill' && step.scope !== undefined &&
        !['all', 'empty-text', 'missing', 'explicit-null'].includes(String(step.scope))) {
        throw new RecipeValidationError('空值填充范围无效')
      }
      if ('column' in step) shortText(step.column, '字段名')
      if ('columns' in step) names(step.columns, '字段名', 1024)
      if ('name' in step) shortText(step.name, '新字段名', 128)
      if ('priorityColumn' in step) shortText(step.priorityColumn, '去重优先字段')
      return { ...step }
    })
    cleanPlanParameterNames({ steps })
    return { version: 1, operation: 'clean-plan', plan: { steps } }
  }
  if (value.operation === 'dedup') {
    const columns = names(value.columns, '去重字段', 16)
    if (!columns.length || new Set(columns).size !== columns.length) throw new RecipeValidationError('去重字段重复或为空')
    return { version: 1, operation: 'dedup', columns }
  }
  if (value.operation === 'quality') {
    if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > 32) throw new RecipeValidationError('检查规则数量无效')
    const outputMode = value.outputMode ?? 'report'
    if (!['report', 'valid', 'invalid'].includes(String(outputMode))) throw new RecipeValidationError('检查输出方式无效')
    const rules: NamedQualityRule[] = value.rules.map((rawRule) => {
      const rule = object(rawRule)
      if (rule.kind === 'unique') {
        const columns = names(rule.columns, '唯一键字段', 16)
        if (!columns.length || new Set(columns).size !== columns.length) throw new RecipeValidationError('唯一键字段无效')
        return { kind: 'unique', columns }
      }
      const column = shortText(rule.column, '字段名')
      if (rule.kind === 'reference') {
        if (!Number.isSafeInteger(rule.referenceInput) || Number(rule.referenceInput) < 0 || Number(rule.referenceInput) > 4) {
          throw new RecipeValidationError('参考输入编号无效')
        }
        return { kind: 'reference', column, referenceInput: Number(rule.referenceInput),
          referenceColumn: shortText(rule.referenceColumn, '参考字段') }
      }
      if (rule.kind === 'required') return { kind: 'required', column }
      if (rule.kind === 'length' && Number.isSafeInteger(rule.min) && Number.isSafeInteger(rule.max) &&
        Number(rule.min) >= 0 && Number(rule.max) <= 1_000_000 && Number(rule.min) <= Number(rule.max)) {
        return { kind: 'length', column, min: Number(rule.min), max: Number(rule.max) }
      }
      if (rule.kind === 'enum' && Array.isArray(rule.values) && rule.values.length >= 1 && rule.values.length <= 1000) {
        return { kind: 'enum', column, values: rule.values.map((item) => shortText(item, '枚举值', 4096)) }
      }
      if (rule.kind === 'type' && ['integer', 'decimal', 'date'].includes(String(rule.dataType))) {
        return { kind: 'type', column, dataType: rule.dataType as 'integer' | 'decimal' | 'date' }
      }
      if (rule.kind === 'range') return { kind: 'range', column,
        min: shortText(rule.min, '最小值', 80), max: shortText(rule.max, '最大值', 80) }
      if (rule.kind === 'date-order') return { kind: 'date-order', column,
        otherColumn: shortText(rule.otherColumn, '结束日期字段') }
      if (rule.kind === 'pattern') {
        const pattern = shortText(rule.pattern, '表达式', 160)
        try { compileSafePattern(pattern) } catch { throw new RecipeValidationError('表达式无效') }
        return { kind: 'pattern', column, pattern }
      }
      if (rule.kind === 'arithmetic') return { kind: 'arithmetic', column,
        leftColumn: shortText(rule.leftColumn, '数量字段'), rightColumn: shortText(rule.rightColumn, '单价字段'),
        tolerance: shortText(rule.tolerance, '允许差额', 80) }
      throw new RecipeValidationError('检查规则无效')
    })
    return { version: 1, operation: 'quality', rules, outputMode: outputMode as 'report' | 'valid' | 'invalid' }
  }
  if (value.operation === 'analyze') {
    if (value.frequencyColumn !== undefined) {
      if (value.pivot !== undefined || value.aggregate !== undefined) throw new RecipeValidationError('频率规则不能同时包含汇总或透视')
      const frequencyColumn = shortText(value.frequencyColumn, '频率字段')
      if (!frequencyColumn) throw new RecipeValidationError('频率字段不能为空')
      return { version: 1, operation: 'analyze', frequencyColumn }
    }
    if (value.pivot !== undefined) {
      const pivot = object(value.pivot)
      const measure = object(pivot.measure)
      if (!['count', 'sum', 'min', 'max', 'avg'].includes(String(measure.operation))) throw new RecipeValidationError('透视指标无效')
      const operation = measure.operation as AggregateMeasure['operation']
      const precision = operation === 'sum' || operation === 'avg' ? Number(measure.precision) : undefined
      if (precision !== undefined && (!Number.isInteger(precision) || precision < 0 || precision > 18)) throw new RecipeValidationError('透视小数位无效')
      return { version: 1, operation: 'analyze', pivot: {
        rowColumn: shortText(pivot.rowColumn, '透视行字段'), pivotColumn: shortText(pivot.pivotColumn, '透视列字段'),
        measure: { operation, name: shortText(measure.name, '透视指标名', 120), precision,
          column: operation === 'count' ? undefined : shortText(measure.column, '透视数值字段') } } }
    }
    if (value.aggregate === undefined) return { version: 1, operation: 'analyze' }
    const aggregate = object(value.aggregate)
    const groupColumns = names(aggregate.groupColumns, '分组字段', 4)
    if (!groupColumns.length || new Set(groupColumns).size !== groupColumns.length || !Array.isArray(aggregate.measures) ||
      !aggregate.measures.length || aggregate.measures.length > 8) throw new RecipeValidationError('汇总规则无效')
    const measures: NamedAggregate['measures'] = aggregate.measures.map((rawMeasure) => {
      const measure = object(rawMeasure)
      if (!['count', 'sum', 'min', 'max', 'avg'].includes(String(measure.operation))) throw new RecipeValidationError('汇总操作无效')
      const operation = measure.operation as AggregateMeasure['operation']
      const name = shortText(measure.name, '结果列名', 120)
      const column = operation === 'count' ? undefined : shortText(measure.column, '汇总字段')
      const precision = operation === 'sum' || operation === 'avg' ? Number(measure.precision) : undefined
      if (precision !== undefined && (!Number.isInteger(precision) || precision < 0 || precision > 18)) throw new RecipeValidationError('汇总小数位无效')
      return { operation, name, column, precision }
    })
    return { version: 1, operation: 'analyze', aggregate: { groupColumns, measures } }
  }
  if (value.operation === 'split') {
    const config = object(value.config)
    if (config.includeHeader !== undefined && typeof config.includeHeader !== 'boolean') throw new RecipeValidationError('拆分表头选项无效')
    if (config.mode === 'rows' && Number.isSafeInteger(config.size) && Number(config.size) >= 1 && Number(config.size) <= 100_000_000) {
      return { version: 1, operation: 'split', config: { mode: 'rows', size: Number(config.size), includeHeader: config.includeHeader as boolean | undefined } }
    }
    if (config.mode === 'value') return { version: 1, operation: 'split', config: { mode: 'value', column: shortText(config.column, '字段名'), includeHeader: config.includeHeader as boolean | undefined } }
    throw new RecipeValidationError('拆分规则无效')
  }
  if (value.operation === 'export') {
    if (!['csv', 'tsv', 'xlsx', 'ods', 'json', 'jsonl', 'parquet'].includes(String(value.format)) || typeof value.safeText !== 'boolean') {
      throw new RecipeValidationError('导出规则无效')
    }
    if (value.outputName !== undefined && (typeof value.outputName !== 'string' || !value.outputName.trim() ||
      value.outputName.trim() === '.' || value.outputName.trim() === '..' ||
      value.outputName.length > 120 || /[\\/\x00-\x1f\x7f]/u.test(value.outputName))) {
      throw new RecipeValidationError('导出文件名无效')
    }
    let workbook: { sheetNames: string[]; rowsPerSheet?: number } | undefined
    if (value.workbook !== undefined) {
      const requested = object(value.workbook)
      if (!['xlsx', 'ods'].includes(String(value.format)) || !Array.isArray(requested.sheetNames) ||
        requested.sheetNames.length < 1 || requested.sheetNames.length > 20 ||
        requested.sheetNames.some((name: unknown) => typeof name !== 'string' || !name.trim() || name.length > 31 ||
          /[\\/*\[\]:?\x00-\x1f]/u.test(name) || name.startsWith("'") || name.endsWith("'")) ||
        new Set((requested.sheetNames as string[]).map((name) => name.toLocaleLowerCase())).size !== requested.sheetNames.length ||
        requested.rowsPerSheet !== undefined && (requested.sheetNames.length !== 1 ||
          !Number.isSafeInteger(requested.rowsPerSheet) || Number(requested.rowsPerSheet) < 1 ||
          Number(requested.rowsPerSheet) > 1_048_575)) {
        throw new RecipeValidationError('模板工作表名称无效')
      }
      workbook = { sheetNames: requested.sheetNames as string[],
        rowsPerSheet: requested.rowsPerSheet as number | undefined }
    }
    let scope: { startRow: number; endRow: number; columns: string[] } | undefined
    if (value.scope !== undefined) {
      const requested = object(value.scope)
      const columns = names(requested.columns, '导出字段', 4096)
      if (workbook && workbook.sheetNames.length > 1 || !Number.isSafeInteger(requested.startRow) ||
        !Number.isSafeInteger(requested.endRow) || Number(requested.startRow) < 1 ||
        Number(requested.endRow) < Number(requested.startRow) || !columns.length ||
        new Set(columns).size !== columns.length) throw new RecipeValidationError('模板导出范围无效')
      scope = { startRow: Number(requested.startRow), endRow: Number(requested.endRow), columns }
    }
    let textOptions: TextExportOptions | undefined
    if (value.textOptions !== undefined) {
      try { textOptions = validateTextExportOptions(value.textOptions as TextExportOptions) }
      catch { throw new RecipeValidationError('文本导出配置无效') }
      if (!['csv','tsv'].includes(String(value.format))) throw new RecipeValidationError('当前格式不支持文本导出配置')
    }
    let jsonOptions: JsonExportOptions | undefined
    if (value.jsonOptions !== undefined) {
      const requested = object(value.jsonOptions)
      const types = object(requested.types)
      if (!['json','jsonl'].includes(String(value.format)) || typeof requested.emptyAsNull !== 'boolean' ||
        Object.keys(types).length > 1024 || Object.entries(types).some(([name, type]) => !name || name.length > 255 ||
          !['text','integer','decimal','boolean','date'].includes(String(type)))) throw new RecipeValidationError('JSON 导出配置无效')
      jsonOptions = { emptyAsNull: requested.emptyAsNull, types: types as JsonExportOptions['types'] }
    }
    return { version: 1, operation: 'export', format: value.format as Extract<SingleRecipeSpec, { operation: 'export' }>['format'],
      safeText: value.safeText, textOptions, jsonOptions, outputName: value.outputName as string | undefined,
      workbook, scope }
  }
  if (value.operation === 'combine') {
    if (!['strict', 'union', 'intersection', 'horizontal-pad', 'horizontal-error'].includes(String(value.mode)) || !Number.isSafeInteger(value.inputCount) ||
      Number(value.inputCount) < 2 || Number(value.inputCount) > 20) throw new RecipeValidationError('合并规则无效')
    return { version: 1, operation: 'combine', mode: value.mode as Extract<SingleRecipeSpec, { operation: 'combine' }>['mode'], inputCount: Number(value.inputCount) }
  }
  if (value.operation === 'relation') {
    const config = object(value.config)
    const leftKeys = names(config.leftKeys, '左侧匹配键', 4)
    const rightKeys = names(config.rightKeys, '右侧匹配键', 4)
    if (!leftKeys.length || leftKeys.length !== rightKeys.length || new Set(leftKeys).size !== leftKeys.length ||
      new Set(rightKeys).size !== rightKeys.length ||
      !['inner', 'left', 'right', 'full', 'left-semi', 'left-anti'].includes(String(config.kind)) ||
      !['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'].includes(String(config.cardinality)) ||
      (config.keyType !== undefined && !['text', 'decimal'].includes(String(config.keyType))) ||
      (config.matchEmptyKeys !== undefined && typeof config.matchEmptyKeys !== 'boolean') ||
      (config.trimKeys !== undefined && typeof config.trimKeys !== 'boolean') ||
      (config.ignoreCase !== undefined && typeof config.ignoreCase !== 'boolean') ||
      (config.unicodeNormalization !== undefined && !['none', 'nfc', 'nfkc'].includes(String(config.unicodeNormalization)))) {
      throw new RecipeValidationError('关联规则无效')
    }
    let output: Extract<SingleRecipeSpec, { operation: 'relation' }>['config']['output']
    if (config.output !== undefined) {
      const value = object(config.output)
      if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > 8192 ||
        typeof value.includeSourceRows !== 'boolean') throw new RecipeValidationError('关联输出字段无效')
      const columns = value.columns.map((entry) => {
        const column = object(entry)
        if (column.side !== 'left' && column.side !== 'right') throw new RecipeValidationError('关联输出来源无效')
        return { side: column.side, name: shortText(column.name, '关联输出字段名') }
      })
      if (new Set(columns.map((column) => `${column.side}:${column.name}`)).size !== columns.length) {
        throw new RecipeValidationError('关联输出字段重复')
      }
      const leftSuffix = shortText(value.leftSuffix, '左侧重名后缀', 32)
      const rightSuffix = shortText(value.rightSuffix, '右侧重名后缀', 32)
      output = { columns, leftSuffix, rightSuffix, includeSourceRows: value.includeSourceRows }
    }
    return { version: 1, operation: 'relation', config: { kind: config.kind as RelationConfig['kind'], leftKeys, rightKeys,
      cardinality: config.cardinality as RelationConfig['cardinality'], keyType: config.keyType as RelationConfig['keyType'],
      matchEmptyKeys: config.matchEmptyKeys as boolean | undefined,
      trimKeys: config.trimKeys as boolean | undefined,
      ignoreCase: config.ignoreCase as boolean | undefined,
      unicodeNormalization: config.unicodeNormalization as RelationConfig['unicodeNormalization'], output } }
  }
  if (value.operation === 'set') {
    const config = object(value.config)
    const leftKeys = names(config.leftKeys, '左侧集合键', 16)
    const rightKeys = names(config.rightKeys, '右侧集合键', 16)
    if (!leftKeys.length || leftKeys.length !== rightKeys.length || new Set(leftKeys).size !== leftKeys.length ||
      new Set(rightKeys).size !== rightKeys.length ||
      !['intersection', 'left-difference', 'right-difference', 'union'].includes(String(config.kind))) {
      throw new RecipeValidationError('集合运算规则无效')
    }
    return { version: 1, operation: 'set', config: { kind: config.kind as SetConfig['kind'], leftKeys, rightKeys } }
  }
  if (value.operation === 'reshape') {
    const config = object(value.config)
    if (config.kind === 'transpose') return { version: 1, operation: 'reshape', config: { kind: 'transpose' } }
    if (config.kind === 'split-column' && Number.isSafeInteger(config.maxParts) &&
      Number(config.maxParts) >= 2 && Number(config.maxParts) <= 32 && typeof config.keepEmpty === 'boolean' &&
      ['columns', 'rows'].includes(String(config.direction)) && ['error', 'join-last'].includes(String(config.overflow))) {
      return { version: 1, operation: 'reshape', config: { kind: 'split-column', column: shortText(config.column, '分隔字段'),
        delimiter: shortText(config.delimiter, '分隔符', 16), direction: config.direction as 'columns' | 'rows',
        maxParts: Number(config.maxParts), keepEmpty: config.keepEmpty, overflow: config.overflow as 'error' | 'join-last' } }
    }
    if (config.kind === 'group-join') {
      const keys = names(config.keys, '组合键字段', 8)
      if (!keys.length || new Set(keys).size !== keys.length) throw new RecipeValidationError('组合键字段无效')
      return { version: 1, operation: 'reshape', config: { kind: 'group-join', keys,
        value: shortText(config.value, '组合值字段'), separator: shortText(config.separator, '分隔符', 16) } }
    }
    throw new RecipeValidationError('重组规则无效')
  }
  if (value.operation === 'sql') {
    if (!Number.isSafeInteger(value.inputCount) || Number(value.inputCount) < 1 || Number(value.inputCount) > 4 ||
      !Array.isArray(value.requiredHeaders) || value.requiredHeaders.length !== value.inputCount) throw new RecipeValidationError('SQL 输入无效')
    const parameterDefinitions = value.parameterDefinitions
    if (parameterDefinitions !== undefined && (!Array.isArray(parameterDefinitions) || parameterDefinitions.length > 16 ||
      parameterDefinitions.some((raw) => { const definition = object(raw); return !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/u.test(String(definition.name)) ||
        !['text','integer','decimal','date'].includes(String(definition.type)) }) ||
      new Set(parameterDefinitions.map((item: SqlParameterDefinition) => item.name)).size !== parameterDefinitions.length)) {
      throw new RecipeValidationError('SQL 参数定义无效')
    }
    return { version: 1, operation: 'sql', sql: shortText(value.sql, 'SQL', 8192), inputCount: Number(value.inputCount),
      requiredHeaders: value.requiredHeaders.map((item) => names(item, 'SQL 字段', 4096)),
      parameterDefinitions: parameterDefinitions as SqlParameterDefinition[] | undefined }
  }
  if (value.operation === 'compare') {
    const config = object(value.config)
    const leftKeys = names(config.leftKeys, '左侧匹配键', 4)
    const rightKeys = names(config.rightKeys, '右侧匹配键', 4)
    if (!leftKeys.length || leftKeys.length !== rightKeys.length || !Array.isArray(config.fields) ||
      !config.fields.length || config.fields.length > 16 || typeof config.trimKeys !== 'boolean' ||
      typeof config.ignoreKeyCase !== 'boolean') throw new RecipeValidationError('核对规则无效')
    if (config.duplicatePolicy !== undefined && !['isolate', 'abort', 'aggregate'].includes(String(config.duplicatePolicy)) ||
      config.duplicatePolicy === 'aggregate' && (!Array.isArray(config.aggregateMethods) ||
        config.aggregateMethods.length !== config.fields.length ||
        config.aggregateMethods.some((method: unknown) => !['sum', 'count'].includes(String(method)))) ||
      config.duplicatePolicy !== 'aggregate' && config.aggregateMethods !== undefined) {
      throw new RecipeValidationError('重复键处理规则无效')
    }
    if (config.emptyValuePolicy !== undefined && !['mode-default', 'match-both', 'error'].includes(String(config.emptyValuePolicy)) ||
      config.parseFailurePolicy !== undefined && !['isolate', 'abort'].includes(String(config.parseFailurePolicy))) {
      throw new RecipeValidationError('空值或解析失败处理规则无效')
    }
    const contextLeft = config.contextLeft === undefined ? undefined : names(config.contextLeft, '左侧上下文字段', 8)
    const contextRight = config.contextRight === undefined ? undefined : names(config.contextRight, '右侧上下文字段', 8)
    if (contextLeft && new Set(contextLeft).size !== contextLeft.length ||
      contextRight && new Set(contextRight).size !== contextRight.length) throw new RecipeValidationError('上下文字段重复')
    const fields: Extract<SingleRecipeSpec, { operation: 'compare' }>['config']['fields'] = config.fields.map((rawField) => {
      const field = object(rawField)
      if (!['text', 'decimal', 'calendar-date', 'instant'].includes(String(field.mode))) throw new RecipeValidationError('核对字段规则无效')
      const mode = field.mode as CompareField['mode']
      if (mode === 'text' && (field.textTrim !== undefined && typeof field.textTrim !== 'boolean' ||
        field.textIgnoreCase !== undefined && typeof field.textIgnoreCase !== 'boolean' ||
        !['none', 'NFC', 'NFKC'].includes(String(field.unicode ?? 'none')))) throw new RecipeValidationError('文本规范化配置无效')
      if (mode === 'decimal' && (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/u.test(String(field.tolerance ?? '0')) ||
        !/^(?:0(?:\.\d{1,18})?|1(?:\.0{1,18})?)$/u.test(String(field.relativeTolerance ?? '0')))) {
        throw new RecipeValidationError('数值容差无效')
      }
      if (mode === 'calendar-date' && (!Number.isSafeInteger(Number(field.dayTolerance ?? 0)) ||
        Number(field.dayTolerance ?? 0) < 0 || Number(field.dayTolerance ?? 0) > 365)) throw new RecipeValidationError('日历日容差无效')
      if (mode === 'instant' && (!Number.isSafeInteger(Number(field.timeToleranceSeconds ?? 0)) ||
        Number(field.timeToleranceSeconds ?? 0) < 0 || Number(field.timeToleranceSeconds ?? 0) > 604800 ||
        field.leftTimeZone !== undefined && !validIanaTimeZone(field.leftTimeZone as string) ||
        field.rightTimeZone !== undefined && !validIanaTimeZone(field.rightTimeZone as string))) throw new RecipeValidationError('时间点容差或时区无效')
      return { left: shortText(field.left, '左侧字段'), right: shortText(field.right, '右侧字段'), mode,
        tolerance: mode === 'decimal' ? shortText(field.tolerance ?? '0', '绝对容差', 40) : undefined,
        relativeTolerance: mode === 'decimal' ? shortText(field.relativeTolerance ?? '0', '相对容差', 40) : undefined,
        textTrim: mode === 'text' ? Boolean(field.textTrim) : undefined,
        textIgnoreCase: mode === 'text' ? Boolean(field.textIgnoreCase) : undefined,
        unicode: mode === 'text' ? (field.unicode ?? 'none') as CompareField['unicode'] : undefined,
        dayTolerance: mode === 'calendar-date' ? Number(field.dayTolerance ?? 0) : undefined,
        timeToleranceSeconds: mode === 'instant' ? Number(field.timeToleranceSeconds ?? 0) : undefined,
        leftTimeZone: mode === 'instant' ? field.leftTimeZone as string | undefined : undefined,
        rightTimeZone: mode === 'instant' ? field.rightTimeZone as string | undefined : undefined }
    })
    if (config.duplicatePolicy === 'aggregate' && fields.some((field) => field.mode !== 'decimal')) {
      throw new RecipeValidationError('重复键聚合要求所有比较字段为十进制数值')
    }
    return { version: 1, operation: 'compare', config: { leftKeys, rightKeys, fields,
      trimKeys: config.trimKeys, ignoreKeyCase: config.ignoreKeyCase,
      leftLabel: config.leftLabel === undefined ? undefined : shortText(config.leftLabel, '左侧名称', 100),
      rightLabel: config.rightLabel === undefined ? undefined : shortText(config.rightLabel, '右侧名称', 100),
      duplicatePolicy: config.duplicatePolicy as CompareConfig['duplicatePolicy'],
      aggregateMethods: config.duplicatePolicy === 'aggregate' ? config.aggregateMethods as CompareConfig['aggregateMethods'] : undefined,
      emptyValuePolicy: config.emptyValuePolicy as CompareConfig['emptyValuePolicy'],
      parseFailurePolicy: config.parseFailurePolicy as CompareConfig['parseFailurePolicy'],
      contextLeft, contextRight } }
  }
  throw new RecipeValidationError('模板操作不受支持')
}

export function recipeInputCount(spec: RecipeSpec) {
  return spec.operation === 'pipeline' ? spec.inputs.length : spec.operation === 'compare' || spec.operation === 'relation' || spec.operation === 'set' ? 2 :
    spec.operation === 'combine' || spec.operation === 'sql' ? spec.inputCount :
      spec.operation === 'export' ? (spec.workbook?.sheetNames.length ?? 1) :
      spec.operation === 'quality' ? Math.max(1, ...spec.rules.map((rule) => rule.kind === 'reference' ? rule.referenceInput + 1 : 1)) : 1
}

function named(headers: string[], id: string) {
  const match = /^c_(\d+)$/.exec(id)
  const name = match ? headers[Number(match[1])] : undefined
  if (name === undefined || name.length === 0 || headers.filter((header) => header === name).length !== 1) {
    throw new RecipeValidationError('模板字段需要唯一且非空的列名，请先修正源数据表头')
  }
  return name
}

function nameCleanPlan(plan: CleanPlan, sourceHeaders: string[]) {
  let headers = [...sourceHeaders]
  const steps = plan.steps.map((step) => {
    const namedStep: Record<string, unknown> = { ...step }
    if ('columnId' in step) {
      namedStep.column = named(headers, step.columnId)
      delete namedStep.columnId
    }
    if ('columnIds' in step && step.columnIds) {
      namedStep.columns = step.columnIds.map((id) => named(headers, id))
      delete namedStep.columnIds
    }
    if (step.type === 'dedupe' && step.keep === 'priority' && step.priorityColumnId) {
      namedStep.priorityColumn = named(headers, step.priorityColumnId)
      delete namedStep.priorityColumnId
    }
    if (step.enabled !== false) {
      if (step.type === 'rename') headers[Number(step.columnId.slice(2))] = step.name
      if (step.type === 'columns') headers = step.columnIds.map((id) => headers[Number(id.slice(2))]!)
      if (step.type === 'add') headers.push(step.name)
    }
    return namedStep
  })
  return { steps }
}

function bindCleanPlan(plan: { steps: Record<string, unknown>[] }, sourceHeaders: string[]): CleanPlan {
  let headers = [...sourceHeaders]
  const steps = plan.steps.map((namedStep) => {
    const step: Record<string, unknown> = { ...namedStep }
    if ('column' in step) {
      step.columnId = resolved(headers, String(step.column))
      delete step.column
    }
    if ('columns' in step) {
      step.columnIds = (step.columns as string[]).map((name) => resolved(headers, name))
      delete step.columns
    }
    if (step.type === 'dedupe' && step.keep === 'priority' && typeof step.priorityColumn === 'string') {
      step.priorityColumnId = resolved(headers, step.priorityColumn)
      delete step.priorityColumn
    }
    const bound = step as unknown as CleanStep
    try { validateCleanPlan({ steps: [bound] }, headers) }
    catch (error) { throw new RecipeValidationError(error instanceof Error ? error.message : '清洗规则与输入字段不匹配') }
    if (bound.enabled !== false) {
      if (bound.type === 'rename') headers[Number(bound.columnId.slice(2))] = bound.name
      if (bound.type === 'columns') headers = bound.columnIds.map((id) => headers[Number(id.slice(2))]!)
      if (bound.type === 'add') headers.push(bound.name)
    }
    return bound
  })
  try { validateCleanPlan({ steps }, sourceHeaders) }
  catch (error) { throw new RecipeValidationError(error instanceof Error ? error.message : '清洗规则无效') }
  return { steps }
}

export function recipeFromJob(kind: string, raw: unknown, headers: string[][]): SingleRecipeSpec {
  const spec = raw as Record<string, unknown>
  const first = headers[0] ?? []
  if (kind === 'filter' && spec.plan) {
    const plan = spec.plan as ViewPlan
    return { version: 1, operation: 'filter-plan', plan: { combine: plan.combine,
      conditions: plan.conditions.map(({ columnId, ...condition }) => ({ ...condition, column: named(first, columnId) })),
      sorts: plan.sorts.map(({ columnId, ...sort }) => ({ ...sort, column: named(first, columnId) })),
      groups: plan.groups?.map((group) => ({ combine: group.combine,
        conditions: group.conditions.map(({ columnId, ...condition }) => ({ ...condition, column: named(first, columnId) })) })) } }
  }
  if (kind === 'filter') return { version: 1, operation: 'filter', column: named(first, String(spec.columnId)),
    mode: spec.mode as 'equals' | 'contains', value: String(spec.value ?? '') }
  if (kind === 'clean' && spec.operation === 'clean.plan') return { version: 1, operation: 'clean-plan',
    plan: nameCleanPlan(spec.plan as CleanPlan, first) }
  if (kind === 'clean') return { version: 1, operation: 'clean', column: named(first, String(spec.columnId)),
    mode: spec.mode as Extract<SingleRecipeSpec, { operation: 'clean' }>['mode'], find: String(spec.find ?? ''), replacement: String(spec.replacement ?? ''),
    dateFormat: (spec.dateFormat ?? 'yyyy-MM-dd') as Extract<SingleRecipeSpec, { operation: 'clean' }>['dateFormat'] }
  if (kind === 'dedup') return { version: 1, operation: 'dedup', columns: (spec.columnIds as string[]).map((id) => named(first, id)) }
  if (kind === 'quality') return { version: 1, operation: 'quality', outputMode: (spec.outputMode ?? 'report') as 'report' | 'valid' | 'invalid',
    rules: (spec.rules as QualityRule[]).map((rule) => {
    if (rule.kind === 'unique') return { kind: 'unique' as const, columns: rule.columnIds.map((id) => named(first, id)) }
    const column = named(first, rule.columnId)
    if (rule.kind === 'reference') {
      const referenceIds = (spec.references as { id: string }[] ?? []).map((entry) => entry.id)
      const referenceIndex = referenceIds.filter((id) => id !== spec.sourceId).indexOf(rule.referenceId)
      const input = rule.referenceId === spec.sourceId ? 0 : referenceIndex < 0 ? -1 : referenceIndex + 1
      if (input < 0 || input >= headers.length) throw new RecipeValidationError('参考输入未找到')
      return { kind: 'reference' as const, column, referenceInput: input,
        referenceColumn: named(headers[input] ?? [], rule.referenceColumnId) }
    }
    return rule.kind === 'required' ? { kind: 'required' as const, column } : rule.kind === 'length'
      ? { kind: 'length' as const, column, min: rule.min, max: rule.max }
      : rule.kind === 'enum' ? { kind: 'enum' as const, column, values: rule.values }
      : rule.kind === 'type' ? { kind: 'type' as const, column, dataType: rule.dataType }
      : rule.kind === 'range' ? { kind: 'range' as const, column, min: rule.min, max: rule.max }
      : rule.kind === 'date-order' ? { kind: 'date-order' as const, column, otherColumn: named(first, rule.otherColumnId) }
      : rule.kind === 'pattern' ? { kind: 'pattern' as const, column, pattern: rule.pattern }
      : { kind: 'arithmetic' as const, column, leftColumn: named(first, rule.leftColumnId),
        rightColumn: named(first, rule.rightColumnId), tolerance: rule.tolerance }
  }) }
  if (kind === 'analyze') {
    const frequencyColumnId = spec.frequencyColumnId as string | undefined
    if (frequencyColumnId) return { version: 1, operation: 'analyze', frequencyColumn: named(first, frequencyColumnId) }
    const pivot = spec.pivot as PivotConfig | undefined
    if (pivot) return { version: 1, operation: 'analyze', pivot: {
      rowColumn: named(first, pivot.rowColumnId), pivotColumn: named(first, pivot.pivotColumnId),
      measure: { operation: pivot.measure.operation, name: pivot.measure.name, precision: pivot.measure.precision,
        column: pivot.measure.columnId ? named(first, pivot.measure.columnId) : undefined } } }
    const aggregate = spec.aggregate as AggregateConfig | undefined
    return aggregate ? { version: 1, operation: 'analyze', aggregate: {
      groupColumns: aggregate.groupColumnIds.map((id) => named(first, id)),
      measures: aggregate.measures.map(({ columnId, ...measure }) => ({ ...measure,
        column: columnId ? named(first, columnId) : undefined })),
    } } : { version: 1, operation: 'analyze' }
  }
  if (kind === 'split') {
    const config = spec.config as SplitConfig
    return { version: 1, operation: 'split', config: config.mode === 'rows' ? { mode: 'rows', size: config.size, includeHeader: config.includeHeader }
      : { mode: 'value', column: named(first, config.columnId), includeHeader: config.includeHeader } }
  }
  if (kind === 'export') {
    if (spec.report) throw new RecipeValidationError('核对报告必须从固定核对结果生成，不能作为普通格式转换模板')
    const json = spec.jsonOptions as JsonExportOptions | undefined
    const workbook = spec.workbook as { sheetNames?: string[]; rowsPerSheet?: number } | undefined
    const scope = spec.scope as ExportScope | undefined
    return { version: 1, operation: 'export', format: spec.format as Extract<SingleRecipeSpec, { operation: 'export' }>['format'], safeText: Boolean(spec.safeText),
      textOptions: spec.textOptions as TextExportOptions | undefined,
      outputName: spec.outputName as string | undefined,
      workbook: workbook?.sheetNames ? { sheetNames: workbook.sheetNames, rowsPerSheet: workbook.rowsPerSheet } : undefined,
      scope: scope ? { startRow: scope.startRow, endRow: scope.endRow,
        columns: scope.columnIds.map((id) => named(first, id)) } : undefined,
      jsonOptions: json ? { emptyAsNull: json.emptyAsNull,
        types: Object.fromEntries(Object.entries(json.types).map(([id, type]) => [named(first, id), type])) } : undefined }
  }
  if (kind === 'combine' && spec.mode === 'relation') {
    const config = spec.relationConfig as RelationConfig
    return { version: 1, operation: 'relation', config: { kind: config.kind,
      leftKeys: config.leftKeyIds.map((id) => named(first, id)),
      rightKeys: config.rightKeyIds.map((id) => named(headers[1] ?? [], id)), cardinality: config.cardinality,
      keyType: config.keyType, matchEmptyKeys: config.matchEmptyKeys, trimKeys: config.trimKeys,
      ignoreCase: config.ignoreCase, unicodeNormalization: config.unicodeNormalization,
      output: config.output ? { ...config.output, columns: config.output.columns.map((entry) => ({ side: entry.side,
        name: named(entry.side === 'left' ? first : headers[1] ?? [], entry.id) })) } : undefined } }
  }
  if (kind === 'combine' && spec.mode === 'set') {
    const config = spec.setConfig as SetConfig
    return { version: 1, operation: 'set', config: { kind: config.kind,
      leftKeys: config.leftKeyIds.map((id) => named(first, id)),
      rightKeys: config.rightKeyIds.map((id) => named(headers[1] ?? [], id)) } }
  }
  if (kind === 'combine' && spec.mode === 'reshape') {
    const config = spec.reshapeConfig as ReshapeConfig
    return { version: 1, operation: 'reshape', config: config.kind === 'transpose' ? { kind: 'transpose' }
      : config.kind === 'split-column' ? { kind: 'split-column', column: named(first, config.columnId),
        delimiter: config.delimiter, direction: config.direction, maxParts: config.maxParts,
        keepEmpty: config.keepEmpty, overflow: config.overflow }
        : { kind: 'group-join', keys: config.keyIds.map((id) => named(first, id)), value: named(first, config.valueId), separator: config.separator } }
  }
  if (kind === 'combine') return { version: 1, operation: 'combine', mode: spec.mode as Extract<SingleRecipeSpec, { operation: 'combine' }>['mode'], inputCount: headers.length }
  if (kind === 'sql') return { version: 1, operation: 'sql', sql: String(spec.sql), inputCount: headers.length,
    requiredHeaders: headers, parameterDefinitions: (spec.parameters as { definitions?: SqlParameterDefinition[] } | undefined)?.definitions }
  if (kind === 'compare') {
    const config = spec.config as CompareConfig
    const left = headers[0] ?? []
    const right = headers[1] ?? []
    return { version: 1, operation: 'compare', config: {
      leftKeys: config.leftKeyIds.map((id) => named(left, id)), rightKeys: config.rightKeyIds.map((id) => named(right, id)),
      fields: config.fields.map(({ leftColumnId, rightColumnId, ...field }) => ({ ...field,
        left: named(left, leftColumnId), right: named(right, rightColumnId) })),
      trimKeys: config.trimKeys, ignoreKeyCase: config.ignoreKeyCase,
      leftLabel: config.leftLabel, rightLabel: config.rightLabel,
      duplicatePolicy: config.duplicatePolicy, aggregateMethods: config.aggregateMethods,
      emptyValuePolicy: config.emptyValuePolicy, parseFailurePolicy: config.parseFailurePolicy,
      contextLeft: config.contextLeftIds?.map((id) => named(left, id)),
      contextRight: config.contextRightIds?.map((id) => named(right, id)),
    } }
  }
  throw new RecipeValidationError('该任务类型尚不能保存为模板')
}

function resolved(headers: string[], name: string) {
  const index = headers.indexOf(name)
  if (index < 0 || headers.lastIndexOf(name) !== index) throw new RecipeValidationError(`缺少唯一字段：${name.slice(0, 80)}`)
  return `c_${index}`
}

export function bindRecipe(spec: SingleRecipeSpec, headers: string[][]): BoundRecipe {
  if (headers.length !== recipeInputCount(spec)) throw new RecipeValidationError('输入数据集数量与模板不一致')
  const first = headers[0] ?? []
  if (spec.operation === 'filter' || spec.operation === 'clean') return { ...spec, columnId: resolved(first, spec.column) }
  if (spec.operation === 'clean-plan') return { ...spec, plan: bindCleanPlan(spec.plan, first) }
  if (spec.operation === 'filter-plan') return { ...spec, plan: { combine: spec.plan.combine,
    conditions: spec.plan.conditions.map(({ column, ...condition }) => ({ ...condition, columnId: resolved(first, column) })),
    sorts: spec.plan.sorts.map(({ column, ...sort }) => ({ ...sort, columnId: resolved(first, column) })),
    groups: spec.plan.groups?.map((group) => ({ combine: group.combine,
      conditions: group.conditions.map(({ column, ...condition }) => ({ ...condition, columnId: resolved(first, column) })) })) } }
  if (spec.operation === 'analyze') return { ...spec, pivot: spec.pivot ? {
    rowColumnId: resolved(first, spec.pivot.rowColumn), pivotColumnId: resolved(first, spec.pivot.pivotColumn),
    measure: { operation: spec.pivot.measure.operation, name: spec.pivot.measure.name,
      precision: spec.pivot.measure.precision,
      columnId: spec.pivot.measure.column ? resolved(first, spec.pivot.measure.column) : undefined } } : undefined,
  aggregate: spec.aggregate ? {
    groupColumnIds: spec.aggregate.groupColumns.map((name) => resolved(first, name)),
    measures: spec.aggregate.measures.map(({ column, ...measure }) => ({ ...measure,
      columnId: column ? resolved(first, column) : undefined })),
  } : undefined, frequencyColumnId: spec.frequencyColumn ? resolved(first, spec.frequencyColumn) : undefined }
  if (spec.operation === 'dedup') return { ...spec, columnIds: spec.columns.map((column) => resolved(first, column)) }
  if (spec.operation === 'export') return { ...spec,
    scope: spec.scope ? { startRow: spec.scope.startRow, endRow: spec.scope.endRow,
      columnIds: spec.scope.columns.map((name) => resolved(first, name)) } : undefined,
    jsonOptions: spec.jsonOptions ? { emptyAsNull: spec.jsonOptions.emptyAsNull,
      types: Object.fromEntries(Object.entries(spec.jsonOptions.types).map(([name, type]) => [resolved(first, name), type])) } : undefined }
  if (spec.operation === 'quality') return { ...spec, rules: spec.rules.map((rule) => {
    if (rule.kind === 'unique') return { kind: 'unique' as const, columnIds: rule.columns.map((name) => resolved(first, name)) }
    const columnId = resolved(first, rule.column)
    if (rule.kind === 'reference') return { kind: 'reference' as const, columnId,
      referenceId: `input:${rule.referenceInput}`, referenceColumnId: resolved(headers[rule.referenceInput] ?? [], rule.referenceColumn) }
    return rule.kind === 'required' ? { kind: 'required' as const, columnId } : rule.kind === 'length'
      ? { kind: 'length' as const, columnId, min: rule.min, max: rule.max }
      : rule.kind === 'enum' ? { kind: 'enum' as const, columnId, values: rule.values }
      : rule.kind === 'type' ? { kind: 'type' as const, columnId, dataType: rule.dataType }
      : rule.kind === 'range' ? { kind: 'range' as const, columnId, min: rule.min, max: rule.max }
      : rule.kind === 'date-order' ? { kind: 'date-order' as const, columnId, otherColumnId: resolved(first, rule.otherColumn) }
      : rule.kind === 'pattern' ? { kind: 'pattern' as const, columnId, pattern: rule.pattern }
      : { kind: 'arithmetic' as const, columnId, leftColumnId: resolved(first, rule.leftColumn),
        rightColumnId: resolved(first, rule.rightColumn), tolerance: rule.tolerance }
  }) }
  if (spec.operation === 'split') return { ...spec, config: spec.config.mode === 'rows' ? spec.config :
    { mode: 'value', columnId: resolved(first, spec.config.column), includeHeader: spec.config.includeHeader } }
  if (spec.operation === 'sql') {
    spec.requiredHeaders.forEach((required, index) => { for (const name of required) resolved(headers[index] ?? [], name) })
    return spec
  }
  if (spec.operation === 'compare') {
    const left = headers[0] ?? []
    const right = headers[1] ?? []
    return { ...spec, config: { leftKeyIds: spec.config.leftKeys.map((name) => resolved(left, name)),
      rightKeyIds: spec.config.rightKeys.map((name) => resolved(right, name)),
      fields: spec.config.fields.map(({ left: leftName, right: rightName, ...field }) => ({ ...field,
        leftColumnId: resolved(left, leftName), rightColumnId: resolved(right, rightName) })),
      trimKeys: spec.config.trimKeys, ignoreKeyCase: spec.config.ignoreKeyCase,
      leftLabel: spec.config.leftLabel, rightLabel: spec.config.rightLabel,
      duplicatePolicy: spec.config.duplicatePolicy, aggregateMethods: spec.config.aggregateMethods,
      emptyValuePolicy: spec.config.emptyValuePolicy, parseFailurePolicy: spec.config.parseFailurePolicy,
      contextLeftIds: spec.config.contextLeft?.map((name) => resolved(left, name)),
      contextRightIds: spec.config.contextRight?.map((name) => resolved(right, name)) } }
  }
  if (spec.operation === 'relation') return { ...spec, config: { kind: spec.config.kind,
    leftKeyIds: spec.config.leftKeys.map((name) => resolved(first, name)),
    rightKeyIds: spec.config.rightKeys.map((name) => resolved(headers[1] ?? [], name)),
    cardinality: spec.config.cardinality, keyType: spec.config.keyType, matchEmptyKeys: spec.config.matchEmptyKeys,
    trimKeys: spec.config.trimKeys,
    ignoreCase: spec.config.ignoreCase,
    unicodeNormalization: spec.config.unicodeNormalization,
    output: spec.config.output ? { ...spec.config.output, columns: spec.config.output.columns.map((entry) => ({
      side: entry.side, id: resolved(entry.side === 'left' ? first : headers[1] ?? [], entry.name) })) }
      : { columns: [...first.map((_, index) => ({ side: 'left' as const, id: `c_${index}` })),
        ...(headers[1] ?? []).map((_, index) => ({ side: 'right' as const, id: `c_${index}` }))],
        leftSuffix: '_左', rightSuffix: '_右', includeSourceRows: true } } }
  if (spec.operation === 'set') return { ...spec, config: { kind: spec.config.kind,
    leftKeyIds: spec.config.leftKeys.map((name) => resolved(first, name)),
    rightKeyIds: spec.config.rightKeys.map((name) => resolved(headers[1] ?? [], name)) } }
  if (spec.operation === 'reshape') return { ...spec, config: spec.config.kind === 'transpose' ? spec.config
    : spec.config.kind === 'split-column' ? { kind: 'split-column', columnId: resolved(first, spec.config.column),
      delimiter: spec.config.delimiter, direction: spec.config.direction, maxParts: spec.config.maxParts,
      keepEmpty: spec.config.keepEmpty, overflow: spec.config.overflow }
      : { kind: 'group-join', keyIds: spec.config.keys.map((name) => resolved(first, name)),
        valueId: resolved(first, spec.config.value), separator: spec.config.separator } }
  if (spec.operation === 'combine' && spec.mode === 'strict') {
    for (const candidate of headers.slice(1)) {
      if (candidate.length !== first.length || candidate.some((name, index) => name !== first[index])) {
        throw new RecipeValidationError('严格合并要求每组输入具有相同的字段和顺序')
      }
    }
  }
  return spec
}
