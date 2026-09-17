import { describe, expect, it } from 'vitest'
import {
  aggregateRunOutcomeStatus,
  aggregateStepRunOutcomeStatus,
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
})
