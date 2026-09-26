import { z } from 'zod'
import {
  implementationKeySchema,
  moduleExecutionModeSchema,
  type ModuleExecutionMode,
} from './action-module-vocabulary.js'
import { outcomeContractSchema, type OutcomeContract } from './outcome.js'
import { runtimeInvariantSchema } from './runtime-invariant.js'
import { outputFieldNameSchema } from './output-schema.js'
import { scenarioOutputDeclSchema } from './run-output.js'
import { resolutionPolicySchema } from './resolution-policy.js'
import type { ScenarioDocument } from './scenario.js'
import { conditionSchema, type Expr } from './expression.js'
import {
  contextKeySchema,
  effectTypeSchema,
  FORBIDDEN_CONTEXT_KEYS,
  scenarioInputDeclSchema,
  stepSchema,
  listRefSchema,
  collectRulesSchema,
  authoringControlForEachSchema,
  authoringControlRepeatSchema,
  type EffectType,
  type ScenarioInputDecl,
  type Step,
  type ListRef,
  type CollectRule,
  type AuthoringControlForEach,
  type AuthoringControlRepeat,
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
  /** 挂载在该步骤上的成功条件契约 */
  outcomes: z.array(outcomeContractSchema).optional(),
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
  disabled: z.boolean().optional(),
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

export const authoringControlIfSchema = z.strictObject({
  type: z.literal('if'),
  condition: conditionSchema,
})
export type AuthoringControlIf = z.infer<typeof authoringControlIfSchema>

export {
  listRefSchema,
  collectRulesSchema,
  authoringControlForEachSchema,
  authoringControlRepeatSchema,
  type ListRef,
  type CollectRule,
  type AuthoringControlForEach,
  type AuthoringControlRepeat,
}

export const authoringControlSchema = z.discriminatedUnion('type', [
  authoringControlIfSchema,
  authoringControlForEachSchema,
  authoringControlRepeatSchema,
])
export type AuthoringControl = z.infer<typeof authoringControlSchema>

export type AuthoringBlockNodeIf = {
  kind: 'block'
  blockId: EntityId
  name?: string
  disabled?: boolean
  control: AuthoringControlIf
  then: AuthoringNode[]
  else?: AuthoringNode[]
}

export type AuthoringBlockNodeForEach = {
  kind: 'block'
  blockId: EntityId
  name?: string
  disabled?: boolean
  control: AuthoringControlForEach
  body: AuthoringNode[]
  collect?: Array<{ from: string; fromField?: string; into: string }>
}

export type AuthoringBlockNodeRepeat = {
  kind: 'block'
  blockId: EntityId
  name?: string
  disabled?: boolean
  control: AuthoringControlRepeat
  body: AuthoringNode[]
  collect?: Array<{ from: string; fromField?: string; into: string }>
}

export type AuthoringBlockNode =
  | AuthoringBlockNodeIf
  | AuthoringBlockNodeForEach
  | AuthoringBlockNodeRepeat

export type AuthoringNode =
  | AuthoringStepNode
  | AuthoringModuleInvocation
  | AuthoringBlockNode

export const authoringBlockNodeSchema: z.ZodType<AuthoringBlockNode> = z.lazy(() =>
  z.union([
    z.strictObject({
      kind: z.literal('block'),
      blockId: entityIdSchema,
      name: z.string().trim().min(1).max(128).optional(),
      disabled: z.boolean().optional(),
      control: authoringControlIfSchema,
      then: z.array(authoringNodeSchema).min(1),
      else: z.array(authoringNodeSchema).min(1).optional(),
    }),
    z.strictObject({
      kind: z.literal('block'),
      blockId: entityIdSchema,
      name: z.string().trim().min(1).max(128).optional(),
      disabled: z.boolean().optional(),
      control: authoringControlForEachSchema,
      body: z.array(authoringNodeSchema).min(1),
      collect: collectRulesSchema.optional(),
    }),
    z.strictObject({
      kind: z.literal('block'),
      blockId: entityIdSchema,
      name: z.string().trim().min(1).max(128).optional(),
      disabled: z.boolean().optional(),
      control: authoringControlRepeatSchema,
      body: z.array(authoringNodeSchema).min(1),
      collect: collectRulesSchema.optional(),
    }),
  ]),
)

/** 编写节点联合体 */
export const authoringNodeSchema: z.ZodType<AuthoringNode> = z.lazy(() =>
  z.union([
    authoringStepNodeSchema,
    authoringModuleInvocationSchema,
    authoringBlockNodeSchema,
  ]),
)

export const MAX_AUTHORING_NODES = 64
export const MAX_BLOCK_NESTING_DEPTH = 2

// ---------------------------------------------------------------------------
// Scenario Authoring Document V2
// ---------------------------------------------------------------------------

export const scenarioAuthoringDocumentV2Schema = z
  .strictObject({
    authoringSchemaVersion: z.literal(2),
    schemaVersion: runtimeSchemaVersionSchema.default(RUNTIME_SCHEMA_VERSION),
    inputs: z.array(scenarioInputDeclSchema).max(64).default([]),
    nodes: z.array(authoringNodeSchema).min(1).max(MAX_AUTHORING_NODES),
    scenarioOutcomes: z.array(outcomeContractSchema).optional(),
    runtimeInvariants: z.array(runtimeInvariantSchema).optional(),
    outputs: scenarioOutputDeclSchema.optional(),
    resolution: resolutionPolicySchema.optional(),
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
    const blockIds = new Set<string>()
    const contractIds = new Set<string>()
    let totalNodesCount = 0

    const registerContractId = (id: string, path: Array<string | number>) => {
      if (contractIds.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: '同一场景内成功条件 id 不能重复',
        })
        return
      }
      contractIds.add(id)
    }

    function validateNodes(nodes: AuthoringNode[], basePath: Array<string | number>, depth: number) {
      if (depth > MAX_BLOCK_NESTING_DEPTH) {
        ctx.addIssue({
          code: 'custom',
          path: basePath,
          message: `流程控制块嵌套层级不能超过 ${MAX_BLOCK_NESTING_DEPTH} 层`,
        })
      }

      for (const [index, node] of nodes.entries()) {
        totalNodesCount++
        const nodePath = [...basePath, index]
        if (node.kind === 'step') {
          if (stepIds.has(node.step.id) || invocationIds.has(node.step.id) || blockIds.has(node.step.id)) {
            ctx.addIssue({
              code: 'custom',
              path: [...nodePath, 'step', 'id'],
              message: '场景内 step.id 不能重复',
            })
          }
          stepIds.add(node.step.id)
          for (const [outcomeIndex, contract] of (node.outcomes ?? []).entries()) {
            registerContractId(contract.id, [...nodePath, 'outcomes', outcomeIndex, 'id'])
          }
        } else if (node.kind === 'module') {
          if (invocationIds.has(node.invocationId) || stepIds.has(node.invocationId) || blockIds.has(node.invocationId)) {
            ctx.addIssue({
              code: 'custom',
              path: [...nodePath, 'invocationId'],
              message: '场景内 module invocationId 不能重复',
            })
          }
          invocationIds.add(node.invocationId)

          if (!node.moduleVersionId && !node.moduleDraft) {
            ctx.addIssue({
              code: 'custom',
              path: nodePath,
              message: '模块调用节点必须提供 moduleVersionId 或 moduleDraft',
            })
          }
        } else if (node.kind === 'block') {
          if (blockIds.has(node.blockId) || stepIds.has(node.blockId) || invocationIds.has(node.blockId)) {
            ctx.addIssue({
              code: 'custom',
              path: [...nodePath, 'blockId'],
              message: '场景内 block.blockId 不能重复',
            })
          }
          blockIds.add(node.blockId)

          if ('then' in node) {
            validateNodes(node.then, [...nodePath, 'then'], depth + 1)
            if (node.else) {
              validateNodes(node.else, [...nodePath, 'else'], depth + 1)
            }
          } else {
            validateNodes(node.body, [...nodePath, 'body'], depth + 1)
          }
        }
      }
    }

    validateNodes(document.nodes, ['nodes'], 0)

    if (totalNodesCount > MAX_AUTHORING_NODES) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes'],
        message: `场景内节点总数不能超过 ${MAX_AUTHORING_NODES}（当前包含 ${totalNodesCount} 个节点）`,
      })
    }

    for (const [index, contract] of (document.scenarioOutcomes ?? []).entries()) {
      registerContractId(contract.id, ['scenarioOutcomes', index, 'id'])
    }
    for (const [index, invariant] of (document.runtimeInvariants ?? []).entries()) {
      registerContractId(invariant.id, ['runtimeInvariants', index, 'id'])
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
  outputVerificationStepIds: z.array(entityIdSchema).default([]),
  frozenOutputs: z.record(z.string(), z.string()).default({}),
  outputRequired: z.array(z.string()).default([]),
  inputBindingsDigest: z.string().min(1).max(128),
})
export type ModuleManifestEntry = z.infer<typeof moduleManifestEntrySchema>

