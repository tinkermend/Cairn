import { z } from 'zod'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'
import { runStatusSchema } from './run.js'
import { outcomeStatusSchema } from './outcome.js'
import { executionErrorCategorySchema } from './runtime-error.js'
import { externalOutcomeResultSchema } from './service-access.js'
import { type ScenarioInputDecl } from './step.js'
import {
  calendarTimeRuleSchema,
  intervalTimeRuleSchema,
  knowledgeAnalysisScheduleConsumerSchema,
  previewScheduleWindows,
  timeRuleFromPreviewQuery,
  type ScheduleDefinition,
  type ScheduleTimeRule,
  type ScheduleWeekday,
} from './schedules.js'

// ============================================================================
// D1: 知识积累、变更影响与流程洞察
// ============================================================================

export const KNOWLEDGE_INSIGHT_KINDS = [
  'term',
  'experience',
  'failure_mode',
  'knowledge_revision',
  'map_refresh_suggestion',
] as const
export type KnowledgeInsightKind = (typeof KNOWLEDGE_INSIGHT_KINDS)[number]
export const knowledgeInsightKindSchema = z.enum(KNOWLEDGE_INSIGHT_KINDS)

export const knowledgeInsightRequestSchema = z.strictObject({
  targetId: entityIdSchema,
  questionKind: z.enum([
    'failure_clustering',
    'experience_mining',
    'change_impact',
    'process_insight',
  ]),
  sourceScope: z.record(z.string(), z.unknown()).default({}),
  window: z
    .strictObject({
      from: utcInstantSchema.optional(),
      to: utcInstantSchema.optional(),
    })
    .default({}),
  baselineRefs: z.array(z.string()).default([]),
  budget: z.record(z.string(), z.unknown()).optional(),
  requestKey: z.string().min(8).max(128),
})
export type KnowledgeInsightRequest = z.infer<typeof knowledgeInsightRequestSchema>

export const knowledgeInsightFactsSchema = z.strictObject({
  manifest: z.record(z.string(), z.unknown()),
  cohorts: z.array(z.record(z.string(), z.unknown())).default([]),
  metrics: z.record(z.string(), z.unknown()).default({}),
  representatives: z.array(z.record(z.string(), z.unknown())).default([]),
  counterexamples: z.array(z.record(z.string(), z.unknown())).default([]),
  coverageGaps: z.array(z.string()).default([]),
})
export type KnowledgeInsightFacts = z.infer<typeof knowledgeInsightFactsSchema>

export const knowledgeInsightSchema = z.strictObject({
  insightId: entityIdSchema,
  kind: knowledgeInsightKindSchema,
  title: z.string().min(1).max(200),
  claims: z.array(z.string().min(1).max(2000)).min(1),
  sourceRefs: z.array(
    z.strictObject({
      kind: z.string().min(1),
      id: z.string().min(1),
      revision: z.union([z.string(), z.number()]).optional(),
      attemptId: z.string().optional(),
    }),
  ),
  applicability: z.strictObject({
    targetId: entityIdSchema,
    scenarioVersionRef: z.string().optional(),
    accountCategory: z.string().optional(),
    observedWindow: z.string().optional(),
  }),
  unknowns: z.array(z.string()).default([]),
  suggestedAction: z.strictObject({
    actionType: z.string().min(1),
    destination: z.record(z.string(), z.unknown()).default({}),
    payload: z.record(z.string(), z.unknown()).default({}),
  }),
})
export type KnowledgeInsight = z.infer<typeof knowledgeInsightSchema>

export const changeImpactSchema = z.strictObject({
  impactId: entityIdSchema,
  fromRef: z.string().min(1),
  toRef: z.string().min(1),
  changedAssets: z.array(
    z.strictObject({
      assetType: z.string().min(1),
      assetId: z.string().min(1),
      changeType: z.enum(['created', 'modified', 'deleted']),
    }),
  ),
  confirmedRefs: z.array(z.string()).default([]),
  possibleRefs: z.array(z.string()).default([]),
  scanCoverage: z.strictObject({
    totalScanned: z.number().int().nonnegative(),
    gaps: z.array(z.string()).default([]),
  }),
})
export type ChangeImpact = z.infer<typeof changeImpactSchema>

export const insightReviewDecisionSchema = z.enum([
  'accept',
  'revise_and_accept',
  'stow',
  'reject',
])
export type InsightReviewDecision = z.infer<typeof insightReviewDecisionSchema>

export const insightReviewSchema = z.strictObject({
  insightId: entityIdSchema,
  expectedRevision: z.number().int().positive(),
  decision: insightReviewDecisionSchema,
  destination: z.record(z.string(), z.unknown()).default({}),
  requestKey: z.string().min(8).max(128),
})
export type InsightReview = z.infer<typeof insightReviewSchema>

