import { z } from 'zod'
import {
  implementationKeySchema,
  moduleExecutionModeSchema,
  type ModuleExecutionMode,
} from './action-module-vocabulary.js'
import { outputFieldNameSchema } from './output-schema.js'
import type { ScenarioDocument } from './scenario.js'
import {
  contextKeySchema,
  effectTypeSchema,
  FORBIDDEN_CONTEXT_KEYS,
  scenarioInputDeclSchema,
  stepSchema,
  type EffectType,
  type ScenarioInputDecl,
  type Step,
} from './step.js'
import {
  entityIdSchema,
  jsonValueSchema,
  RUNTIME_SCHEMA_VERSION,
  runtimeSchemaVersionSchema,
  type EntityId,
  type JsonValue,
} from './wire.js'

// ---------------------------------------------------------------------------
// Worker protocol capability constant
// ---------------------------------------------------------------------------

/**
 * Worker 声明支持包含 moduleManifest 的快照协议能力标识。
 * 未声明此能力的 Worker 在调度领取时自动被排除，避免因未知快照字段反序列化失败。
 */
export const MODULE_MANIFEST_PROTOCOL = 'snapshot.moduleManifest@1'
export const CANDIDATE_GROUPS_PROTOCOL = 'snapshot.candidateGroups@1'
export const SELECTION_DECISION_PROTOCOL = 'module.selectionDecision@1'
export const MODULE_SELECTION_MODES = ['pinned', 'frozen_fallback'] as const
export type ModuleSelectionMode = (typeof MODULE_SELECTION_MODES)[number]
export const SKIP_REASONS = ['fallback', 'not_attempted', 'not_needed'] as const
export type SkipReason = (typeof SKIP_REASONS)[number]

// ---------------------------------------------------------------------------
// Authoring document node types
// ---------------------------------------------------------------------------

/** 普通独立步骤节点 */
export const authoringStepNodeSchema = z.strictObject({
  kind: z.literal('step'),
  step: stepSchema,
  /** 仅“展开为独立步骤”后的来源追溯说明，不参与运行时判定 */
  origin: z
    .strictObject({
      moduleVersionId: entityIdSchema,
      invocationId: entityIdSchema,
    })
    .optional(),
})
export type AuthoringStepNode = z.infer<typeof authoringStepNodeSchema>

/** 模块输入参数绑定定义 */
export const moduleInputBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('literal'),
    value: jsonValueSchema,
  }),
  z.strictObject({
    kind: z.literal('from'),
    key: contextKeySchema,
    field: outputFieldNameSchema.optional(),
  }),
])
export type ModuleInputBinding = z.infer<typeof moduleInputBindingSchema>

/** 动作模块草稿引用（仅试跑模式允许使用） */
export const moduleDraftRefSchema = z.strictObject({
  moduleId: entityIdSchema,
  revision: z.number().int().nonnegative(),
  contentDigest: z.string().min(1).max(128),
})
export type ModuleDraftRef = z.infer<typeof moduleDraftRefSchema>

export const moduleInvocationSelectionSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('pinned'),
    implementationKey: implementationKeySchema,
  }),
  z
    .strictObject({
      mode: z.literal('frozen_fallback'),
      candidates: z.array(implementationKeySchema).min(2).max(3),
    })
    .superRefine((value, ctx) => {
      const seen = new Set<string>()
      for (const [index, key] of value.candidates.entries()) {
        if (seen.has(key)) {
          ctx.addIssue({ code: 'custom', path: ['candidates', index], message: '回退候选不能重复' })
        }
        seen.add(key)
      }
    }),
])
export type ModuleInvocationSelection = z.infer<typeof moduleInvocationSelectionSchema>

/** 动作模块调用节点 */
export const authoringModuleInvocationSchema = z.strictObject({
  kind: z.literal('module'),
  invocationId: entityIdSchema,
  name: z.string().trim().min(1).max(128).optional(),
  moduleId: entityIdSchema,
  /** 精确已发布版本 ID（正式发布场景必须提供） */
  moduleVersionId: entityIdSchema.optional(),
  /** 模块草稿快照（仅试跑可用） */
  moduleDraft: moduleDraftRefSchema.optional(),
  /** 实现键，pinned 缺省为 default；frozen_fallback 时记首选 */
  implementationKey: implementationKeySchema.default('default'),
  selection: moduleInvocationSelectionSchema.optional(),
  /** 输入绑定映射：{ [moduleInputKey]: binding } */
  inputBindings: z.record(contextKeySchema, moduleInputBindingSchema).default({}),
  /** 输出暴露映射：{ [moduleOutputKey]: sceneContextKey } */
  outputBindings: z.record(contextKeySchema, contextKeySchema).default({}),
})
export type AuthoringModuleInvocation = z.infer<typeof authoringModuleInvocationSchema>