export const candidateAlternativeSchema = z.strictObject({
  implementationKey: implementationKeySchema,
  implementationDigest: z.string().min(1).max(128),
  stepIds: z.array(entityIdSchema).min(1),
  postconditionStepIds: z.array(entityIdSchema).default([]),
  outputVerificationStepIds: z.array(entityIdSchema).default([]),
  frozenOutputs: z.record(z.string(), z.string()).default({}),
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
        ...(doc.outputs ? { outputs: doc.outputs } : {}),
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

/** 统一编写节点 ID */
export function authoringNodeId(node: AuthoringNode): string {
  if (node.kind === 'step') return node.step.id
  if (node.kind === 'module') return node.invocationId
  return node.blockId
}

export type AuthoringNodeWalkItem = {
  node: AuthoringNode
  id: string
  parentId?: string
  branchKey?: 'then' | 'else' | 'body'
  depth: number
  index: number
  ancestry: Array<{ blockId: string; branchKey: 'then' | 'else' | 'body' }>
}

export type AuthoringNodeLocation = {
  parentId?: string
  branchKey?: 'then' | 'else' | 'body'
  index: number
}

/**
 * 按执行顺序深度优先先序遍历文档所有节点，给出节点、所在父节点、所在分支、层级、序号及祖先路径。
 */
export function walkAuthoringNodes(doc: ScenarioAuthoringDocumentV2): AuthoringNodeWalkItem[] {
  const result: AuthoringNodeWalkItem[] = []

  function walk(
    nodes: AuthoringNode[],
    parentId?: string,
    branchKey?: 'then' | 'else' | 'body',
    depth = 0,
    ancestry: Array<{ blockId: string; branchKey: 'then' | 'else' | 'body' }> = [],
  ) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const id = authoringNodeId(node)
      result.push({
        node,
        id,
        parentId,
        branchKey,
        depth,
        index: i,
        ancestry,
      })
      if (node.kind === 'block') {
        if ('then' in node) {
          const nextAncestryThen = [...ancestry, { blockId: id, branchKey: 'then' as const }]
          walk(node.then, id, 'then', depth + 1, nextAncestryThen)
          if (node.else) {
            const nextAncestryElse = [...ancestry, { blockId: id, branchKey: 'else' as const }]
            walk(node.else, id, 'else', depth + 1, nextAncestryElse)
          }
        } else {
          const nextAncestryBody = [...ancestry, { blockId: id, branchKey: 'body' as const }]
          walk(node.body, id, 'body', depth + 1, nextAncestryBody)
        }
      }
    }
  }

  walk(doc.nodes, undefined, undefined, 0, [])
  return result
}