// ============================================================================
// D2: 运营诊断、调度辅助与安全动作建议
// ============================================================================

export const OPERATIONS_QUESTION_KINDS = [
  'capacity',
  'queue_backlog',
  'auth_waiting',
  'worker_anomaly',
  'model_cost',
  'schedule_draft',
] as const
export type OperationsQuestionKind = (typeof OPERATIONS_QUESTION_KINDS)[number]
export const operationsQuestionKindSchema = z.enum(OPERATIONS_QUESTION_KINDS)

export const operationsQuestionSchema = z.strictObject({
  kind: operationsQuestionKindSchema,
  scope: z
    .strictObject({
      targetId: entityIdSchema.optional(),
      scenarioId: entityIdSchema.optional(),
      workerId: z.string().optional(),
    })
    .default({}),
  window: z.string().default('24h'),
  referenceTime: utcInstantSchema,
  budget: z.record(z.string(), z.unknown()).optional(),
  requestKey: z.string().min(8).max(128),
})
export type OperationsQuestion = z.infer<typeof operationsQuestionSchema>

export const operationsFactsSchema = z.strictObject({
  metrics: z.record(z.string(), z.unknown()).default({}),
  seriesSummary: z
    .array(
      z.strictObject({
        name: z.string(),
        pointsCount: z.number().int().nonnegative(),
        latestValue: z.union([z.number(), z.string(), z.null()]),
      }),
    )
    .default([]),
  queueReasons: z.array(z.string()).default([]),
  incidents: z.array(z.record(z.string(), z.unknown())).default([]),
  relatedRefs: z
    .array(
      z.strictObject({
        kind: z.string(),
        id: z.string(),
      }),
    )
    .default([]),
  freshness: z.strictObject({
    sampledAt: utcInstantSchema,
    ageMs: z.number().int().nonnegative(),
  }),
})
export type OperationsFacts = z.infer<typeof operationsFactsSchema>

export const operationsDiagnosisSchema = z.strictObject({
  diagnosisId: entityIdSchema,
  kind: operationsQuestionKindSchema,
  observations: z.array(z.string()).min(1),
  hypotheses: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  missingChecks: z.array(z.string()).default([]),
  suggestedActions: z
    .array(
      z.strictObject({
        actionKey: z.string(),
        label: z.string(),
        safe: z.boolean(),
      }),
    )
    .default([]),
  observedAt: utcInstantSchema.optional(),
  validUntil: utcInstantSchema.nullable().optional(),
})
export type OperationsDiagnosis = z.infer<typeof operationsDiagnosisSchema>

export const scheduleProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  definition: z.record(z.string(), z.unknown()),
  baselineRevision: z.number().int().nonnegative(),
  ownerRefs: z.array(z.string()).default([]),
  inputDigest: z.string().default(''),
  timezone: z.string().min(1).max(64),
  preview: z.array(utcInstantSchema).max(20),
  unknowns: z.array(z.string()).default([]),
})
export type ScheduleProposal = z.infer<typeof scheduleProposalSchema>

export const OPERATIONS_ALLOWED_ACTION_KEYS = [
  'schedule.pause',
  'schedule.resume',
  'run.cancel_single',
] as const
export type OperationsAllowedActionKey = (typeof OPERATIONS_ALLOWED_ACTION_KEYS)[number]
export const operationsAllowedActionKeySchema = z.enum(OPERATIONS_ALLOWED_ACTION_KEYS)

export const operationsActionProposalSchema = z.strictObject({
  proposalId: entityIdSchema,
  actionKey: operationsAllowedActionKeySchema,
  resources: z
    .array(
      z.strictObject({
        kind: z.enum(['schedule', 'run']),
        id: entityIdSchema,
        name: z.string().optional(),
      }),
    )
    .min(1)
    .max(1), // 严格限制单资源，禁止批量
  preconditions: z.array(z.string()).default([]),
  expectedRevision: z.number().int().positive(),
  impact: z.string().min(1).max(512),
  expiresAt: utcInstantSchema,
})
export type OperationsActionProposal = z.infer<typeof operationsActionProposalSchema>

// ============================================================================
// D3: 外部 Agent 工具目录、契约与结果回执
// ============================================================================

export const externalToolDescriptorSchema = z.strictObject({
  key: z.string().min(1).max(128),
  descriptorVersion: z.string().min(1).max(32),
  scenarioVersionRef: z.string().min(1),
  description: z.string().min(1).max(2048),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
})
export type ExternalToolDescriptor = z.infer<typeof externalToolDescriptorSchema>

