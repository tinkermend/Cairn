import { resolveOutcomeWriteback } from '@cairn/authoring'
import type { OutcomeManifest, Step, TargetDescriptor } from '@cairn/shared'

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