/**
 * 依据节点 ID 定位其所在位置（父节点 ID、所在分支及序号）。
 */
export function locateNode(
  doc: ScenarioAuthoringDocumentV2,
  id: string,
): AuthoringNodeLocation | undefined {
  const items = walkAuthoringNodes(doc)
  const found = items.find((item) => item.id === id)
  if (!found) return undefined
  return {
    parentId: found.parentId,
    branchKey: found.branchKey,
    index: found.index,
  }
}

/**
 * 递归修改指定分支下的节点数组
 */
function modifyBranchList(
  nodes: AuthoringNode[],
  parentId: string | undefined,
  branchKey: 'then' | 'else' | 'body' | undefined,
  fn: (list: AuthoringNode[]) => AuthoringNode[],
): AuthoringNode[] {
  if (!parentId) {
    return fn(nodes)
  }
  return nodes.map((node) => {
    if (node.kind !== 'block') return node
    if (node.blockId === parentId) {
      if ('then' in node) {
        if (branchKey === 'then') {
          return { ...node, then: fn(node.then) }
        }
        if (branchKey === 'else') {
          return { ...node, else: fn(node.else ?? []) }
        }
      } else {
        if (branchKey === 'body') {
          return { ...node, body: fn(node.body) }
        }
      }
      return node
    }
    if ('then' in node) {
      const newThen = modifyBranchList(node.then, parentId, branchKey, fn)
      const newElse = node.else ? modifyBranchList(node.else, parentId, branchKey, fn) : undefined
      return {
        ...node,
        then: newThen,
        ...(newElse ? { else: newElse } : {}),
      }
    } else {
      const newBody = modifyBranchList(node.body, parentId, branchKey, fn)
      return {
        ...node,
        body: newBody,
      }
    }
  })
}

