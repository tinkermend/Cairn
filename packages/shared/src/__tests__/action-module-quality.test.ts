import { describe, expect, it } from 'vitest'
import {
  FACTORY_MODULE_QUALITY,
  attributeExecutionError,
  classifyModuleRunKind,
  deriveInvocationResults,
  evaluateModuleHealth,
  passRateBucket,
  resolveModulesByRules,
  runHrefForInvocation,
  type DeriveInvocationResultsInput,
  type ModuleManifestEntry,
  type ResolverCatalogModule,
} from '../index.js'

const runId = '10000000-0000-4000-8000-000000000001'
const invocationA = '20000000-0000-4000-8000-000000000001'
const invocationB = '20000000-0000-4000-8000-000000000002'
const moduleId = '30000000-0000-4000-8000-000000000001'
const versionId = '30000000-0000-4000-8000-000000000002'
const targetId = '40000000-0000-4000-8000-000000000001'
const stepAct = '50000000-0000-4000-8000-000000000001'
const stepAssert = '50000000-0000-4000-8000-000000000002'

function entry(overrides: Partial<ModuleManifestEntry> = {}): ModuleManifestEntry {
  return {
    invocationId: invocationA,
    ordinal: 0,
    name: '查询订单',
    moduleId,
    moduleKey: 'order.query',
    moduleVersionId: versionId,
    versionNo: 1,
    contentDigest: 'c',
    contractDigest: 'k',
    implementationDigest: 'i',
    implementationKey: 'default',
    executionMode: 'DETERMINISTIC',
    effectCeiling: 'READ_ONLY',
    expandedStepIds: [stepAct, stepAssert],
    internalToExpanded: { act: stepAct, assert: stepAssert },
    preconditionStepIds: [],
    postconditionStepIds: [stepAssert],
    outputRequired: ['result'],
    inputBindingsDigest: 'b',
    ...overrides,
  }
}

function derive(
  overrides: {
    status?: DeriveInvocationResultsInput['run']['status']
    context?: Record<string, unknown>
    authHint?: DeriveInvocationResultsInput['run']['authHint']
    stepRuns?: DeriveInvocationResultsInput['stepRuns']
    attempts?: DeriveInvocationResultsInput['attempts']
    evidences?: DeriveInvocationResultsInput['evidences']
    entries?: ModuleManifestEntry[]
    runKind?: DeriveInvocationResultsInput['run']['runKind']
    manualRequirementCounts?: Record<string, number>
  } = {},
) {
  return deriveInvocationResults({
    snapshot: {
      runId,
      targetId,
      steps: [],
      moduleManifest: { entries: overrides.entries ?? [entry()] },
    },
    run: {
      status: overrides.status ?? 'SUCCEEDED',
      eventSeq: 4,
      runKind: overrides.runKind ?? 'published',
      context: overrides.context ?? { result: 'ok' },
      authHint: overrides.authHint,
    },
    stepRuns: overrides.stepRuns ?? [
      { stepId: stepAct, status: 'SUCCEEDED', startedAt: '2026-09-16T00:00:00.000Z', finishedAt: '2026-09-16T00:00:01.000Z' },
      { stepId: stepAssert, status: 'SUCCEEDED', startedAt: '2026-09-16T00:00:01.000Z', finishedAt: '2026-09-16T00:00:02.000Z' },
    ],
    attempts: overrides.attempts ?? [
      { stepId: stepAct, attemptNo: 1, status: 'SUCCEEDED' },
      { stepId: stepAssert, attemptNo: 1, status: 'SUCCEEDED' },
    ],
    evidences: overrides.evidences,
    manualRequirementCounts: overrides.manualRequirementCounts,
  })
}