export function resolveInvocationSelection(invocation: AuthoringModuleInvocation): {
  mode: ModuleSelectionMode
  keys: string[]
} {
  if (invocation.selection?.mode === 'frozen_fallback') {
    return { mode: 'frozen_fallback', keys: invocation.selection.candidates }
  }
  if (invocation.selection?.mode === 'pinned') {
    return { mode: 'pinned', keys: [invocation.selection.implementationKey] }
  }
  return { mode: 'pinned', keys: [invocation.implementationKey] }
}

/** 编写节点联合体 */
export const authoringNodeSchema = z.discriminatedUnion('kind', [
  authoringStepNodeSchema,
  authoringModuleInvocationSchema,
])
export type AuthoringNode = z.infer<typeof authoringNodeSchema>

export const MAX_AUTHORING_NODES = 64

// ---------------------------------------------------------------------------
// Scenario Authoring Document V2
// ---------------------------------------------------------------------------

export const scenarioAuthoringDocumentV2Schema = z
  .strictObject({
    authoringSchemaVersion: z.literal(2),
    schemaVersion: runtimeSchemaVersionSchema.default(RUNTIME_SCHEMA_VERSION),
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    nodes: z.array(authoringNodeSchema).min(1).max(MAX_AUTHORING_NODES),
  })
  .superRefine((document, ctx) => {
    const inputKeys = new Set<string>()
    for (const [index, input] of document.inputs.entries()) {
      if (inputKeys.has(input.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs', index, 'key'],
          message: '同一场景内 inputs.key 不能重复',
        })
      }
      inputKeys.add(input.key)
    }

    const invocationIds = new Set<string>()
    const stepIds = new Set<string>()
    for (const [index, node] of document.nodes.entries()) {
      if (node.kind === 'step') {
        if (stepIds.has(node.step.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'step', 'id'],
            message: '场景内 step.id 不能重复',
          })
        }
        stepIds.add(node.step.id)
      } else if (node.kind === 'module') {
        if (invocationIds.has(node.invocationId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'invocationId'],
            message: '场景内 module invocationId 不能重复',
          })
        }
        invocationIds.add(node.invocationId)

        if (!node.moduleVersionId && !node.moduleDraft) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index],
            message: '模块调用节点必须提供 moduleVersionId 或 moduleDraft',
          })
        }
      }
    }
  })
export type ScenarioAuthoringDocumentV2 = z.infer<typeof scenarioAuthoringDocumentV2Schema>

/** 统一的场景编写文档类型（规范为 V2） */
export type ScenarioAuthoringDocument = ScenarioAuthoringDocumentV2

export type ScenarioAuthoringNode = AuthoringNode
export type ScenarioStepNode = AuthoringStepNode
export type ScenarioModuleInvocationNode = AuthoringModuleInvocation

// ---------------------------------------------------------------------------
// Module Manifest (运行快照与版本记录)
// ---------------------------------------------------------------------------

export const moduleManifestEntrySchema = z.strictObject({
  invocationId: entityIdSchema,
  ordinal: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(128),
  moduleId: entityIdSchema,
  moduleKey: z.string().min(1).max(64),
  moduleVersionId: entityIdSchema.optional(),
  versionNo: z.number().int().positive().optional(),
  moduleDraftRevision: z.number().int().nonnegative().optional(),
  contentDigest: z.string().min(1).max(128),
  contractDigest: z.string().min(1).max(128),
  implementationDigest: z.string().min(1).max(128),
  implementationKey: z.string().min(1).max(64),
  selectedImplementationDigest: z.string().min(1).max(128).optional(),
  selectionMode: z.enum(MODULE_SELECTION_MODES).optional(),
  executionMode: moduleExecutionModeSchema,
  effectCeiling: effectTypeSchema,
  expandedStepIds: z.array(entityIdSchema),
  internalToExpanded: z.record(z.string(), entityIdSchema),
  preconditionStepIds: z.array(entityIdSchema).default([]),
  postconditionStepIds: z.array(entityIdSchema).default([]),
  outputRequired: z.array(z.string()).default([]),
  inputBindingsDigest: z.string().min(1).max(128),
})
export type ModuleManifestEntry = z.infer<typeof moduleManifestEntrySchema>

export const candidateAlternativeSchema = z.strictObject({
  implementationKey: implementationKeySchema,
  implementationDigest: z.string().min(1).max(128),
  stepIds: z.array(entityIdSchema).min(1),
  postconditionStepIds: z.array(entityIdSchema).default([]),
  outputStaging: z.record(z.string(), z.string()),
})
export type CandidateAlternative = z.infer<typeof candidateAlternativeSchema>