/**
 * 在指定锚点节点后插入新节点（纯函数）。若 anchorId 缺省或为 null，插入到列表开头。
 */
export function insertNodeAfter(
  doc: ScenarioAuthoringDocumentV2,
  anchorId: string | null | undefined,
  node: AuthoringNode,
): ScenarioAuthoringDocumentV2 {
  if (!anchorId) {
    return {
      ...doc,
      nodes: [node, ...doc.nodes],
    }
  }
  const loc = locateNode(doc, anchorId)
  if (!loc) {
    throw new Error(`找不到锚点节点: ${anchorId}`)
  }
  const newNodes = modifyBranchList(doc.nodes, loc.parentId, loc.branchKey, (list) => {
    const copy = [...list]
    copy.splice(loc.index + 1, 0, node)
    return copy
  })
  return {
    ...doc,
    nodes: newNodes,
  }
}

/**
 * 在指定位置插入新节点（纯函数）。
 */
export function insertNodeAt(
  doc: ScenarioAuthoringDocumentV2,
  location: AuthoringNodeLocation,
  node: AuthoringNode,
): ScenarioAuthoringDocumentV2 {
  const newNodes = modifyBranchList(doc.nodes, location.parentId, location.branchKey, (list) => {
    const copy = [...list]
    const idx = Math.max(0, Math.min(location.index, copy.length))
    copy.splice(idx, 0, node)
    return copy
  })
  return {
    ...doc,
    nodes: newNodes,
  }
}

/**
 * 删除指定 ID 的节点（纯函数）。
 */
export function removeNode(
  doc: ScenarioAuthoringDocumentV2,
  id: string,
): ScenarioAuthoringDocumentV2 {
  const loc = locateNode(doc, id)
  if (!loc) return doc
  const newNodes = modifyBranchList(doc.nodes, loc.parentId, loc.branchKey, (list) =>
    list.filter((n) => authoringNodeId(n) !== id),
  )
  return {
    ...doc,
    nodes: newNodes,
  }
}

/**
 * 替换指定 ID 的节点（纯函数）。
 */
export function replaceNode(
  doc: ScenarioAuthoringDocumentV2,
  id: string,
  node: AuthoringNode,
): ScenarioAuthoringDocumentV2 {
  const loc = locateNode(doc, id)
  if (!loc) return doc
  const newNodes = modifyBranchList(doc.nodes, loc.parentId, loc.branchKey, (list) =>
    list.map((n) => (authoringNodeId(n) === id ? node : n)),
  )
  return {
    ...doc,
    nodes: newNodes,
  }
}

