import { describe, expect, it } from 'vitest'
import {
  aggregateRunOutcomeStatus,
  aggregateStepRunOutcomeStatus,
  effectiveOutcomeEvaluations,
  joinOutcomeEvaluations,
  loopBodyHeadersOf,
  outcomeContractSchema,
  outcomeManifestSchema,
  outcomeRuleSchema,
  outcomeStatusSchema,
  type OutcomeContract,
  type OutcomeManifest,
} from '../outcome.js'
import { runSnapshotSchema } from '../run.js'
import { snapshotDigestPayload } from '../digest-payload.js'
import { syncSha256 } from '../sha256-sync.js'
import { canonicalJson } from '../canonical.js'

const validContractId = '00000000-0000-4000-8000-000000000101'
const validStepId = '00000000-0000-4000-8000-000000000102'

describe('OCA-01 契约 Schema', () => {
  it('正确解析合法的确定性与 AI 契约正例', () => {
    const deterministicContract = {
      id: validContractId,
      scope: 'step',
      meaning: '订单编号必须可见',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        target: {
          candidates: [{ by: 'css', value: '#order-id' }],
        },
        expect: {
          kind: 'visible',
        },
      },
    }
    expect(outcomeContractSchema.parse(deterministicContract)).toMatchObject({
      severity: 'MUST',
      onViolation: 'halt',
    })

    const aiContract = {
      id: validContractId,
      scope: 'scenario',
      meaning: '检查页面无明显错误告警',
      severity: 'SHOULD',
      onViolation: 'continue',
      provenance: 'ai_compiled',
      rule: {
        kind: 'ai',
        instruction: '检查页面顶部是否有红色报错通知',
      },
    }
    expect(outcomeContractSchema.parse(aiContract)).toMatchObject({
      severity: 'SHOULD',
      onViolation: 'continue',
    })
  })

  it('SHOULD / INFO 配 halt 被严格拒绝', () => {
    expect(() =>
      outcomeContractSchema.parse({
        id: validContractId,
        scope: 'step',
        meaning: '可选的提示信息',
        severity: 'SHOULD',
        onViolation: 'halt',
        provenance: 'manual',
        rule: {
          kind: 'deterministic',
          expect: { kind: 'visible' },
        },
      }),
    ).toThrow(/SHOULD 条件不允许配置 halt/)

    expect(() =>
      outcomeContractSchema.parse({
        id: validContractId,
        scope: 'step',
        meaning: '仅做记录的描述',
        severity: 'INFO',
        onViolation: 'halt',
        provenance: 'manual',
        rule: {
          kind: 'deterministic',
          expect: { kind: 'visible' },
        },
      }),
    ).toThrow(/INFO 条件不允许配置 halt/)
  })

  it('meaning 缺失或为空字符串被拒', () => {
    expect(() =>
      outcomeContractSchema.parse({
        id: validContractId,
        scope: 'step',
        meaning: '   ',
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'manual',
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      }),
    ).toThrow()
  })

  it('未知 provenance 或未知 rule 被拒', () => {
    expect(() =>
      outcomeContractSchema.parse({
        id: validContractId,
        scope: 'step',
        meaning: '测试非法 provenance',
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'magical_guess',
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      }),
    ).toThrow()

    expect(() =>
      outcomeRuleSchema.parse({
        kind: 'unsupported_operator',
      }),
    ).toThrow()
  })
})

