import { resolveOutcomeWriteback } from '@cairn/authoring'
import { walkAuthoringNodes, type OutcomeManifest, type ScenarioAuthoringDocumentV2, type Step, type TargetDescriptor } from '@cairn/shared'

export function resolveHoldingDraftStepId(
  checkpointStepId: string | undefined,
  manifest: OutcomeManifest | undefined,
  draftStepIds: Iterable<string>,
): string | undefined {
  if (!checkpointStepId) return undefined
  const ids = new Set(draftStepIds)
  if (ids.has(checkpointStepId)) return checkpointStepId
  const writeback = resolveOutcomeWriteback(manifest, checkpointStepId)
  if (writeback?.sourceStepId && ids.has(writeback.sourceStepId)) return writeback.sourceStepId
  return undefined
}

export function applyTargetToDraftStep(
  step: Step,
  target: TargetDescriptor,
): Step | undefined {
  if (!step.input || typeof step.input !== 'object' || !('target' in step.input)) return undefined
  const current = step.input.target
  return {
    ...step,
    input: {
      ...step.input,
      target: current?.semantic ? { ...target, semantic: current.semantic } : target,
    },
  } as Step
}

/** 调试重试仍使用原 Run 快照；把当前草稿中已修好的目标显式传给该 Attempt。 */
export function retryTargetForCheckpoint(input: {
  checkpointStepId?: string
  manifest?: OutcomeManifest
  document?: ScenarioAuthoringDocumentV2 | null
  selectedStep?: Step | null
}): TargetDescriptor | undefined {
  const { checkpointStepId, manifest, document, selectedStep } = input
  if (!checkpointStepId) return undefined
  const writeback = resolveOutcomeWriteback(manifest, checkpointStepId)
  if (writeback && document) {
    const contract = writeback.scope === 'scenario'
      ? document.scenarioOutcomes?.find((item) => item.id === writeback.contractId)
      : walkAuthoringNodes(document).find((item) =>
          item.node.kind === 'step' && item.node.step.id === writeback.sourceStepId,
        )?.node
    const outcome = contract && 'kind' in contract && contract.kind === 'step'
      ? contract.outcomes?.find((item) => item.id === writeback.contractId)
      : contract
    return outcome && 'rule' in outcome && outcome.rule.kind === 'deterministic'
      ? outcome.rule.target
      : undefined
  }
  if (selectedStep?.id !== checkpointStepId) return undefined
  return selectedStep.input && 'target' in selectedStep.input
    ? selectedStep.input.target
    : undefined
}