export const externalToolPolicySchema = z.strictObject({
  requiredScopes: z.array(z.string()).default([]),
  targetScope: z.array(entityIdSchema).default([]),
  accountChoices: z.array(entityIdSchema).default([]),
  effectType: z.enum(['read_only', 'idempotent_mutation', 'stateful_mutation']),
  limits: z.strictObject({
    maxDurationMs: z.number().int().positive().default(300_000),
    maxBytes: z.number().int().positive().default(1_048_576),
  }),
})
export type ExternalToolPolicy = z.infer<typeof externalToolPolicySchema>

export const externalToolCatalogSchema = z.strictObject({
  revision: z.number().int().positive(),
  principalScopeDigest: z.string().min(1),
  items: z.array(externalToolDescriptorSchema),
  nextCursor: z.string().nullable().default(null),
})
export type ExternalToolCatalog = z.infer<typeof externalToolCatalogSchema>

export const externalToolCallSchema = z.strictObject({
  key: z.string().min(1).max(128).optional(),
  descriptorVersion: z.string().min(1).max(32).optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  targetAccountId: entityIdSchema,
  requestKey: z.string().min(8).max(128),
  async: z.boolean().optional().default(false),
})
export type ExternalToolCall = z.infer<typeof externalToolCallSchema>

/** 需要人工介入才能继续：认证等待、人工复核或调试挂起。 */
export const externalToolAttentionSchema = z.strictObject({
  reason: z.enum(['WAITING_FOR_AUTH', 'NEEDS_REVIEW', 'HOLDING']),
  message: z.string().min(1).max(512),
})
export type ExternalToolAttention = z.infer<typeof externalToolAttentionSchema>

/** 未在同步窗口内结束：调用方凭 pollUrl（需 run:read）继续查询。 */
export const externalToolReceiptSchema = z.strictObject({
  callId: entityIdSchema,
  runId: entityIdSchema,
  status: z.enum(['ACCEPTED', 'RUNNING']),
  executionStatus: runStatusSchema,
  attention: externalToolAttentionSchema.nullable(),
  pollUrl: z.string().min(1),
  createdAt: utcInstantSchema,
})
export type ExternalToolReceipt = z.infer<typeof externalToolReceiptSchema>

/**
 * 执行状态、业务结果与证据完整性分别表达：executionStatus=SUCCEEDED 不代表业务通过。
 * outputs 只含已审定对外放行的步骤输出；errors 只给平台结构化分类，不给页面原文。
 */
export const externalToolResultSchema = z.strictObject({
  callId: entityIdSchema,
  runId: entityIdSchema,
  statusRefs: z.record(z.string(), z.string()).default({}),
  executionStatus: runStatusSchema,
  outcomeStatus: outcomeStatusSchema,
  outcomeResults: z.array(externalOutcomeResultSchema),
  evidenceStatus: z.enum(['PENDING', 'COMPLETE', 'INCOMPLETE']),
  outputs: z.array(z.strictObject({ stepName: z.string().min(1), payload: jsonValueSchema })),
  errors: z.array(
    z.strictObject({
      stepName: z.string().min(1),
      errorCode: z.string().min(1),
      errorCategory: executionErrorCategorySchema.nullable(),
      retryable: z.boolean().nullable(),
    }),
  ),
  unknowns: z.array(z.string()).default([]),
})
export type ExternalToolResult = z.infer<typeof externalToolResultSchema>

// ============================================================================
// 纯函数：scenarioInputsToJsonSchema 与 previewOccurrences
// ============================================================================

/**
 * 将场景定义的输入规范确定性转换为符合 JSON Schema Draft-07 的结构对象
 */
export function scenarioInputsToJsonSchema(
  inputs: readonly ScenarioInputDecl[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const input of inputs) {
    let propDef: Record<string, unknown>

    switch (input.type) {
      case 'number':
        propDef = { type: 'number' }
        break
      case 'boolean':
        propDef = { type: 'boolean' }
        break
      case 'url':
      case 'file':
        propDef = { type: 'string', format: 'uri' }
        break
      case 'json':
        propDef = { type: 'object' }
        break
      case 'string':
      default: {
        const lowerKey = input.key.toLowerCase()
        const isSecret =
          lowerKey.includes('secret') ||
          lowerKey.includes('password') ||
          lowerKey.includes('token') ||
          lowerKey.includes('apikey') ||
          lowerKey.endsWith('key') ||
          (input.label && (input.label.includes('密钥') || input.label.includes('密码')))

        if (isSecret) {
          propDef = { type: 'string', format: 'password' }
        } else {
          propDef = { type: 'string' }
        }
        break
      }
    }

    if ((input as { secret?: boolean }).secret) {
      propDef.format = 'password'
    }

    if (input.description) {
      propDef.description = input.description
    } else if (input.label) {
      propDef.description = input.label
    }

    properties[input.key] = propDef

    if (input.required) {
      required.push(input.key)
    }
  }

  const schema: Record<string, unknown> = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties,
    additionalProperties: false,
  }

  if (required.length > 0) {
    schema.required = required
  }

  return schema
}

