import { z } from 'zod'
import { entityIdSchema, jsonValueSchema, type JsonValue } from './wire.js'
import { contextKeySchema, type Step } from './step.js'
import { outputFieldNameSchema } from './output-schema.js'

export const scenarioMetricDeclSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'metric key 须小写字母开头，只含小写字母数字下划线'),
  name: z.string().trim().min(1).max(64),
  /** 映射的上下文变量名（支持通过 outputKey 写入的 context 变量） */
  fromContextKey: contextKeySchema,
  /** 如果 context 变量是对象，可通过 fromField 提取内部子属性 */
  fromField: outputFieldNameSchema.optional(),
  /** 指标单位（如 "件", "ms", "¥", "%"） */
  unit: z.string().trim().max(16).optional(),
})
export type ScenarioMetricDecl = z.infer<typeof scenarioMetricDeclSchema>

export const scenarioDataRowFieldDeclSchema = z.strictObject({
  columnKey: z.string().trim().min(1).max(64),
  columnHeader: z.string().trim().min(1).max(64),
  fromContextKey: contextKeySchema,
  fromField: outputFieldNameSchema.optional(),
})
export type ScenarioDataRowFieldDecl = z.infer<typeof scenarioDataRowFieldDeclSchema>

/** 场景的对外业务输出声明规范 */
export const scenarioOutputDeclSchema = z.strictObject({
  /** 结论模板：支持字面量或插值，如 "巡检完成，在售商品 ${item_count} 件" */
  summaryTemplate: z.string().trim().max(500).optional(),
  /** 当未配置 summaryTemplate 时，直接取该 context 变量的值作为结论 */
  summaryFromContextKey: contextKeySchema.optional(),
  /** 声明导出的核心指标列表 */
  metrics: z.array(scenarioMetricDeclSchema).max(20).default([]),
  /** 声明导出的数据宽表列 */
  dataRowFields: z.array(scenarioDataRowFieldDeclSchema).max(20).default([]),
})
export type ScenarioOutputDecl = z.infer<typeof scenarioOutputDeclSchema>

export const OUTPUT_STATUSES = ['NORMAL', 'WARNING', 'ANOMALOUS', 'UNDETERMINED'] as const
export type OutputStatus = (typeof OUTPUT_STATUSES)[number]
export const outputStatusSchema = z.enum(OUTPUT_STATUSES)

export const FINDING_SEVERITIES = ['INFO', 'WARN', 'HIGH', 'FATAL'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]
export const findingSeveritySchema = z.enum(FINDING_SEVERITIES)

/** 单个业务发现项（Inspection Finding） */
export const runFindingSchema = z.strictObject({
  id: z.string().min(1).max(64),
  severity: findingSeveritySchema,
  title: z.string().trim().min(1).max(128),
  detail: z.string().trim().max(2000).optional(),
  /** 关联的关键截图证据 ID，用于在报告或卡片中一键穿透现场 */
  evidenceId: entityIdSchema.optional(),
  /** 关联的步骤序号或 ID，便于追溯产生此发现的步骤 */
  stepOrdinal: z.number().int().nonnegative().optional(),
})
export type RunFinding = z.infer<typeof runFindingSchema>

/** 业务指标单项描述 */
export const metricValueSchema = z.union([
  z.number(),
  z.string().max(128),
  z.boolean(),
])
export type MetricValue = z.infer<typeof metricValueSchema>

export const MAX_RUN_OUTPUT_BYTES = 64 * 1024

/**
 * RunOutput：单个运行终态后的标准化业务数据包。
 * 存储于 runs.output，并在 RunDetail / 汇总报告中消费。
 */
export const runOutputSchema = z.strictObject({
  /** 一句话业务结论，人类直接可读 */
  summary: z.string().trim().min(1).max(500),
  /** 综合业务评价状态 */
  status: outputStatusSchema,
  /** 核心业务指标键值对（用于横向数值对比、看板展示） */
  metrics: z.record(z.string().max(64), metricValueSchema).default({}),
  /** 业务发现项清单（主要记录告警、异常、关键检查通过结论） */
  findings: z.array(runFindingSchema).max(50).default([]),
  /** 供场景集或横向列表消费的单行数据宽表（Key-Value） */
  dataRow: z.record(z.string().max(64), jsonValueSchema).default({}),
  /** 生成时间 ISO 字符串，由引擎装配填入 */
  assembledAt: z.string(),
})
export type RunOutput = z.infer<typeof runOutputSchema>

