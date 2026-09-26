import {
  type AuthoringStepNode,
  type HealingPatch,
  type LocatorCandidate,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDocument,
  type Step,
  MAX_LOCATOR_CANDIDATES,
  replaceNode,
  replaceNodeWithMany,
  walkAuthoringNodes,
} from '@cairn/shared'

export class PatchApplyError extends Error {
  constructor(
    public readonly code: 'STEP_NOT_FOUND' | 'SCENARIO_DOCUMENT_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'PatchApplyError'
  }
}

function candidateEquals(a: LocatorCandidate, b: LocatorCandidate): boolean {
  if (a.by !== b.by) return false
  if (a.value !== b.value) return false
  if (a.name !== b.name) return false
  return true
}

function applyPatchToStep(step: Step, patch: HealingPatch): Step {
  const updated: Step = JSON.parse(JSON.stringify(step))
  const input = (updated.input ?? {}) as Record<string, unknown>

  if (patch.kind === 'ADD_CANDIDATE') {
    if (patch.suggestedCandidate) {
      const currentTarget = (input.target ?? { framePath: [], candidates: [] }) as Record<string, unknown>
      const existingCandidates: LocatorCandidate[] = Array.isArray(currentTarget.candidates)
        ? [...(currentTarget.candidates as LocatorCandidate[])]
        : []

      const filtered = existingCandidates.filter((c) => !candidateEquals(c, patch.suggestedCandidate!))
      const nextCandidates = [patch.suggestedCandidate, ...filtered]
      if (nextCandidates.length > MAX_LOCATOR_CANDIDATES) {
        nextCandidates.length = MAX_LOCATOR_CANDIDATES
      }

      currentTarget.candidates = nextCandidates
      currentTarget.framePath = currentTarget.framePath ?? []
      input.target = currentTarget
      updated.input = input as any
    }
  } else if (patch.kind === 'REPLACE_LOCATOR') {
    if (patch.targetDescriptor) {
      input.target = patch.targetDescriptor
      updated.input = input as any
    } else if (patch.suggestedCandidate) {
      input.target = {
        framePath: [],
        candidates: [patch.suggestedCandidate],
      }
      updated.input = input as any
    }
  } else if (patch.kind === 'UPGRADE_TO_AI_STEP') {
    ;(updated as any).type = 'ai_action'
    updated.input = {
      instruction: patch.upgradeSuggestion?.prompt ?? 'AI 辅助操作',
    } as any
  }

  return updated
}

function createWaitStep(waitMs: number): Step {
  return {
    id: `step_wait_${Math.random().toString(36).slice(2, 10)}`,
    name: '修复前置等待',
    type: 'wait',
    effectType: 'READ_ONLY',
    input: {
      kind: 'time',
      durationMs: waitMs,
    },
  } as Step
}

/**
 * 统一补丁应用纯函数：
 * 支持 ScenarioAuthoringDocumentV2 (通过 AST 遍历器与变更器) 与 ScenarioDocument (steps 列表) 双模。
 */
export function applyPatchToDocument<T extends ScenarioAuthoringDocumentV2 | ScenarioDocument | Record<string, unknown>>(
  inputDocument: T,
  stepId: string,
  patch: HealingPatch,
): T {
  const cloned = JSON.parse(JSON.stringify(inputDocument))

  // 1. ScenarioAuthoringDocumentV2 结构
  if (Array.isArray((cloned as Record<string, unknown>).nodes)) {
    const v2Document = cloned as ScenarioAuthoringDocumentV2
    const items = walkAuthoringNodes(v2Document)
    const found = items.find((item) => item.id === stepId)
    if (!found) {
      throw new PatchApplyError('STEP_NOT_FOUND', `未在场景节点树中找到待修复步骤「${stepId}」`)
    }
    if (found.node.kind !== 'step') {
      throw new PatchApplyError('STEP_NOT_FOUND', `待修复节点「${stepId}」不是可执行步骤`)
    }

    if (patch.kind === 'PREPEND_WAIT') {
      const waitStep = createWaitStep(patch.suggestedWaitMs ?? 2000)
      const waitNode: AuthoringStepNode = {
        kind: 'step',
        step: waitStep,
      }
      return replaceNodeWithMany(v2Document, stepId, [waitNode, found.node]) as T
    }

    const updatedNode: AuthoringStepNode = {
      ...found.node,
      step: applyPatchToStep(found.node.step, patch),
    }
    return replaceNode(v2Document, stepId, updatedNode) as T
  }

  // 2. ScenarioDocument 结构
  if (Array.isArray((cloned as Record<string, unknown>).steps)) {
    const steps = (cloned as Record<string, unknown>).steps as Step[]
    const stepIndex = steps.findIndex((s) => s.id === stepId)
    if (stepIndex === -1) {
      throw new PatchApplyError('STEP_NOT_FOUND', `未在场景步骤列表中找到待修复步骤「${stepId}」`)
    }
    const targetStep = steps[stepIndex]!

    if (patch.kind === 'PREPEND_WAIT') {
      const waitStep = createWaitStep(patch.suggestedWaitMs ?? 2000)
      steps.splice(stepIndex, 0, waitStep)
    } else {
      steps[stepIndex] = applyPatchToStep(targetStep, patch)
    }
    return cloned
  }

  throw new PatchApplyError('SCENARIO_DOCUMENT_INVALID', '场景文档缺少有效 nodes 或 steps 列表')
}

/**
 * 统一在 ScenarioAuthoringDocumentV2 或 ScenarioDocument 中查找指定 stepId 的步骤定义
 */
export function findStepInDocument(
  doc: ScenarioAuthoringDocumentV2 | ScenarioDocument | Record<string, unknown>,
  stepId: string,
): Step | undefined {
  if (Array.isArray((doc as Record<string, unknown>)?.nodes)) {
    const items = walkAuthoringNodes(doc as ScenarioAuthoringDocumentV2)
    const found = items.find((item) => item.id === stepId)
    return found?.node.kind === 'step' ? found.node.step : undefined
  }
  if (Array.isArray((doc as Record<string, unknown>)?.steps)) {
    const steps = (doc as Record<string, unknown>).steps as Step[]
    return steps.find((s) => s.id === stepId)
  }
  return undefined
}