describe('OCA-02 聚合规则纯函数', () => {
  const contractMust1 = '00000000-0000-4000-8000-000000000201'
  const contractMust2 = '00000000-0000-4000-8000-000000000202'
  const contractShould = '00000000-0000-4000-8000-000000000203'
  const contractInfo = '00000000-0000-4000-8000-000000000204'

  const sampleManifest: OutcomeManifest = {
    entries: [
      {
        contractId: contractMust1,
        scope: 'step',
        meaning: '主操作成功',
        severity: 'MUST',
        onViolation: 'continue',
        provenance: 'manual',
        stepId: validStepId,
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
      {
        contractId: contractMust2,
        scope: 'scenario',
        meaning: '最终状态一致',
        severity: 'MUST',
        onViolation: 'continue',
        provenance: 'manual',
        stepId: validStepId,
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
      {
        contractId: contractShould,
        scope: 'step',
        meaning: '无次要告警',
        severity: 'SHOULD',
        onViolation: 'continue',
        provenance: 'manual',
        stepId: validStepId,
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
      {
        contractId: contractInfo,
        scope: 'step',
        meaning: '纯审计信息',
        severity: 'INFO',
        onViolation: 'continue',
        provenance: 'manual',
        stepId: validStepId,
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
    ],
  }

  it('快照内没有任何 OutcomeContract 时为 NOT_EVALUATED', () => {
    expect(aggregateRunOutcomeStatus(null, [])).toBe('NOT_EVALUATED')
    expect(aggregateRunOutcomeStatus({ entries: [] }, [])).toBe('NOT_EVALUATED')
    expect(aggregateRunOutcomeStatus({ entries: [sampleManifest.entries[3]!] }, [])).toBe(
      'NOT_EVALUATED',
    ) // 只有 INFO
  })

  it('五种状态判定顺序正确：含未求值 MUST 时优先判 UNKNOWN 而非 FAIL', () => {
    // contractMust1 求值为 FAIL，但 contractMust2 尚未求值（例如 Run 提前终止）
    const partialResults = [
      { contractId: contractMust1, verdict: 'FAIL' as const },
    ]
    // 按照"先判未知再判结论"与 OCA-02 明确要求：存在未求值的 MUST 时判 UNKNOWN
    expect(aggregateRunOutcomeStatus(sampleManifest, partialResults)).toBe('UNKNOWN')

    // 两个 MUST 都未求值时判 UNKNOWN
    expect(aggregateRunOutcomeStatus(sampleManifest, [])).toBe('UNKNOWN')
  })

  it('全部 MUST 均求值且任一 MUST 为 FAIL 时判 FAIL', () => {
    const fullResults = [
      { contractId: contractMust1, verdict: 'FAIL' as const },
      { contractId: contractMust2, verdict: 'PASS' as const },
      { contractId: contractShould, verdict: 'PASS' as const },
    ]
    expect(aggregateRunOutcomeStatus(sampleManifest, fullResults)).toBe('FAIL')
  })

  it('全部 MUST 为 PASS 且任一 SHOULD 为 FAIL 时判 WARN', () => {
    const warnResults = [
      { contractId: contractMust1, verdict: 'PASS' as const },
      { contractId: contractMust2, verdict: 'PASS' as const },
      { contractId: contractShould, verdict: 'FAIL' as const },
    ]
    expect(aggregateRunOutcomeStatus(sampleManifest, warnResults)).toBe('WARN')
  })

  it('全部 MUST 与 SHOULD 均通过时判 PASS，INFO 不影响聚合', () => {
    const passResults = [
      { contractId: contractMust1, verdict: 'PASS' as const },
      { contractId: contractMust2, verdict: 'PASS' as const },
      { contractId: contractShould, verdict: 'PASS' as const },
      { contractId: contractInfo, verdict: 'FAIL' as const }, // INFO 失败不影响
    ]
    expect(aggregateRunOutcomeStatus(sampleManifest, passResults)).toBe('PASS')
  })

  it('StepRun 级聚合纯函数仅考虑当前步的契约', () => {
    const stepContracts = [
      { id: contractMust1, severity: 'MUST' as const },
      { id: contractShould, severity: 'SHOULD' as const },
    ]
    expect(aggregateStepRunOutcomeStatus([], [])).toBe('NOT_EVALUATED')
    expect(aggregateStepRunOutcomeStatus(stepContracts, [])).toBe('UNKNOWN')
    expect(
      aggregateStepRunOutcomeStatus(stepContracts, [
        { contractId: contractMust1, verdict: 'FAIL' },
        { contractId: contractShould, verdict: 'PASS' },
      ]),
    ).toBe('FAIL')
    expect(
      aggregateStepRunOutcomeStatus(stepContracts, [
        { contractId: contractMust1, verdict: 'PASS' },
        { contractId: contractShould, verdict: 'FAIL' },
      ]),
    ).toBe('WARN')
    expect(
      aggregateStepRunOutcomeStatus(stepContracts, [
        { contractId: contractMust1, verdict: 'PASS' },
        { contractId: contractShould, verdict: 'PASS' },
      ]),
    ).toBe('PASS')
  })
})

describe('OCA-13 digest 不漂移反向验收', () => {
  const baseHistoricalSnapshot = {
    schemaVersion: 1,
    runId: '00000000-0000-4000-8000-000000000001',
    targetId: '00000000-0000-4000-8000-000000000002',
    scenarioId: '00000000-0000-4000-8000-000000000003',
    scenarioVersionId: '00000000-0000-4000-8000-000000000004',
    steps: [
      {
        id: '00000000-0000-4000-8000-000000000005',
        name: '测试步',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { value: 1 },
      },
    ],
    input: {},
    createdAt: '2026-09-17T00:00:00.000Z',
  }

  it('存量历史快照重算 digest，新字段缺省时不出现在 payload 且 digest 严格不变', () => {
    const parsed = runSnapshotSchema.parse(baseHistoricalSnapshot)
    // 确保 parsed 身上没有 outcomeManifest 默认值
    expect(parsed.outcomeManifest).toBeUndefined()

    const payload = snapshotDigestPayload(parsed)
    // 确保白名单中不含有 outcomeManifest 键
    expect('outcomeManifest' in payload).toBe(false)

    // 计算基准 hash
    const digest1 = syncSha256(canonicalJson(payload))

    // 重新计算并断言绝对一致
    const digest2 = syncSha256(canonicalJson(snapshotDigestPayload(parsed)))
    expect(digest1).toBe(digest2)
  })

  it('带有 outcomeManifest 的新快照会参与 digest 且产生新摘要', () => {
    const parsedOld = runSnapshotSchema.parse(baseHistoricalSnapshot)
    const oldDigest = syncSha256(canonicalJson(snapshotDigestPayload(parsedOld)))

    const newSnapshot = {
      ...baseHistoricalSnapshot,
      outcomeManifest: {
        entries: [
          {
            contractId: validContractId,
            scope: 'scenario' as const,
            meaning: '必须成功',
            severity: 'MUST' as const,
            onViolation: 'halt' as const,
            provenance: 'manual' as const,
            stepId: '00000000-0000-4000-8000-000000000005',
            rule: { kind: 'deterministic' as const, expect: { kind: 'visible' as const } },
          },
        ],
      },
    }
    const parsedNew = runSnapshotSchema.parse(newSnapshot)
    expect(parsedNew.outcomeManifest).toBeDefined()

    const newPayload = snapshotDigestPayload(parsedNew)
    expect('outcomeManifest' in newPayload).toBe(true)

    const newDigest = syncSha256(canonicalJson(newPayload))
    expect(newDigest).not.toBe(oldDigest)
  })

  it('runtimeInvariantManifest 缺省不进 digest，写入后摘要变化', () => {
    const parsedOld = runSnapshotSchema.parse(baseHistoricalSnapshot)
    expect(parsedOld.runtimeInvariantManifest).toBeUndefined()
    expect('runtimeInvariantManifest' in snapshotDigestPayload(parsedOld)).toBe(false)
    const oldDigest = syncSha256(canonicalJson(snapshotDigestPayload(parsedOld)))
    const parsedNew = runSnapshotSchema.parse({
      ...baseHistoricalSnapshot,
      runtimeInvariantManifest: {
        entries: [
          {
            id: validContractId,
            meaning: '不得离开允许的访问范围',
            kind: 'navigation_boundary',
            severity: 'MUST',
            onViolation: 'halt',
            evaluateAt: 'step_boundary',
          },
        ],
      },
    })
    expect('runtimeInvariantManifest' in snapshotDigestPayload(parsedNew)).toBe(true)
    expect(syncSha256(canonicalJson(snapshotDigestPayload(parsedNew)))).not.toBe(oldDigest)
  })
})

describe('CF-A 成功条件多次求值与候选回退语义 (R1–R5)', () => {
  const stepA = '00000000-0000-4000-8000-000000000801'
  const stepB = '00000000-0000-4000-8000-000000000802'
  const contractA = '00000000-0000-4000-8000-000000000901'
  const contractB = '00000000-0000-4000-8000-000000000902'

  const manifest: OutcomeManifest = {
    entries: [
      {
        contractId: contractA,
        scope: 'step',
        meaning: '步骤 A 成功条件',
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'manual',
        stepId: stepA,
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
      {
        contractId: contractB,
        scope: 'step',
        meaning: '步骤 B 成功条件',
        severity: 'MUST',
        onViolation: 'halt',
        provenance: 'manual',
        stepId: stepB,
        rule: { kind: 'deterministic', expect: { kind: 'visible' } },
      },
    ],
  }

  it('CFA-07 / R1 重试覆盖：同一 StepRun 检查步骤超时后重试通过，以最后一次尝试为准', () => {
    const stepRunId = '00000000-0000-4000-8000-000000000701'
    const stepContracts = [{ id: contractA, severity: 'MUST' as const }]

    const results = [
      {
        contractId: contractA,
        stepRunId,
        attemptId: 'att-1',
        verdict: 'UNKNOWN' as const,
        evaluatedAt: '2026-09-24T10:00:00.000Z',
      },
      {
        contractId: contractA,
        stepRunId,
        attemptId: 'att-2',
        verdict: 'PASS' as const,
        evaluatedAt: '2026-09-24T10:00:05.000Z',
      },
    ]

    // StepRun 级聚合：最后一次通过，StepRun 整体即为 PASS
    expect(aggregateStepRunOutcomeStatus(stepContracts, results)).toBe('PASS')

    // Run 级聚合（单步场景）
    const singleStepManifest: OutcomeManifest = {
      entries: [manifest.entries[0]!],
    }
    const stepRuns = [{ id: stepRunId, stepId: stepA, status: 'SUCCEEDED' as const }]
    expect(aggregateRunOutcomeStatus(singleStepManifest, results, null, stepRuns)).toBe('PASS')

    // joinOutcomeEvaluations 返回正确求值次数与结论
    const joined = joinOutcomeEvaluations(singleStepManifest, results, stepRuns)
    expect(joined[0]?.displayVerdict).toBe('PASS')
    expect(joined[0]?.evaluationCount).toBe(2)
    expect(joined[0]?.applicable).toBe(true)
  })

  it('R2 多实例折叠：同一条件落在多个 StepRun 时，各步先取 R1，再按 FAIL > UNKNOWN 折叠', () => {
    const sr1 = '00000000-0000-4000-8000-000000000711'
    const sr2 = '00000000-0000-4000-8000-000000000712'

    // sr1 第一次 FAIL，重试 PASS -> sr1 结论 PASS
    // sr2 第一次 FAIL -> sr2 结论 FAIL
    // 整体折叠 PASS 与 FAIL -> 必须全过，整体为 FAIL
    const resultsPartialFail = [
      { contractId: contractA, stepRunId: sr1, verdict: 'FAIL' as const, evaluatedAt: '2026-09-24T10:00:00.000Z' },
      { contractId: contractA, stepRunId: sr1, verdict: 'PASS' as const, evaluatedAt: '2026-09-24T10:00:05.000Z' },
      { contractId: contractA, stepRunId: sr2, verdict: 'FAIL' as const, evaluatedAt: '2026-09-24T10:00:10.000Z' },
    ]

    const singleStepManifest: OutcomeManifest = { entries: [manifest.entries[0]!] }
    const stepRuns = [
      { id: sr1, stepId: stepA, status: 'SUCCEEDED' as const },
      { id: sr2, stepId: stepA, status: 'FAILED' as const },
    ]

    expect(aggregateRunOutcomeStatus(singleStepManifest, resultsPartialFail, null, stepRuns)).toBe('FAIL')

    // 若 sr2 重试后也 PASS，则整体折叠为 PASS
    const resultsAllPass = [
      ...resultsPartialFail,
      { contractId: contractA, stepRunId: sr2, verdict: 'PASS' as const, evaluatedAt: '2026-09-24T10:00:15.000Z' },
    ]
    expect(aggregateRunOutcomeStatus(singleStepManifest, resultsAllPass, null, stepRuns)).toBe('PASS')
  })

  it('CFA-09 / R3 约束不覆盖：运行期约束在第一次尝试时违反，重试成功仍记 FAIL', () => {
    const invId = '00000000-0000-4000-8000-000000000999'
    const invariantManifest = {
      entries: [{ id: invId, severity: 'MUST' as const, meaning: '页面不得报错' }],
    }

    const results = [
      {
        contractId: invId,
        provenance: 'runtime_invariant' as const,
        verdict: 'FAIL' as const,
        evaluatedAt: '2026-09-24T10:00:00.000Z',
      },
      {
        contractId: invId,
        provenance: 'runtime_invariant' as const,
        verdict: 'PASS' as const,
        evaluatedAt: '2026-09-24T10:00:05.000Z',
      },
    ]

    expect(aggregateRunOutcomeStatus(null, results, invariantManifest)).toBe('FAIL')
  })

  it('R4 不适用与全不适用边界：跳过步骤的条件展示为 NOT_APPLICABLE 且不参与聚合，全不适用收尾为 NOT_EVALUATED', () => {
    // 步骤 A 被作者停用，步骤 B 成功且通过
    const stepRuns = [
      { id: 'sr-a', stepId: stepA, status: 'SKIPPED' as const, skipReason: 'disabled' as const },
      { id: 'sr-b', stepId: stepB, status: 'SUCCEEDED' as const },
    ]
    const results = [
      { contractId: contractB, stepRunId: 'sr-b', verdict: 'PASS' as const },
    ]

    // 步骤 A 的条件不适用，Run 级结果按步骤 B 计为 PASS
    expect(aggregateRunOutcomeStatus(manifest, results, null, stepRuns)).toBe('PASS')

    const joined = joinOutcomeEvaluations(manifest, results, stepRuns)
    expect(joined[0]?.displayVerdict).toBe('NOT_APPLICABLE')
    expect(joined[0]?.applicable).toBe(false)
    expect(joined[0]?.notApplicableReason).toBe('disabled')
    expect(joined[1]?.displayVerdict).toBe('PASS')

    // 全不适用边界：若全部条件绑定的步骤都因不适用原因跳过，结果为 NOT_EVALUATED
    const allDisabledStepRuns = [
      { id: 'sr-a', stepId: stepA, status: 'SKIPPED' as const, skipReason: 'disabled' as const },
      { id: 'sr-b', stepId: stepB, status: 'SKIPPED' as const, skipReason: 'disabled' as const },
    ]
    expect(aggregateRunOutcomeStatus(manifest, [], null, allDisabledStepRuns)).toBe('NOT_EVALUATED')

    // run_halted 边界：因前序失败而跳过（run_halted），MUST 条件仍算作适用且未完成 -> UNKNOWN
    const haltedStepRuns = [
      { id: 'sr-a', stepId: stepA, status: 'FAILED' as const },
      { id: 'sr-b', stepId: stepB, status: 'SKIPPED' as const, skipReason: 'run_halted' as const },
    ]
    expect(aggregateRunOutcomeStatus(manifest, [], null, haltedStepRuns)).toBe('UNKNOWN')
  })

  it('CFA-08 / R5 候选回退：A 失败切 B，B 成功，A 上的条件判定为不适用，Run 结果按 B 计', () => {
    const candidateGroups = [
      {
        groupId: '00000000-0000-4000-8000-000000000601',
        invocationId: '00000000-0000-4000-8000-000000000602',
        alternatives: [
          {
            implementationKey: 'alt-a',
            implementationDigest: 'sha-a',
            stepIds: [stepA],
            postconditionStepIds: [],
            outputVerificationStepIds: [],
            frozenOutputs: {},
            outputStaging: {},
          },
          {
            implementationKey: 'alt-b',
            implementationDigest: 'sha-b',
            stepIds: [stepB],
            postconditionStepIds: [],
            outputVerificationStepIds: [],
            frozenOutputs: {},
            outputStaging: {},
          },
        ],
      },
    ]

    // 备选 A 执行失败，已产生 FAIL 结果；备选 B 执行成功，产生 PASS 结果
    const stepRuns = [
      { id: 'sr-a', stepId: stepA, status: 'FAILED' as const },
      { id: 'sr-b', stepId: stepB, status: 'SUCCEEDED' as const },
    ]
    const results = [
      {
        contractId: contractA,
        stepRunId: 'sr-a',
        verdict: 'FAIL' as const,
        evaluatedAt: '2026-09-24T10:00:00.000Z',
      },
      {
        contractId: contractB,
        stepRunId: 'sr-b',
        verdict: 'PASS' as const,
        evaluatedAt: '2026-09-24T10:00:05.000Z',
      },
    ]

    // R5：最终选中的是备选 B，备选 A 上的 FAIL 结果不影响整次运行，聚合为 PASS
    expect(aggregateRunOutcomeStatus(manifest, results, null, stepRuns, candidateGroups)).toBe('PASS')

    const joined = joinOutcomeEvaluations(manifest, results, stepRuns, candidateGroups)
    expect(joined[0]?.displayVerdict).toBe('NOT_APPLICABLE')
    expect(joined[0]?.applicable).toBe(false)
    expect(joined[0]?.notApplicableReason).toBe('fallback_abandoned')
    expect(joined[1]?.displayVerdict).toBe('PASS')
    expect(joined[1]?.applicable).toBe(true)
  })
})


describe('循环中的成功条件口径（复查修复）', () => {
  const bodyStepId = '00000000-0000-4000-8000-0000000000b1'
  const headerStepId = '00000000-0000-4000-8000-0000000000a1'
  const manifest = {
    entries: [
      {
        contractId: '00000000-0000-4000-8000-0000000000c1',
        scope: 'step' as const,
        meaning: '循环体断言',
        severity: 'MUST' as const,
        onViolation: 'halt' as const,
        provenance: 'legacy_assert' as const,
        stepId: bodyStepId,
        rule: { kind: 'ai' as const, instruction: '检查' },
      },
    ],
  }
  const loopHeaders = loopBodyHeadersOf({ blocks: [{ kind: 'for_each', headerStepId, bodyStepIds: [bodyStepId] }] })
  const pass = (stepRunId: string) => ({
    contractId: manifest.entries[0]!.contractId,
    stepRunId,
    verdict: 'PASS' as const,
    evaluatedAt: '2026-09-25T00:00:00.000Z',
  })

  it('集合为空、循环头成功：循环体里的条件不适用，不判 UNKNOWN', () => {
    const stepRuns = [{ id: 'h', stepId: headerStepId, status: 'SUCCEEDED' as const }]
    expect(aggregateRunOutcomeStatus(manifest, [], null, stepRuns, [], loopHeaders)).toBe('NOT_EVALUATED')
    const [row] = joinOutcomeEvaluations(manifest, [], stepRuns, [], loopHeaders)
    expect(row?.displayVerdict).toBe('NOT_APPLICABLE')
  })

  it('循环没跑到（循环头未成功）：条件仍为未知', () => {
    const stepRuns = [{ id: 'h', stepId: headerStepId, status: 'SKIPPED' as const, skipReason: 'run_halted' as const }]
    expect(aggregateRunOutcomeStatus(manifest, [], null, stepRuns, [], loopHeaders)).toBe('UNKNOWN')
  })

  it('第 1 项通过、其余项因中止没跑：判为 UNKNOWN 而不是 PASS', () => {
    const stepRuns = [
      { id: 'r1', stepId: bodyStepId, status: 'SUCCEEDED' as const },
      { id: 'r2', stepId: bodyStepId, status: 'SKIPPED' as const, skipReason: 'run_halted' as const },
    ]
    expect(aggregateRunOutcomeStatus(manifest, [pass('r1')], null, stepRuns, [], loopHeaders)).toBe('UNKNOWN')
  })

  it('部分项因条件不满足跳过、其余项通过：判为 PASS', () => {
    const stepRuns = [
      { id: 'r1', stepId: bodyStepId, status: 'SUCCEEDED' as const },
      { id: 'r2', stepId: bodyStepId, status: 'SKIPPED' as const, skipReason: 'condition_not_met' as const },
    ]
    expect(aggregateRunOutcomeStatus(manifest, [pass('r1')], null, stepRuns, [], loopHeaders)).toBe('PASS')
  })
})
