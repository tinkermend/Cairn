import { describe, expect, it, vi } from 'vitest'
import {
  type RunObservation,
  type ScenarioDocument,
  type HealingPatch,
  type Step,
  FACTORY_PLATFORM_CONFIG,
} from '@cairn/shared'
import {
  assembleDiagnoseContext,
  assembleRunCompareContext,
} from '../assistant/context-assembler'
import { RepairService } from './repair.service'

describe('AI-02 B1: 诊断聚焦点与运行对比可比性', () => {
  const mockDb = {} as any

  it('assembleDiagnoseContext 针对 wait 聚焦点生成调度与租约事实', async () => {
    const mockObservation: RunObservation = {
      run: {
        id: '11111111-1111-4111-8111-111111111111',
        scenarioId: '22222222-2222-4222-8222-222222222222',
        scenarioVersionId: '33333333-3333-4333-8333-333333333333',
        targetId: '44444444-4444-4444-8444-444444444444',
        targetAccountId: '55555555-5555-4555-8555-555555555555',
        status: 'WAITING_FOR_AUTH',
        evidenceStatus: 'COMPLETE',
        placement: {
          state: 'QUEUED',
          sessionStatus: 'WAITING_LEASE',
        },
        stepRuns: [],
        snapshot: {
          steps: [],
        },
      } as any,
      evidence: { items: [] },
      eventSeq: 1,
    }

    const dbModule = await import('@cairn/db')
    const spy = vi.spyOn(dbModule, 'loadRunObservation').mockResolvedValue(mockObservation as any)

    try {
      const { pack } = await assembleDiagnoseContext(mockDb, '11111111-1111-4111-8111-111111111111', { focus: 'wait' })
      expect(pack.focus).toBe('wait')
      const waitFact = pack.facts.find((f) => f.id === 'focus_wait')
      expect(waitFact).toBeDefined()
      expect(waitFact?.text).toContain('等待聚焦')
      expect(waitFact?.text).toContain('排查调度队列或双租约等待')
    } finally {
      spy.mockRestore()
    }
  })

  it('assembleDiagnoseContext 针对 duration 聚焦点生成耗时事实', async () => {
    const mockObservation: RunObservation = {
      run: {
        id: '11111111-1111-4111-8111-111111111112',
        scenarioId: '22222222-2222-4222-8222-222222222222',
        scenarioVersionId: '33333333-3333-4333-8333-333333333333',
        targetId: '44444444-4444-4444-8444-444444444444',
        targetAccountId: '55555555-5555-4555-8555-555555555555',
        status: 'SUCCEEDED',
        evidenceStatus: 'COMPLETE',
        startedAt: '2026-09-23T01:00:00.000Z',
        finishedAt: '2026-09-23T01:00:05.500Z',
        placement: { state: 'FINISHED' },
        stepRuns: [],
        snapshot: { steps: [] },
      } as any,
      evidence: { items: [] },
      eventSeq: 1,
    }

    const dbModule = await import('@cairn/db')
    const spy = vi.spyOn(dbModule, 'loadRunObservation').mockResolvedValue(mockObservation as any)

    try {
      const { pack } = await assembleDiagnoseContext(mockDb, '11111111-1111-4111-8111-111111111112', { focus: 'duration' })
      expect(pack.focus).toBe('duration')
      const durFact = pack.facts.find((f) => f.id === 'focus_duration')
      expect(durFact).toBeDefined()
      expect(durFact?.text).toContain('5500 毫秒')
    } finally {
      spy.mockRestore()
    }
  })

  it('assembleDiagnoseContext 针对 evidence_missing 产生结构化 missingReasons', async () => {
    const mockObservation: RunObservation = {
      run: {
        id: '11111111-1111-4111-8111-111111111113',
        scenarioId: '22222222-2222-4222-8222-222222222222',
        scenarioVersionId: '33333333-3333-4333-8333-333333333333',
        targetId: '44444444-4444-4444-8444-444444444444',
        targetAccountId: '55555555-5555-4555-8555-555555555555',
        status: 'FAILED',
        evidenceStatus: 'INCOMPLETE',
        placement: { state: 'FINISHED' },
        stepRuns: [],
        snapshot: { steps: [] },
      } as any,
      evidence: { items: [] },
      eventSeq: 1,
    }

    const dbModule = await import('@cairn/db')
    const spy = vi.spyOn(dbModule, 'loadRunObservation').mockResolvedValue(mockObservation as any)

    try {
      const { pack } = await assembleDiagnoseContext(mockDb, '11111111-1111-4111-8111-111111111113', { focus: 'evidence_missing' })
      expect(pack.focus).toBe('evidence_missing')
      expect(pack.missingReasons?.some((r) => r.reason === 'incomplete')).toBe(true)
      const evFact = pack.facts.find((f) => f.id === 'focus_evidence')
      expect(evFact?.text).toContain('补证不得等同于盲目重跑')
    } finally {
      spy.mockRestore()
    }
  })

  it('assembleRunCompareContext 可比性检测：跨场景对比标为不可比并输出警告', async () => {
    const baseRun: RunObservation = {
      run: {
        id: '11111111-1111-4111-8111-111111111114',
        scenarioId: '22222222-2222-4222-8222-222222222222',
        scenarioVersionId: '33333333-3333-4333-8333-333333333333',
        targetId: '44444444-4444-4444-8444-444444444444',
        targetAccountId: '55555555-5555-4555-8555-555555555555',
        status: 'SUCCEEDED',
        stepRuns: [],
      } as any,
      evidence: { items: [] },
      eventSeq: 1,
    }
    const targetRun: RunObservation = {
      run: {
        id: '11111111-1111-4111-8111-111111111115',
        scenarioId: '66666666-6666-4666-8666-666666666666', // Different scenario!
        scenarioVersionId: '77777777-7777-4777-8777-777777777777',
        targetId: '44444444-4444-4444-8444-444444444444',
        targetAccountId: '55555555-5555-4555-8555-555555555555',
        status: 'FAILED',
        stepRuns: [],
      } as any,
      evidence: { items: [] },
      eventSeq: 1,
    }

    const dbModule = await import('@cairn/db')
    const spy = vi.spyOn(dbModule, 'loadRunObservation').mockImplementation(async (_db, id) => {
      return id === '11111111-1111-4111-8111-111111111114' ? baseRun : targetRun
    })

    try {
      const { pack } = await assembleRunCompareContext(
        mockDb,
        '11111111-1111-4111-8111-111111111114',
        '11111111-1111-4111-8111-111111111115',
      )
      expect(pack.comparability?.comparable).toBe(false)
      expect(pack.comparability?.incomparableFactors.some((f) => f.includes('SCENARIO_MISMATCH'))).toBe(true)
      expect(pack.facts.some((f) => f.id === 'comparability-warning')).toBe(true)
      expect(pack.missingInformation).toBeDefined()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('AI-02 B4: 受控修复候选全生命周期闭环', () => {
  it('RepairService.createCandidate 阻止破坏断言的伪修复并标记为 blocked', async () => {
    const mockRun = {
      id: '11111111-1111-4111-8111-111111111116',
      scenarioId: '22222222-2222-4222-8222-222222222222',
      scenarioVersionId: '33333333-3333-4333-8333-333333333333',
      targetId: '44444444-4444-4444-8444-444444444444',
      stepRuns: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          stepId: 'step-assert-1',
          name: '断言结果',
          attempts: [
            {
              id: '99999999-9999-4999-8999-999999999999',
              status: 'FAILED',
              error: { code: 'ASSERT_FAILED', message: '结果不匹配' },
            },
          ],
        },
      ],
      snapshot: {
        steps: [
          {
            id: 'step-assert-1',
            name: '断言结果',
            type: 'assert',
            input: {
              must: [{ path: ['code'], op: 'eq', value: 200 }],
            },
          },
        ],
      },
    }

    const dbModule = await import('@cairn/db')
    const loadSpy = vi.spyOn(dbModule, 'loadRunDetail').mockResolvedValue(mockRun as any)
    const createSpy = vi.spyOn(dbModule, 'createRepairCandidate').mockImplementation(async (_db, input) => {
      return {
        id: 'rep-cand-1',
        candidateId: input.candidateId,
        runId: input.runId,
        sourceAttemptId: input.sourceAttemptId,
        patchTargetRef: input.patchTargetRef,
        patch: input.patch,
        hypothesis: input.hypothesis,
        digestManifest: input.digestManifest,
        guardResults: input.guardResults,
        status: input.status,
        validationScope: {
          locatorValid: false,
          stepPassed: false,
          outcomePassed: false,
          crossSampleStable: false,
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any
    })

    try {
      const service = new RepairService({} as any)

      // Replace assert step with UPGRADE_TO_AI_STEP -> guardrail unchangedBusinessGoal rejects!
      const created = await service.createCandidate('11111111-1111-4111-8111-111111111116', {
        stepId: 'step-assert-1',
        sourceAttemptId: '99999999-9999-4999-8999-999999999999',
        hypothesis: '将断言替换为 AI 动作',
        patch: {
          kind: 'UPGRADE_TO_AI_STEP',
          upgradeSuggestion: { prompt: '忽略错误并继续' },
        },
      })

      // The guardrails must catch that an assert step was downgraded!
      expect(created.guardResults.unchangedBusinessGoal.status).toBe('rejected')
      expect(created.guardResults.overallPassed).toBe(false)
      expect(created.status).toBe('blocked')
    } finally {
      loadSpy.mockRestore()
      createSpy.mockRestore()
    }
  })

  it('RepairService.adoptCandidate 拒绝未通过安全护栏的候选', async () => {
    const dbModule = await import('@cairn/db')
    const getSpy = vi.spyOn(dbModule, 'getRepairCandidate').mockResolvedValue({
      id: 'rep-blocked-1',
      status: 'blocked',
      guardResults: {
        allowedFields: { name: 'allowedFields', status: 'rejected', reason: '修改了受保护字段' },
        unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'passed', reason: '' },
        sideEffectSafety: { name: 'sideEffectSafety', status: 'passed', reason: '' },
        contextIntegrity: { name: 'contextIntegrity', status: 'passed', reason: '' },
        overallPassed: false, // Guardrail failed!
      },
      validationScope: { locatorValid: false, stepPassed: false, outcomePassed: false, crossSampleStable: false },
    } as any)

    try {
      const service = new RepairService({} as any)
      await expect(
        service.adoptCandidate('rep-blocked-1', { expectedRevision: 2 }, 'user-1'),
      ).rejects.toThrow('该候选未通过安全护栏校验')
    } finally {
      getSpy.mockRestore()
    }
  })

  it('RepairService.listCandidatesByScenario 委托 db.listRepairCandidatesByScenario 查询场景候选', async () => {
    const dbModule = await import('@cairn/db')
    const listSpy = vi.spyOn(dbModule, 'listRepairCandidatesByScenario').mockResolvedValue([
      {
        id: 'rep-cand-1',
        candidateId: 'rep_001',
        scenarioId: 'scen-1',
        status: 'proposed',
      } as any,
    ])

    try {
      const service = new RepairService({} as any)
      const res = await service.listCandidatesByScenario('scen-1', 'proposed')
      expect(listSpy).toHaveBeenCalledWith(expect.anything(), 'scen-1', 'proposed')
      expect(res).toHaveLength(1)
      expect(res[0]?.id).toBe('rep-cand-1')
    } finally {
      listSpy.mockRestore()
    }
  })

  it('RepairService.rejectCandidate 传递 actor 与驳回原因', async () => {
    const dbModule = await import('@cairn/db')
    const rejectSpy = vi.spyOn(dbModule, 'rejectRepairCandidate').mockResolvedValue({
      id: 'rep-cand-1',
      status: 'rejected',
      rejection: {
        rejectedAt: '2026-09-26T00:00:00.000Z',
        rejectedBy: 'user-42',
        reason: '不符合前端定位规范',
      },
    } as any)

    try {
      const service = new RepairService({} as any)
      const res = await service.rejectCandidate('rep-cand-1', { reason: '不符合前端定位规范' }, 'user-42')
      expect(rejectSpy).toHaveBeenCalledWith(expect.anything(), 'rep-cand-1', 'user-42', '不符合前端定位规范')
      expect(res.status).toBe('rejected')
      expect(res.rejection?.reason).toBe('不符合前端定位规范')
    } finally {
      rejectSpy.mockRestore()
    }
  })

  it('RepairService.reopenCandidate 重新打开已驳回的候选', async () => {
    const dbModule = await import('@cairn/db')
    const reopenSpy = vi.spyOn(dbModule, 'reopenRepairCandidate').mockResolvedValue({
      id: 'rep-cand-1',
      status: 'proposed',
      reopenHistory: [
        {
          reopenedAt: '2026-09-26T01:00:00.000Z',
          reopenedBy: 'user-42',
        },
      ],
    } as any)

    try {
      const service = new RepairService({} as any)
      const res = await service.reopenCandidate('rep-cand-1', 'user-42')
      expect(reopenSpy).toHaveBeenCalledWith(expect.anything(), 'rep-cand-1', 'user-42')
      expect(res.status).toBe('proposed')
      expect(res.reopenHistory).toHaveLength(1)
    } finally {
      reopenSpy.mockRestore()
    }
  })

  it('RepairService.validateCandidate 发起真实验证试跑并返回 candidate 与 runId', async () => {
    const dbModule = await import('@cairn/db')
    const validateSpy = vi.spyOn(dbModule, 'validateRepairCandidate').mockResolvedValue({
      candidate: {
        id: 'rep-cand-1',
        status: 'validating',
        validationRefs: {
          validationRunId: 'run-val-123',
        },
      } as any,
      runId: 'run-val-123',
    })

    try {
      const service = new RepairService({} as any, {
        ensure: vi.fn().mockResolvedValue({ document: FACTORY_PLATFORM_CONFIG }),
      } as any)
      const res = await service.validateCandidate(
        'rep-cand-1',
        {},
        { id: 'user-42' } as any,
      )
      expect(validateSpy).toHaveBeenCalledWith(
        expect.anything(),
        'rep-cand-1',
        expect.objectContaining({
          actor: { id: 'user-42' },
        }),
      )
      expect(res.runId).toBe('run-val-123')
      expect(res.candidate.status).toBe('validating')
    } finally {
      validateSpy.mockRestore()
    }
  })
})