export type AssembleOutcomeResultItem = {
  id?: string
  contractId?: string
  meaning?: string
  severity?: string
  verdict?: string
  evidenceId?: string | null
  details?: Record<string, JsonValue> | null
  stepId?: string
  evaluatedAt?: Date | string
}

export type AssembleStepRunItem = {
  id?: string
  stepId?: string
  ordinal?: number
  name?: string | null
  status?: string
  outcomeStatus?: string
  attempts?: readonly {
    status?: string
    error?: { safeMessage?: string; message?: string; code?: string } | null
  }[]
}

export type AssembleRunOutputInput = {
  definition?: {
    steps?: readonly Step[]
    outputs?: ScenarioOutputDecl
  } | null
  outputsDecl?: ScenarioOutputDecl | null
  context?: Record<string, JsonValue> | null
  outcomeResults?: readonly AssembleOutcomeResultItem[] | null
  stepRuns?: readonly AssembleStepRunItem[] | null
  status?: string | null
  outcomeStatus?: string | null
  error?: { safeMessage?: string; message?: string; code?: string } | null
  now?: Date | string
}

function truncateString(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

function interpolateTemplate(template: string, context: Record<string, JsonValue>): string {
  return template.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      const val = context[key]
      if (val === null || val === undefined) return ''
      if (typeof val === 'object') return JSON.stringify(val)
      return String(val)
    }
    return ''
  })
}

function needsSafeSummary(status?: string | null, outcomeStatus?: string | null): boolean {
  return status === 'FAILED' || status === 'CANCELLED' || status === 'NEEDS_REVIEW' ||
    outcomeStatus === 'FAIL' || outcomeStatus === 'UNKNOWN'
}

/**
 * RunOutput.status 只表达可确认的业务评价；执行失败本身不是业务异常。
 * 已观察到的业务失败或严重发现项仍可确认为异常，未完成或未评估的其余情况为未判定。
 */
export function deriveRunOutputStatus(
  runStatus?: string | null,
  outcomeStatus?: string | null,
  findings: readonly RunFinding[] = [],
): OutputStatus {
  const businessFindings = findings.filter((finding) => finding.id !== 'f-execution-failed')
  if (
    outcomeStatus === 'FAIL' ||
    businessFindings.some((finding) => finding.severity === 'HIGH' || finding.severity === 'FATAL')
  ) return 'ANOMALOUS'
  if (runStatus !== 'SUCCEEDED' || outcomeStatus === 'UNKNOWN' || outcomeStatus === 'NOT_EVALUATED') {
    return 'UNDETERMINED'
  }
  if (outcomeStatus === 'WARN' || businessFindings.some((finding) => finding.severity === 'WARN')) {
    return 'WARNING'
  }
  return outcomeStatus === 'PASS' ? 'NORMAL' : 'UNDETERMINED'
}

/**
 * 确定性派生降级业务结论（用于无配置场景或历史存量 Run 读取回退）
 */
export function deriveFallbackSummary(
  status?: string | null,
  outcomeStatus?: string | null,
  errorMsg?: string | null,
): string {
  if (status === 'CANCELLED') {
    return '任务已被人工或系统取消。'
  } else if (status === 'FAILED') {
    return errorMsg ? `执行过程中断：${errorMsg}` : '执行过程中断。'
  } else if (status === 'NEEDS_REVIEW') {
    return '运行待人工核查，业务结果尚未确认。'
  } else if (outcomeStatus === 'PASS') {
    return '流程执行完成，所有检查项均符合预期。'
  } else if (outcomeStatus === 'WARN') {
    return '流程执行完成，存在需要注意的业务警告。'
  } else if (outcomeStatus === 'FAIL') {
    return status === 'SUCCEEDED'
      ? '流程执行完成，但业务检查未通过。'
      : '流程执行中断或未通过，发现业务异常。'
  } else if (outcomeStatus === 'UNKNOWN') {
    return status === 'SUCCEEDED'
      ? '流程执行完成，但业务结果无法确认。'
      : '业务结果无法确认。'
  } else {
    return '流程执行完成。'
  }
}