export interface PreviewOccurrencesOptions {
  timeRule?: ScheduleTimeRule
  cronExpr?: string
  timezone: string
  referenceTime?: string | Date
  count?: number
}

/**
 * 纯函数：基于指定时区与时间规则/Cron 表达式，确定性计算未来 count 次触发时间点 (ISO 字符串格式)
 */
export function previewOccurrences(options: PreviewOccurrencesOptions): string[] {
  const count = options.count ?? 5
  const timezone = options.timezone || 'Asia/Shanghai'
  const asOf = options.referenceTime
    ? typeof options.referenceTime === 'string'
      ? new Date(options.referenceTime)
      : options.referenceTime
    : new Date()

  let timeRule: ScheduleTimeRule

  if (options.timeRule) {
    timeRule = options.timeRule
  } else if (options.cronExpr) {
    // 简单解析 5 段式标准 Cron: "minute hour dayOfMonth month dayOfWeek"
    // 例如 "0 2 * * 1-5" 或 "30 9 * * *"
    const parts = options.cronExpr.trim().split(/\s+/)
    if (parts.length >= 5) {
      const minute = parts[0]!.padStart(2, '0')
      const hour = parts[1]!.padStart(2, '0')
      const windowStart = `${hour}:${minute}`
      // 默认给一个 30 分钟窗口
      const endMinute = (Number(minute) + 30) % 60
      const endHour = (Number(hour) + Math.floor((Number(minute) + 30) / 60)) % 24
      const windowEnd = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}`

      let weekdays: ScheduleWeekday[] = [1, 2, 3, 4, 5, 6, 7]
      const dowPart = parts[4]!
      if (dowPart !== '*') {
        if (dowPart.includes('-')) {
          const [start, end] = dowPart.split('-').map(Number)
          if (start && end && start <= end) {
            weekdays = Array.from({ length: end - start + 1 }, (_, i) => (start + i) as ScheduleWeekday)
          }
        } else if (dowPart.includes(',')) {
          weekdays = dowPart.split(',').map(Number) as ScheduleWeekday[]
        } else if (!Number.isNaN(Number(dowPart))) {
          weekdays = [Number(dowPart) as ScheduleWeekday]
        }
      }

      timeRule = calendarTimeRuleSchema.parse({
        kind: 'calendar',
        timezone,
        weekdays,
        windows: [{ ruleId: 'default', windowStart, windowEnd }],
        misfire: 'skip',
      })
    } else {
      timeRule = calendarTimeRuleSchema.parse({
        kind: 'calendar',
        timezone,
        weekdays: [1, 2, 3, 4, 5],
        windows: [{ ruleId: 'default', windowStart: '02:00', windowEnd: '03:00' }],
        misfire: 'skip',
      })
    }
  } else {
    timeRule = calendarTimeRuleSchema.parse({
      kind: 'calendar',
      timezone,
      weekdays: [1, 2, 3, 4, 5],
      windows: [{ ruleId: 'default', windowStart: '02:00', windowEnd: '03:00' }],
      misfire: 'skip',
    })
  }

  // 构造轻量虚拟定义并调用 previewScheduleWindows
  const definition: ScheduleDefinition = {
    timeRule,
    consumer: {
      type: 'knowledge_analysis',
      targetId: '00000000-0000-4000-8000-000000000001',
      mode: 'map_quality',
      source: { includeFailures: false },
      strategyVersion: '1.0',
      budget: { maxItems: 100, useAi: false },
    },
    timezone: timeRule.kind === 'calendar' ? timeRule.timezone : 'UTC',
    weekdays: timeRule.kind === 'calendar' ? timeRule.weekdays : [1, 2, 3, 4, 5, 6, 7],
    windowStart: timeRule.kind === 'calendar' ? timeRule.windows[0]?.windowStart ?? '00:00' : '00:00',
    windowEnd: timeRule.kind === 'calendar' ? timeRule.windows[0]?.windowEnd ?? '23:59' : '23:59',
    misfire: timeRule.misfire,
  }

  const windows = previewScheduleWindows({
    scheduleId: '00000000-0000-4000-8000-000000000000',
    definition,
    asOf,
    limit: count * 2, // 留出冗余以防存在 skipped
  })

  const results: string[] = []
  for (const win of windows) {
    if (win.kind === 'ok') {
      results.push(win.windowStartUtc)
      if (results.length >= count) break
    }
  }

  return results
}
