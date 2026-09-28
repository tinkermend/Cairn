import { repairCandidateSchema, type RepairCandidate } from '@cairn/shared'

const passed = (name: string) => ({ name, status: 'passed' as const, reason: 'ok' })

/**
 * 按 shared 契约构造修复候选夹具：经 repairCandidateSchema.parse 校验，
 * 契约演进（新增必填字段、收紧 strict）时夹具会立即报错，而不是用 as any 掩盖。
 */
export function makeRepairCandidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return repairCandidateSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    candidateId: 'cand-1',
    scenarioId: '00000000-0000-4000-8000-000000000010',
    sourceAttemptId: '00000000-0000-4000-8000-000000000020',
    sourceTargetDigest: 'target-digest',
    dedupeKey: 'dedupe-1',
    lastSeenAt: '2026-09-26T00:00:00Z',
    patchTargetRef: { kind: 'scenario', stepId: 'step-1', sourceDefinitionDigest: 'def-digest' },
    patch: { kind: 'ADD_CANDIDATE', suggestedCandidate: { by: 'role', value: 'button', name: '提交' } },
    hypothesis: '选择器漂移，建议置顶语义定位',
    digestManifest: {
      sourceDefinitionDigest: 'def-digest',
      postPatchExecutionDigest: 'post-digest',
      originalContractDigest: 'contract-digest',
    },
    guardResults: {
      allowedFields: passed('allowedFields'),
      unchangedBusinessGoal: passed('unchangedBusinessGoal'),
      sideEffectSafety: passed('sideEffectSafety'),
      contextIntegrity: passed('contextIntegrity'),
      overallPassed: true,
    },
    status: 'proposed',
    validationScope: {},
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
    ...overrides,
  })
}