/** 历史 RunOutput 在读取时修正可能误导的结论与业务状态，保留原始指标、发现项与数据行。 */
export function projectRunOutput(
  output: RunOutput,
  status?: string | null,
  outcomeStatus?: string | null,
  errorMsg?: string | null,
): RunOutput {
  const projectedStatus = deriveRunOutputStatus(status, outcomeStatus, output.findings)
  if (!needsSafeSummary(status, outcomeStatus)) {
    return projectedStatus === output.status ? output : { ...output, status: projectedStatus }
  }
  return {
    ...output,
    status: projectedStatus,
    summary: truncateString(deriveFallbackSummary(status, outcomeStatus, errorMsg), 500),
  }
}

/** @deprecated 使用 projectRunOutput；保留旧导出以兼容既有调用方。 */
export const projectRunOutputSummary = projectRunOutput

/**
 * 纯函数：根据 Run 终态信息装配标准化业务输出包 RunOutput。
 * 遵循三级降级漏斗、纯数据无毒性与 64 KiB 上限截断保护。
 */
export function assembleRunOutput(input: AssembleRunOutputInput): RunOutput {
  const context = input.context ?? {}
  const outputsDecl = input.outputsDecl ?? input.definition?.outputs
  const outcomeResults = input.outcomeResults ?? []
  const stepRuns = input.stepRuns ?? []
  const steps = input.definition?.steps ?? []

  // 1. Findings 装配
  const findings: RunFinding[] = []
  const stepOrdinalByStepId = new Map<string, number>()
  for (const [idx, s] of steps.entries()) {
    stepOrdinalByStepId.set(s.id, idx)
  }
  for (const sr of stepRuns) {
    if (sr.stepId && sr.ordinal !== undefined) {
      stepOrdinalByStepId.set(sr.stepId, sr.ordinal)
    }
  }

  for (const res of outcomeResults) {
    if (res.verdict === 'FAIL' || res.verdict === 'WARN') {
      const severity: FindingSeverity =
        res.verdict === 'FAIL'
          ? res.severity === 'FATAL'
            ? 'FATAL'
            : 'HIGH'
          : 'WARN'
      const title = (res.meaning || '业务检查未符合预期').slice(0, 128)
      let detail: string | undefined = undefined
      if (res.details) {
        detail = JSON.stringify(res.details)
      }
      const stepOrdinal = res.stepId ? stepOrdinalByStepId.get(res.stepId) : undefined

      findings.push({
        id: (res.contractId || res.id || `f-${findings.length + 1}`).slice(0, 64),
        severity,
        title,
        ...(detail ? { detail: truncateString(detail, 2000) } : {}),
        ...(res.evidenceId && entityIdSchema.safeParse(res.evidenceId).success ? { evidenceId: res.evidenceId } : {}),
        ...(stepOrdinal !== undefined ? { stepOrdinal } : {}),
      })
      if (findings.length >= 50) break
    }
  }

  // 若无 Outcome 违规但 Run 或步骤 FAILED，则自动注入执行异常 Finding
  if (findings.length === 0 && input.status === 'FAILED') {
    let failedOrdinal: number | undefined = undefined
    let errorMsg = input.error?.safeMessage || input.error?.message || input.error?.code
    for (const sr of stepRuns) {
      if (sr.status === 'FAILED') {
        failedOrdinal = sr.ordinal
        const failedAttempt = sr.attempts?.find((a) => a.status === 'FAILED')
        if (failedAttempt?.error) {
          errorMsg = failedAttempt.error.safeMessage || failedAttempt.error.message || failedAttempt.error.code || errorMsg
        }
        break
      }
    }
    findings.push({
      id: 'f-execution-failed',
      severity: 'HIGH',
      title: '步骤执行异常中断',
      detail: truncateString(errorMsg || '流程执行过程中断或遇到无法恢复的错误', 2000),
      ...(failedOrdinal !== undefined ? { stepOrdinal: failedOrdinal } : {}),
    })
  }

  // 2. Metrics 装配
  const metrics: Record<string, MetricValue> = {}
  if (outputsDecl?.metrics && outputsDecl.metrics.length > 0) {
    for (const decl of outputsDecl.metrics) {
      let val = context[decl.fromContextKey]
      if (decl.fromField && val && typeof val === 'object' && !Array.isArray(val)) {
        val = (val as Record<string, JsonValue>)[decl.fromField]
      }
      if (typeof val === 'number' || typeof val === 'boolean') {
        metrics[decl.key] = val
      } else if (typeof val === 'string') {
        metrics[decl.key] = truncateString(val, 128)
      }
    }
  } else {
    // 降级兜底：自动收集 extract / ai_extract 产出的标量变量
    for (const step of steps) {
      if ((step.type === 'extract' || step.type === 'ai_extract') && step.outputKey) {
        const val = context[step.outputKey]
        if (typeof val === 'number' || typeof val === 'boolean') {
          metrics[step.outputKey] = val
        } else if (typeof val === 'string') {
          metrics[step.outputKey] = truncateString(val, 128)
        }
      }
    }
  }

  // 3. DataRow 装配
  const dataRow: Record<string, JsonValue> = {}
  if (outputsDecl?.dataRowFields && outputsDecl.dataRowFields.length > 0) {
    for (const decl of outputsDecl.dataRowFields) {
      let val = context[decl.fromContextKey]
      if (decl.fromField && val && typeof val === 'object' && !Array.isArray(val)) {
        val = (val as Record<string, JsonValue>)[decl.fromField]
      }
      dataRow[decl.columnKey] = val ?? null
    }
  }

  // 4. Status 映射：执行状态与业务评价保持独立
  const status = deriveRunOutputStatus(input.status, input.outcomeStatus, findings)

  // 5. Summary 装配与降级
  let summary = ''
  if (needsSafeSummary(input.status, input.outcomeStatus)) {
    const firstErrMsg = input.error?.safeMessage || input.error?.message || input.error?.code
    summary = deriveFallbackSummary(input.status, input.outcomeStatus, firstErrMsg)
  } else if (outputsDecl?.summaryTemplate) {
    summary = interpolateTemplate(outputsDecl.summaryTemplate, { ...context, ...metrics }).trim()
  } else if (outputsDecl?.summaryFromContextKey) {
    const rawVal = context[outputsDecl.summaryFromContextKey]
    if (rawVal !== undefined && rawVal !== null) {
      summary = String(rawVal).trim()
    }
  }

  if (!summary) {
    const firstErrMsg = input.error?.safeMessage || input.error?.message || input.error?.code
    summary = deriveFallbackSummary(input.status, input.outcomeStatus, firstErrMsg)
  }
  summary = truncateString(summary, 500)

  const assembledAt =
    input.now instanceof Date
      ? input.now.toISOString()
      : typeof input.now === 'string'
        ? input.now
        : new Date().toISOString()

  let result: RunOutput = {
    summary,
    status,
    metrics,
    findings,
    dataRow,
    assembledAt,
  }

  // 6. 体积保护：限制在 64 KiB 内
  const encoder = new TextEncoder()
  let serialized = JSON.stringify(result)
  if (encoder.encode(serialized).length > MAX_RUN_OUTPUT_BYTES) {
    // 截断 dataRow
    result.dataRow = {}
    // 截短 findings
    result.findings = result.findings.slice(0, 10).map((f) => ({
      ...f,
      detail: f.detail ? truncateString(f.detail, 200) : undefined,
    }))
    if (!result.summary.endsWith('(已截断)')) {
      result.summary = truncateString(result.summary, 480) + ' (已截断)'
    }
    serialized = JSON.stringify(result)

    // 若依然超大，进一步裁切
    if (encoder.encode(serialized).length > MAX_RUN_OUTPUT_BYTES) {
      result.findings = []
      result.metrics = {}
    }
  }

  return runOutputSchema.parse(result)
}