describe('AM-E: 调用结果派生与健康信号', () => {
  it('AME-01 七种 outcome 与四种 attribution', () => {
    expect(derive()[0]).toMatchObject({ outcome: 'VERIFIED', attribution: 'MODULE' })
    expect(derive({
      status: 'FAILED',
      stepRuns: [
        { stepId: stepAct, status: 'PENDING' },
        { stepId: stepAssert, status: 'PENDING' },
      ],
      attempts: [],
      context: {},
    })[0]).toMatchObject({ outcome: 'NOT_REACHED', attribution: 'UPSTREAM' })
    expect(derive({
      status: 'CANCELLED',
      stepRuns: [
        { stepId: stepAct, status: 'CANCELLED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'PENDING' },
      ],
    })[0]).toMatchObject({ outcome: 'CANCELLED', attribution: 'UNKNOWN' })
    expect(derive({
      status: 'NEEDS_REVIEW',
      stepRuns: [
        { stepId: stepAct, status: 'FAILED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'PENDING' },
      ],
      attempts: [{ stepId: stepAct, attemptNo: 1, status: 'FAILED', error: { code: 'SIDE_EFFECT_UNKNOWN', category: 'UNKNOWN' } }],
    })[0]).toMatchObject({ outcome: 'NEEDS_REVIEW', attribution: 'UNKNOWN' })
    expect(derive({
      status: 'FAILED',
      context: {},
      stepRuns: [
        { stepId: stepAct, status: 'SUCCEEDED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'FAILED', startedAt: '2026-09-16T00:00:01.000Z' },
      ],
      attempts: [
        { stepId: stepAct, attemptNo: 1, status: 'SUCCEEDED' },
        { stepId: stepAssert, attemptNo: 1, status: 'FAILED', error: { code: 'ASSERT_FAILED', category: 'VALIDATION' } },
      ],
    })[0]).toMatchObject({ outcome: 'FAILED_VERIFICATION', attribution: 'MODULE' })
    expect(derive({
      status: 'FAILED',
      stepRuns: [
        { stepId: stepAct, status: 'FAILED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'SKIPPED' },
      ],
      attempts: [{ stepId: stepAct, attemptNo: 1, status: 'FAILED', error: { code: 'CLICK_FAILED', category: 'EXECUTOR' } }],
    })[0]).toMatchObject({ outcome: 'FAILED_IMPLEMENTATION', attribution: 'MODULE' })
    expect(derive({
      status: 'FAILED',
      stepRuns: [
        { stepId: stepAct, status: 'FAILED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'SKIPPED' },
      ],
      attempts: [{ stepId: stepAct, attemptNo: 1, status: 'FAILED', error: { code: 'WEIRD', category: 'UNKNOWN' } }],
    })[0]).toMatchObject({ outcome: 'FAILED_IMPLEMENTATION', attribution: 'UNKNOWN' })
  })

  it('AME-02 后置失败与人工说明不作为 VERIFIED 依据', () => {
    const missingOutput = derive({
      context: {},
      stepRuns: [
        { stepId: stepAct, status: 'SUCCEEDED' },
        { stepId: stepAssert, status: 'SUCCEEDED' },
      ],
    })[0]!
    expect(missingOutput).toMatchObject({ outcome: 'FAILED_VERIFICATION', attribution: 'MODULE' })

    const manualOnly = derive({
      entries: [entry({ postconditionStepIds: [], outputRequired: [], expandedStepIds: [stepAct] })],
      stepRuns: [{ stepId: stepAct, status: 'SUCCEEDED' }],
      attempts: [{ stepId: stepAct, attemptNo: 1, status: 'SUCCEEDED' }],
      manualRequirementCounts: { [invocationA]: 2 },
    })[0]!
    expect(manualOnly).toMatchObject({
      outcome: 'VERIFIED',
      attribution: 'MODULE',
      verificationStrength: 'insufficient',
      manualRequirementsUnverified: 2,
    })
    expect(passRateBucket(manualOnly)).toBe('excluded')
    expect(evaluateModuleHealth({
      sampleCount: 0,
      verifiedRate: null,
      recentFailureStreak: 0,
      verificationInsufficient: true,
      windowDays: 7,
      configRevision: 1,
      config: FACTORY_MODULE_QUALITY,
      asOf: '2026-09-16T00:00:00.000Z',
    }).signal).toBe('unknown')
  })

  it('AME-03 外部原因与定位失败不冤枉模块', () => {
    expect(attributeExecutionError({ code: 'SESSION_AUTH_TIMEOUT', category: 'INFRASTRUCTURE' })).toBe('EXTERNAL_INFRA')
    expect(attributeExecutionError({ code: 'DEBUG_WORKER_LOST', category: 'INFRASTRUCTURE' })).toBe('EXTERNAL_INFRA')
    expect(attributeExecutionError({ code: 'TARGET_NOT_FOUND', category: 'EXECUTOR' }, {
      hadAuthWaitOrRecovery: true,
      authStateExpired: false,
    })).toBe('EXTERNAL_INFRA')
    expect(attributeExecutionError({ code: 'TARGET_NOT_FOUND', category: 'EXECUTOR' })).toBe('UNKNOWN')
    expect(attributeExecutionError({ code: 'CLICK_FAILED', category: 'EXECUTOR' })).toBeNull()

    const authLost = derive({
      status: 'FAILED',
      authHint: { hadAuthWaitOrRecovery: true, authStateExpired: true },
      stepRuns: [
        { stepId: stepAct, status: 'FAILED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'SKIPPED' },
      ],
      attempts: [{ stepId: stepAct, attemptNo: 1, status: 'FAILED', error: { code: 'TARGET_NOT_FOUND', category: 'EXECUTOR' } }],
    })[0]!
    expect(authLost).toMatchObject({ outcome: 'FAILED_IMPLEMENTATION', attribution: 'EXTERNAL_INFRA' })
    expect(passRateBucket(authLost)).toBe('excluded')

    const unknownLocate = derive({
      status: 'FAILED',
      stepRuns: [
        { stepId: stepAct, status: 'FAILED', startedAt: '2026-09-16T00:00:00.000Z' },
        { stepId: stepAssert, status: 'SKIPPED' },
      ],
      attempts: [{ stepId: stepAct, attemptNo: 1, status: 'FAILED', error: { code: 'TARGET_NOT_FOUND', category: 'EXECUTOR' } }],
    })[0]!
    expect(unknownLocate.attribution).toBe('UNKNOWN')
    expect(passRateBucket(unknownLocate)).toBe('denominator')
  })

  it('经重试成功、AI 成本、前序调用不受后续核查改写', () => {
    const retried = derive({
      attempts: [
        { stepId: stepAct, attemptNo: 1, status: 'FAILED', error: { code: 'TIMEOUT', category: 'TIMEOUT' } },
        { stepId: stepAct, attemptNo: 2, status: 'SUCCEEDED' },
        { stepId: stepAssert, attemptNo: 1, status: 'SUCCEEDED' },
      ],
      evidences: [{
        stepId: stepAct,
        payload: {
          schemaVersion: 1,
          kind: 'ai_call',
          n: 1,
          phase: 'completed',
          startedAt: '2026-09-16T00:00:00.000Z',
          cost: 1.5,
        },
      }],
    })[0]!
    expect(retried.retriedSuccess).toBe(true)
    expect(retried.aiCalls).toBe(1)
    expect(retried.aiCost).toBe(1.5)

    const prior = derive({
      status: 'NEEDS_REVIEW',
      entries: [
        entry(),
        entry({ invocationId: invocationB, ordinal: 1, expandedStepIds: [stepAct], postconditionStepIds: [], outputRequired: [] }),
      ],
      stepRuns: [
        { stepId: stepAct, status: 'SUCCEEDED' },
        { stepId: stepAssert, status: 'SUCCEEDED' },
      ],
    })
    expect(prior[0]).toMatchObject({ invocationId: invocationA, outcome: 'VERIFIED' })
    expect(prior[1]).toMatchObject({ invocationId: invocationB, outcome: 'VERIFIED' })
  })

  it('AME-09 样本不足为 unknown，达到阈值 degraded', () => {
    expect(evaluateModuleHealth({
      sampleCount: 9,
      verifiedRate: 0.5,
      recentFailureStreak: 0,
      verificationInsufficient: false,
      windowDays: 7,
      configRevision: 3,
      config: FACTORY_MODULE_QUALITY,
      asOf: '2026-09-16T00:00:00.000Z',
    })).toMatchObject({ signal: 'unknown', sampleCount: 9, configRevision: 3 })
    expect(evaluateModuleHealth({
      sampleCount: 10,
      verifiedRate: 0.79,
      recentFailureStreak: 0,
      verificationInsufficient: false,
      windowDays: 7,
      configRevision: 3,
      config: FACTORY_MODULE_QUALITY,
      asOf: '2026-09-16T00:00:00.000Z',
    }).signal).toBe('degraded')
    expect(evaluateModuleHealth({
      sampleCount: 10,
      verifiedRate: 1,
      recentFailureStreak: 3,
      verificationInsufficient: false,
      windowDays: 7,
      configRevision: 3,
      config: FACTORY_MODULE_QUALITY,
      asOf: '2026-09-16T00:00:00.000Z',
    }).signal).toBe('degraded')
    expect(evaluateModuleHealth({
      sampleCount: 10,
      verifiedRate: 0.9,
      recentFailureStreak: 0,
      verificationInsufficient: false,
      windowDays: 7,
      configRevision: 3,
      config: FACTORY_MODULE_QUALITY,
      asOf: '2026-09-16T00:00:00.000Z',
    }).signal).toBe('healthy')
  })

  it('AME-10 健康信号不改变 D 规则层排序', () => {
    const catalog: ResolverCatalogModule[] = [
      {
        moduleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        targetId,
        key: 'order.query',
        name: '查询订单',
        aliases: [],
        intentExamples: [],
        tags: [],
        versions: [{
          versionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          versionNo: 2,
          publishedAt: '2026-09-16T00:00:00.000Z',
          publicationStatus: 'published',
          executionMode: 'DETERMINISTIC',
          effectCeiling: 'READ_ONLY',
          inputs: [],
        }],
      },
      {
        moduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
        targetId,
        key: 'order.cancel',
        name: '取消订单',
        aliases: [],
        intentExamples: [],
        tags: [],
        versions: [{
          versionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
          versionNo: 1,
          publishedAt: '2026-09-16T00:00:00.000Z',
          publicationStatus: 'published',
          executionMode: 'DETERMINISTIC',
          effectCeiling: 'SIDE_EFFECT',
          inputs: [],
        }],
      },
    ]
    const before = resolveModulesByRules({
      expression: '查询订单',
      catalog,
      terms: [],
      maxCandidates: 10,
    })
    const after = resolveModulesByRules({
      expression: '查询订单',
      catalog,
      terms: [],
      maxCandidates: 10,
    })
    after.candidates[0] = { ...after.candidates[0]!, notes: ['healthDegraded'] }
    expect(before.candidates.map((item) => item.moduleVersionId)).toEqual(
      after.candidates.map((item) => item.moduleVersionId),
    )
    expect(classifyModuleRunKind({ scenarioPurpose: 'module_verification', versionKind: 'trial' })).toBe('module_verification')
    expect(classifyModuleRunKind({ scenarioPurpose: 'map_job' })).toBe('map_job')
    expect(runHrefForInvocation(runId, invocationA)).toBe(`/runs/${runId}?invocation=${invocationA}`)
  })
})