/**
 * 在同一父节点内移动指定节点（纯函数）。delta < 0 向前移，delta > 0 向后移。
 */
export function moveNodeWithin(
  doc: ScenarioAuthoringDocumentV2,
  id: string,
  delta: number,
): ScenarioAuthoringDocumentV2 {
  const loc = locateNode(doc, id)
  if (!loc) return doc
  const newNodes = modifyBranchList(doc.nodes, loc.parentId, loc.branchKey, (list) => {
    const targetIndex = loc.index + delta
    if (targetIndex < 0 || targetIndex >= list.length) return list
    const copy = [...list]
    const [removed] = copy.splice(loc.index, 1)
    if (!removed) return list
    copy.splice(targetIndex, 0, removed)
    return copy
  })
  return {
    ...doc,
    nodes: newNodes,
  }
}

/**
 * 获取某节点之前、执行上可见的节点。
 * 作用域规则：互斥分支内的节点对对方完全不可见。
 */
export function nodesBefore(doc: ScenarioAuthoringDocumentV2, id: string): AuthoringNode[] {
  const items = walkAuthoringNodes(doc)
  const targetIdx = items.findIndex((item) => item.id === id)
  if (targetIdx <= 0) return []
  const targetItem = items[targetIdx]!

  const result: AuthoringNode[] = []
  for (let i = 0; i < targetIdx; i++) {
    const candidate = items[i]!
    let isMutuallyExclusive = false
    const minLen = Math.min(candidate.ancestry.length, targetItem.ancestry.length)
    for (let k = 0; k < minLen; k++) {
      const cAnc = candidate.ancestry[k]!
      const tAnc = targetItem.ancestry[k]!
      if (cAnc.blockId === tAnc.blockId && cAnc.branchKey !== tAnc.branchKey) {
        isMutuallyExclusive = true
        break
      }
    }
    if (!isMutuallyExclusive) {
      result.push(candidate.node)
    }
  }
  return result
}

/**
 * 检查某节点在其引用点 targetNodeId 处是否为条件执行（可能缺失）。
 * 满足以下任一情况为可能缺失：
 * 1. 节点自身为可选步骤（step.optional === true）
 * 2. 节点位于某个分支内，而 targetNodeId 不在该分支的作用域下
 */
export function isNodeOutputPossiblyAbsent(
  doc: ScenarioAuthoringDocumentV2,
  sourceNodeId: string,
  targetNodeId?: string,
): boolean {
  const items = walkAuthoringNodes(doc)
  const sourceItem = items.find(
    (item) =>
      item.id === sourceNodeId ||
      (item.node.kind === 'step' && item.node.step.outputKey === sourceNodeId) ||
      (item.node.kind === 'module' && Object.values(item.node.outputBindings).includes(sourceNodeId)),
  )
  if (!sourceItem) return false

  if (sourceItem.node.kind === 'step' && sourceItem.node.step.optional) {
    return true
  }

  if (sourceItem.ancestry.length === 0) {
    return false
  }

  if (!targetNodeId) {
    return true
  }

  const targetItem = items.find((item) => item.id === targetNodeId)
  if (!targetItem) {
    return true
  }

  for (let k = 0; k < sourceItem.ancestry.length; k++) {
    const sAnc = sourceItem.ancestry[k]!
    const tAnc = targetItem.ancestry[k]
    if (!tAnc || tAnc.blockId !== sAnc.blockId || tAnc.branchKey !== sAnc.branchKey) {
      return true
    }
  }
  return false
}

export type BlockEditResult =
  | { ok: true; document: ScenarioAuthoringDocumentV2 }
  | { ok: false; reason: string }

/**
 * 把同一父节点下连续的若干节点包进一个新的条件块（纯函数）。条件先置为恒真，由作者随后填写。
 * 结果必须能通过文档 Schema（含嵌套层级等约束），否则拒绝并说明原因。
 */
