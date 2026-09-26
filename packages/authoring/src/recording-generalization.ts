import {
  canonicalJson,
  normalizeAuthoringDocument,
  stepSchema,
  syncSha256,
  type AuthoringNode,
  type AuthoringStepNode,
  type DemonstrationDecision,
  type DemonstrationFact,
  type DemonstrationSource,
  type DemonstrationSuggestion,
  type GeneralizationRound,
  type OutcomeContract,
  type ScenarioAuthoringDocumentV2,
  type ScenarioInputDecl,
} from '@cairn/shared'
import { deterministicStepId } from './expand.js'
import { applyAuthoringOperations } from './authoring-operations.js'
import { suggestDemonstration } from './demonstration.js'

export type FoldRecordingGeneralizationResult =
  | {
      ok: true
      document: ScenarioAuthoringDocumentV2
      candidateDigest: string
    }
  | {
      ok: false
      invalidatedRoundId?: string
      error: { code: string; message: string; operationId?: string }
    }

/**
 * 纯函数折叠计算候选文档：
 * Blank Baseline ⊕ baseDecisions ⊕ Σ (decisionPatches + operations)
 */
export function foldRecordingGeneralization(input: {
  source: DemonstrationSource
  recordingDraftId: string
  baseDecisions: readonly DemonstrationDecision[]
  rounds: readonly GeneralizationRound[]
}): FoldRecordingGeneralizationResult {
  const { source, recordingDraftId, baseDecisions, rounds } = input
  const suggestions = suggestDemonstration(source)

  // 1. 构建生效决策映射：基础决策 + 已采纳轮次的参数补丁
  const effectiveDecisions = new Map<string, DemonstrationDecision>()
  for (const item of suggestions) {
    const base = baseDecisions.find((d) => d.id === item.id)
    if (base) {
      effectiveDecisions.set(item.id, structuredClone(base))
    } else if (item.status === 'mapped') {
      effectiveDecisions.set(item.id, { id: item.id, disposition: 'accept' })
    } else {
      effectiveDecisions.set(item.id, {
        id: item.id,
        disposition: 'discard',
        reason: '未决动作默认舍弃',
      })
    }
  }

  // 叠加已采纳轮次的 decisionPatches
  const acceptedRounds = rounds.filter((r) => r.status === 'accepted')
  for (const round of acceptedRounds) {
    for (const patch of round.decisionPatches ?? []) {
      const current = effectiveDecisions.get(patch.id)
      if (current && current.disposition === 'accept') {
        effectiveDecisions.set(patch.id, {
          ...current,
          parameter: patch.parameter,
        })
      }
    }
  }

  // 2. 将决策应用到空白文档
  const inputs: ScenarioInputDecl[] = []
  const nodes: AuthoringNode[] = []
  const bySource = new Map<string, Extract<AuthoringNode, { kind: 'step' }>>()
  const factById = new Map<string, DemonstrationFact>(source.facts.map((f) => [f.id, f]))

  for (const item of suggestions) {
    const decision = effectiveDecisions.get(item.id)
    if (!decision || decision.disposition === 'discard') continue

    // 成功条件处理
    if (decision.disposition === 'accept' && item.outcome) {
      const target = bySource.get(item.outcome.afterSourceId)
      if (target) {
        const outcomeId = deterministicStepId(recordingDraftId, item.id, 'outcome')
        const outcome: OutcomeContract = {
          id: outcomeId,
          scope: 'step',
          meaning: item.outcome.meaning,
          rule: item.outcome.rule,
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'imported',
        }
        target.outcomes = [...(target.outcomes ?? []), outcome]
      }
      continue
    }

    const rawStep = decision.disposition === 'replace' ? decision.step : item.step
    if (!rawStep) continue

    let step = stepSchema.parse(rawStep)

    // 参数化处理
    if (decision.disposition === 'accept' && decision.parameter) {
      const param = decision.parameter
      const existingParam = inputs.find((p) => p.key === param.key)
      if (!existingParam) {
        inputs.push(param)
      }
      if (step.type === 'fill') {
        const { value: _v, ...rest } = (step.input ?? {}) as Record<string, unknown>
        step = stepSchema.parse({ ...step, input: { ...rest, from: param.key } })
      } else if (
        step.type === 'ai_action' &&
        'operation' in step.input &&
        step.input.operation === 'input'
      ) {
        const { value: _v, ...rest } = (step.input ?? {}) as Record<string, unknown>
        step = stepSchema.parse({ ...step, input: { ...rest, from: param.key } })
      }
    }

    // 已脱敏值强制敏感标记
    const sourceFact = factById.get(item.id)
    if (sourceFact?.data?.value?.state === 'redacted' && step.type === 'fill') {
      const curInput = (step.input ?? {}) as Record<string, unknown>
      step = stepSchema.parse({ ...step, input: { ...curInput, sensitive: true } })
    }

    const node: AuthoringStepNode = {
      kind: 'step',
      step,
      origin: {
        kind: 'recording',
        recordingDraftId,
        sourceIds: item.sourceIds,
      },
    }
    nodes.push(node)
    bySource.set(item.id, node)
  }

  let workingDoc: ScenarioAuthoringDocumentV2 = normalizeAuthoringDocument({
    authoringSchemaVersion: 2,
    schemaVersion: 1,
    inputs,
    nodes,
    outputs: {},
  })

  // 3. 顺序折叠已采纳轮次的操作序列
  for (const round of acceptedRounds) {
    if (!round.operations || round.operations.length === 0) continue
    const res = applyAuthoringOperations(workingDoc, round.operations, {
      maxOperations: 50,
      maxInserts: 50,
      allowPolicyUpdate: true,
    })
    if (!res.ok) {
      return {
        ok: false,
        invalidatedRoundId: round.roundId,
        error: res.error,
      }
    }
    workingDoc = res.document
  }

  const candidateDigest = syncSha256(canonicalJson(workingDoc))
  return {
    ok: true,
    document: workingDoc,
    candidateDigest,
  }
}
