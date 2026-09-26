import type {
  CandidatePlanDetail,
} from './engine-candidate-plan.js'
import type {
  JsonValue,
  RunSnapshot,
  Step,
  StepSkipReason,
} from '@cairn/shared'

export interface BranchPlanResult {
  skipStepIds: string[]
  skips?: Array<{ stepIds: string[]; reason: StepSkipReason }>
  last?: boolean
}

export function planBranchSuccess(input: {
  snapshot: RunSnapshot
  step: Step
  output: JsonValue
  detail: CandidatePlanDetail | null
}): BranchPlanResult | undefined {
  if (input.step.type !== 'decide') return undefined
  const blocks = input.snapshot.controlFlow?.blocks
  if (!blocks || blocks.length === 0) return undefined

  const blockId = (input.step.input as any)?.blockId
  if (!blockId) return undefined
  const block = blocks.find((b) => b.blockId === blockId)
  if (!block || block.kind !== 'if') return undefined

  const branch = (input.output as any)?.branch
  const skipStepIds: string[] = []

  const thenBranch = block.branches.find((b) => b.key === 'then')
  const elseBranch = block.branches.find((b) => b.key === 'else')
  const thenStepIds = thenBranch?.stepIds ?? []
  const elseStepIds = elseBranch?.stepIds ?? []

  if (branch === 'then') {
    if (elseStepIds.length > 0) {
      skipStepIds.push(...elseStepIds)
    }
  } else if (branch === 'else') {
    if (thenStepIds.length > 0) {
      skipStepIds.push(...thenStepIds)
    }
  } else {
    if (thenStepIds.length > 0) {
      skipStepIds.push(...thenStepIds)
    }
    if (elseStepIds.length > 0) {
      skipStepIds.push(...elseStepIds)
    }
  }

  if (skipStepIds.length === 0) return undefined

  const last = Boolean(
    input.detail &&
      input.detail.stepRuns.every(
        (item) =>
          item.stepId === input.step.id ||
          skipStepIds.includes(item.stepId) ||
          (item.status !== 'PENDING' && item.status !== 'RUNNING'),
      ),
  )

  return {
    skipStepIds,
    skips: [{ stepIds: skipStepIds, reason: 'condition_not_met' }],
    last,
  }
}
