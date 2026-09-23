import {
  type DemonstrationSemanticProposal,
  type DemonstrationBusinessGroup,
  type DemonstrationSemanticSourceMapItem,
  type DemonstrationParamCandidate,
  type DemonstrationSource,
  type EffectType,
  type ScenarioInputType,
  canonicalJson,
  syncSha256,
} from '@cairn/shared'

export interface ModelGroupInput {
  groupId?: string
  title: string
  description?: string
  effectType?: EffectType
  sourceIds: string[]
}

export interface BuildDemonstrationSemanticProposalOptions {
  recordingDraftId: string
  factDigest: string
  source: DemonstrationSource
  groups: ModelGroupInput[]
  paramCandidates?: Array<{
    sourceId: string
    name: string
    type: ScenarioInputType
    sampleValue: string
  }>
}

/**
 * Builds a deterministic DemonstrationSemanticProposal and computes its modelProposalDigest.
 * Validates that all referenced sourceIds exist in the source demonstration actions,
 * ensures unmapped actions are classified as unknown/unresolved, and forbids dropping actions.
 */
export function buildDemonstrationSemanticProposal(
  options: BuildDemonstrationSemanticProposalOptions,
): DemonstrationSemanticProposal {
  const { recordingDraftId, factDigest, source, groups, paramCandidates = [] } = options

  const rawActions = source.facts ?? (source as any).actions ?? []
  const validActionIds = new Set(rawActions.map((a: { id: string }) => a.id))
  const assignedActionIds = new Set<string>()

  const businessGroups: DemonstrationBusinessGroup[] = []
  const sourceMap: DemonstrationSemanticSourceMapItem[] = []

  // Process groups
  for (const [index, grp] of groups.entries()) {
    const groupId = grp.groupId || `grp-${index + 1}`
    const verifiedSourceIds: string[] = []

    for (const sid of grp.sourceIds) {
      if (validActionIds.has(sid)) {
        verifiedSourceIds.push(sid)
        assignedActionIds.add(sid)
        sourceMap.push({
          sourceId: sid,
          groupId,
          disposition: 'accept',
        })
      }
    }

    if (verifiedSourceIds.length > 0) {
      businessGroups.push({
        groupId,
        title: grp.title.trim() || `业务分组 ${index + 1}`,
        description: grp.description?.trim(),
        effectType: grp.effectType ?? 'READ_ONLY',
        sourceIds: verifiedSourceIds,
      })
    }
  }

  // Identify unassigned / unknown actions
  const unknownActions: string[] = []
  for (const action of rawActions) {
    if (!assignedActionIds.has(action.id)) {
      unknownActions.push(action.id)
      sourceMap.push({
        sourceId: action.id,
        groupId: 'unresolved',
        disposition: 'unresolved',
        reason: '未被模型提炼分组收录的原始动作',
      })
    }
  }

  // Validate param candidates
  const validParamCandidates: DemonstrationParamCandidate[] = []
  for (const param of paramCandidates) {
    if (validActionIds.has(param.sourceId)) {
      validParamCandidates.push({
        sourceId: param.sourceId,
        name: param.name.trim(),
        type: param.type,
        sampleValue: param.sampleValue,
      })
    }
  }

  // Canonical payload for digest computation (excluding timestamp)
  const canonicalPayload = {
    recordingDraftId,
    factDigest,
    businessGroups,
    sourceMap,
    paramCandidates: validParamCandidates,
    unknownActions,
  }

  const modelProposalDigest = syncSha256(canonicalJson(canonicalPayload))

  return {
    recordingDraftId,
    factDigest,
    modelProposalDigest,
    businessGroups,
    sourceMap,
    paramCandidates: validParamCandidates,
    unknownActions,
    createdAt: new Date().toISOString(),
  }
}