export function wrapNodesInIfBlock(
  doc: ScenarioAuthoringDocumentV2,
  ids: readonly string[],
  block: { blockId: string; name?: string },
): BlockEditResult {
  if (ids.length === 0) return { ok: false, reason: '请先选择要包裹的步骤' }
  const wanted = new Set(ids)
  const items = walkAuthoringNodes(doc).filter((item) => wanted.has(item.id))
  if (items.length !== wanted.size) return { ok: false, reason: '所选节点不在当前文档中' }
  const parentId = items[0]!.parentId
  const branchKey = items[0]!.branchKey
  if (items.some((item) => item.parentId !== parentId || item.branchKey !== branchKey)) {
    return { ok: false, reason: '只能包裹同一层级、同一分支里的步骤' }
  }
  const indexes = items.map((item) => item.index).sort((a, b) => a - b)
  if (indexes[indexes.length - 1]! - indexes[0]! + 1 !== indexes.length) {
    return { ok: false, reason: '只能包裹连续的步骤' }
  }
  const start = indexes[0]!
  const nodes = modifyBranchList(doc.nodes, parentId, branchKey, (list) => {
    const wrapped: AuthoringNode = {
      kind: 'block',
      blockId: block.blockId,
      ...(block.name ? { name: block.name } : {}),
      control: { type: 'if', condition: { kind: 'literal', value: true } },
      then: list.slice(start, start + indexes.length),
    }
    return [...list.slice(0, start), wrapped, ...list.slice(start + indexes.length)]
  })
  return validatedBlockEdit({ ...doc, nodes })
}

/**
 * 解除块：把块里的节点放回块原来的位置（纯函数）。条件块带「否则」分支时拒绝，
 * 以免静默丢掉那部分步骤；循环块解除后汇集结果不再产生，由编译诊断提示引用处。
 */
export function unwrapBlock(doc: ScenarioAuthoringDocumentV2, blockId: string): BlockEditResult {
  const item = walkAuthoringNodes(doc).find((entry) => entry.id === blockId)
  if (!item || item.node.kind !== 'block') return { ok: false, reason: '找不到要解除的块' }
  const block = item.node
  if ('then' in block && block.else && block.else.length > 0) {
    return { ok: false, reason: '该条件块有「否则」分支，请先删除或移出否则分支里的步骤' }
  }
  const children = 'then' in block ? block.then : block.body
  const nodes = modifyBranchList(doc.nodes, item.parentId, item.branchKey, (list) => [
    ...list.slice(0, item.index),
    ...children,
    ...list.slice(item.index + 1),
  ])
  return validatedBlockEdit({ ...doc, nodes })
}

function validatedBlockEdit(candidate: ScenarioAuthoringDocumentV2): BlockEditResult {
  const parsed = scenarioAuthoringDocumentV2Schema.safeParse(candidate)
  if (parsed.success) return { ok: true, document: parsed.data }
  return { ok: false, reason: parsed.error.issues[0]?.message ?? '修改后的文档不合法' }
}

export function authoringHasControlBlocks(doc: ScenarioAuthoringDocumentV2): boolean {
  return walkAuthoringNodes(doc).some((item) => item.node.kind === 'block')
}

export function authoringHasModuleInvocations(document: ScenarioAuthoringDocumentV2): boolean {
  return walkAuthoringNodes(document).some((item) => item.node.kind === 'module')
}

export function authoringHasOutcomes(document: ScenarioAuthoringDocumentV2): boolean {
  if ((document.scenarioOutcomes?.length ?? 0) > 0) return true
  if ((document.runtimeInvariants?.length ?? 0) > 0) return true
  return walkAuthoringNodes(document).some(
    (item) => item.node.kind === 'step' && (item.node.outcomes?.length ?? 0) > 0,
  )
}

/** V1 取 steps；V2 递归展平收集 StepNode，调用节点不计入。 */
export function authoringSteps(
  document: ScenarioAuthoringDocumentV2 | { steps: Step[] } | null | undefined,
): Step[] {
  if (!document) return []
  if (isAuthoringDocumentV2(document)) {
    return walkAuthoringNodes(document).flatMap((item) =>
      item.node.kind === 'step' ? [item.node.step] : [],
    )
  }
  return document.steps ?? []
}