export const candidateGroupSchema = z.strictObject({
  groupId: entityIdSchema,
  invocationId: entityIdSchema,
  alternatives: z.array(candidateAlternativeSchema).min(2).max(3),
})
export type CandidateGroup = z.infer<typeof candidateGroupSchema>

export const candidateGroupsSchema = z.strictObject({
  groups: z.array(candidateGroupSchema).max(32),
})
export type CandidateGroups = z.infer<typeof candidateGroupsSchema>

export const selectionDecisionAttemptSchema = z.strictObject({
  implementationKey: implementationKeySchema,
  outcome: z.enum(['succeeded', 'failed', 'skipped']),
  attribution: z.enum(['MODULE', 'EXTERNAL_INFRA', 'UNKNOWN']).optional(),
  failedStepId: entityIdSchema.optional(),
})
export type SelectionDecisionAttempt = z.infer<typeof selectionDecisionAttemptSchema>

export const selectionDecisionSchema = z.strictObject({
  kind: z.literal('module_selection_decision'),
  protocol: z.literal(SELECTION_DECISION_PROTOCOL),
  invocationId: entityIdSchema,
  attempts: z.array(selectionDecisionAttemptSchema).min(1).max(3),
  selected: implementationKeySchema.optional(),
  reason: z.enum(['selected', 'all_failed', 'external_infra', 'unknown', 'needs_review']),
})
export type SelectionDecision = z.infer<typeof selectionDecisionSchema>

export const moduleManifestSchema = z.strictObject({
  entries: z.array(moduleManifestEntrySchema).max(32),
  candidateGroups: z.array(candidateGroupSchema).max(32).optional(),
})
export type ModuleManifest = z.infer<typeof moduleManifestSchema>

export function candidateGroupsOf(input: {
  candidateGroups?: CandidateGroups | null
  moduleManifest?: { candidateGroups?: CandidateGroup[] | null } | null
}): CandidateGroup[] {
  if (input.candidateGroups?.groups?.length) return input.candidateGroups.groups
  return input.moduleManifest?.candidateGroups ?? []
}

// ---------------------------------------------------------------------------
// V1 / V2 Normalizer & Utilities
// ---------------------------------------------------------------------------

export function isAuthoringDocumentV2(raw: unknown): raw is ScenarioAuthoringDocumentV2 {
  if (raw === null || typeof raw !== 'object') return false
  const doc = raw as Record<string, unknown>
  return doc.authoringSchemaVersion === 2 && Array.isArray(doc.nodes)
}

/**
 * 将任意草稿输入（V1 扁平文档或 V2 文档）无损归一化为标准的 ScenarioAuthoringDocumentV2。
 * 若传入 V1 格式，自动将 steps 列表包装为 StepNode 列表。
 */
export function normalizeAuthoringDocument(raw: unknown): ScenarioAuthoringDocumentV2 {
  if (isAuthoringDocumentV2(raw)) {
    return scenarioAuthoringDocumentV2Schema.parse(raw)
  }

  // 尝试按 V1 ScenarioDocument 适配
  if (raw !== null && typeof raw === 'object') {
    const doc = raw as Record<string, unknown>
    if (Array.isArray(doc.steps)) {
      const v2Object = {
        authoringSchemaVersion: 2 as const,
        schemaVersion: doc.schemaVersion ?? RUNTIME_SCHEMA_VERSION,
        inputs: doc.inputs ?? [],
        nodes: (doc.steps as Step[]).map((step) => ({
          kind: 'step' as const,
          step,
        })),
      }
      return scenarioAuthoringDocumentV2Schema.parse(v2Object)
    }
  }

  throw new Error('无法解析为合法的场景编写文档（非 V1 亦非 V2 格式）')
}

export const toAuthoringDocumentV2 = normalizeAuthoringDocument

export function authoringNodeId(node: AuthoringNode): string {
  return node.kind === 'step' ? node.step.id : node.invocationId
}

export function authoringHasModuleInvocations(document: ScenarioAuthoringDocumentV2): boolean {
  return document.nodes.some((node) => node.kind === 'module')
}

/** V1 取 steps；V2 只收集 StepNode，调用节点不计入。 */
export function authoringSteps(document: ScenarioAuthoringDocumentV2 | { steps: Step[] }): Step[] {
  if (isAuthoringDocumentV2(document)) {
    return document.nodes.flatMap((node) => (node.kind === 'step' ? [node.step] : []))
  }
  return document.steps
}

