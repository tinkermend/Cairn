import { z } from 'zod'
import { locatorCandidateSchema, targetDescriptorSchema, type LocatorCandidate, type TargetDescriptor } from './target-descriptor.js'

/**
 * 自愈策略档位：
 * - off: 完全关闭自愈与诊断
 * - authoring_only: 出厂默认，仅在 Studio 调试与单步/场景试跑时激活自愈诊断与补丁建议
 * - safe_runtime: 允许在生产运行时针对无副作用/未触碰的步骤执行受控自愈 Attempt
 */
export const HEALER_POLICIES = ['off', 'authoring_only', 'safe_runtime'] as const
export type HealerPolicy = (typeof HEALER_POLICIES)[number]
export const healerPolicySchema = z.enum(HEALER_POLICIES)

/**
 * 自愈根因类型
 */
export const HEALING_ROOT_CAUSES = [
  'LOCATOR_DRIFT', // 元素仍在，但选择器属性/层级变动
  'TIMING_WAIT_INSUFFICIENT', // 元素尚未渲染完成或有动画遮罩
  'CONTENT_CHANGED', // 页面文案或结构发生根本性重构
  'CONTEXT_MISMATCH', // 页面发生了未预期的跳转或错误页
  'TARGET_ABSENT', // 业务逻辑导致该元素本就不该出现
  'ENVIRONMENT_BLOCKED', // 弹窗阻挡、验证码、登录失效等
] as const
export type HealingRootCause = (typeof HEALING_ROOT_CAUSES)[number]
export const healingRootCauseSchema = z.enum(HEALING_ROOT_CAUSES)

/**
 * 补丁类型
 */
export const HEALING_PATCH_KINDS = [
  'REPLACE_LOCATOR', // 替换当前步骤的主 TargetDescriptor
  'ADD_CANDIDATE', // 向现有的 TargetDescriptor.candidates 追加新候选项
  'PREPEND_WAIT', // 前置增加显式条件等待
  'UPGRADE_TO_AI_STEP', // 推荐升级为 Midscene ai_action
  'MANUAL_INSPECTION', // 无法自愈，需人工介入
] as const
export type HealingPatchKind = (typeof HEALING_PATCH_KINDS)[number]
export const healingPatchKindSchema = z.enum(HEALING_PATCH_KINDS)

/**
 * 自愈补丁提案
 */
export const healingPatchSchema = z.strictObject({
  kind: healingPatchKindSchema,
  targetDescriptor: targetDescriptorSchema.optional(),
  suggestedCandidate: locatorCandidateSchema.optional(),
  suggestedWaitMs: z.number().int().min(100).max(60000).optional(),
  upgradeSuggestion: z
    .strictObject({
      stepType: z.literal('ai_action'),
      prompt: z.string().trim().min(1).max(512),
    })
    .optional(),
  evidenceDiff: z
    .strictObject({
      originalFailedLocator: z.string().optional(),
      matchedElementHtml: z.string().optional(),
      matchedElementBoundingBox: z
        .strictObject({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .optional(),
    })
    .optional(),
})
export type HealingPatch = z.infer<typeof healingPatchSchema>

/**
 * 自愈诊断输出
 */
export const healingDiagnosisSchema = z.strictObject({
  cause: healingRootCauseSchema,
  confidence: z.number().min(0).max(1),
  analysisSummary: z.string().trim().min(1).max(1024),
  contextVerified: z.boolean(),
  suggestedPatch: healingPatchSchema.optional(),
})
export type HealingDiagnosis = z.infer<typeof healingDiagnosisSchema>

/**
 * Attempt 级别的自愈证据（挂载在 Attempt.evidencePayload 或 process logs 中）
 */
export const healingAttemptEvidenceSchema = z.strictObject({
  sourceAttemptId: z.string().uuid(),
  diagnosis: healingDiagnosisSchema,
  patchApplied: healingPatchSchema.optional(),
  outcome: z.enum(['HEALED_SUCCESS', 'HEAL_FAILED', 'ESCALATED', 'REJECTED_BY_GUARD']),
})
export type HealingAttemptEvidence = z.infer<typeof healingAttemptEvidenceSchema>
