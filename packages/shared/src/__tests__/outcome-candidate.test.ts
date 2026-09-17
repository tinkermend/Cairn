import { describe, expect, it } from 'vitest'
import {
  classifyOutcomeText,
  joinOutcomeEvaluations,
  outcomeContractFromCandidate,
  proposeOutcomeCandidate,
  outcomeCandidateMeaning,
  scenarioAuthoringDocumentV2Schema,
} from '../index.js'

describe('OCB-03 候选稳定性', () => {
  it('订单号、UUID、纯数字 ID、时间与相对时间不能作为 text_equals', () => {
    expect(classifyOutcomeText('550e8400-e29b-41d4-a716-446655440000').stableForEquals).toBe(false)
    expect(classifyOutcomeText('20240917001').stableForEquals).toBe(false)
    expect(classifyOutcomeText('订单: AB12CD34').stableForEquals).toBe(false)
    expect(classifyOutcomeText('2026-09-17 15:04').stableForEquals).toBe(false)
    expect(classifyOutcomeText('3 分钟前').stableForEquals).toBe(false)
    expect(classifyOutcomeText('¥128.00').stableForEquals).toBe(false)
    expect(classifyOutcomeText('已提交成功……').stableForEquals).toBe(false)
    expect(classifyOutcomeText('已提交成功……').suggestedKind).toBe('text_contains')
  })

  it('截断文本降级为包含匹配', () => {
    const long = '已提交'.repeat(30)
    const classified = classifyOutcomeText(long)
    expect(classified.stableForEquals).toBe(false)
    expect(classified.suggestedKind).toBe('text_contains')
    const candidate = proposeOutcomeCandidate({
      meaning: '提交成功',
      scope: 'step',
      provenance: 'recorded',
      expect: { kind: 'text_equals', value: long },
    })
    expect(candidate.expect).toEqual({ kind: 'text_contains', value: long })
    expect(candidate.reasons.length).toBeGreaterThan(0)
  })

  it('候选含义用期望文本或对象文案，不用算子名顶替', () => {
    expect(
      outcomeCandidateMeaning({
        expect: { kind: 'text_equals', value: '提交成功' },
      }),
    ).toBe('提交成功')
    expect(
      outcomeCandidateMeaning({
        expect: { kind: 'visible' },
        target: { framePath: [], candidates: [{ by: 'text', value: '提交成功' }] },
      }),
    ).toBe('对象可见：提交成功')
    expect(
      outcomeCandidateMeaning({
        expect: { kind: 'number_compare', op: 'gte', value: 1 },
      }),
    ).toBe('数值 gte 1')
  })

  it('稳定业务文案可以相等，且不会被自动采纳进契约', () => {
    const classified = classifyOutcomeText('提交成功')
    expect(classified.stableForEquals).toBe(true)
    const candidate = proposeOutcomeCandidate({
      meaning: '提交成功',
      scope: 'scenario',
      provenance: 'manual',
      expect: { kind: 'text_equals', value: '提交成功' },
    })
    expect(candidate.expect.kind).toBe('text_equals')
    expect(outcomeContractFromCandidate(candidate, '00000000-0000-4000-8000-000000000201').id).toBe(
      '00000000-0000-4000-8000-000000000201',
    )
  })
})

describe('OCB-04 契约 id 唯一性', () => {
  it('步骤级与场景级重复 id 被拒', () => {
    const id = '00000000-0000-4000-8000-000000000301'
    const contract = {
      id,
      scope: 'step' as const,
      meaning: '可见',
      severity: 'MUST' as const,
      onViolation: 'halt' as const,
      provenance: 'manual' as const,
      rule: { kind: 'deterministic' as const, expect: { kind: 'exists' as const } },
    }
    expect(() =>
      scenarioAuthoringDocumentV2Schema.parse({
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: '00000000-0000-4000-8000-000000000302',
              name: '打开',
              type: 'navigate',
              effectType: 'SIDE_EFFECT',
              input: { url: 'https://example.com' },
            },
            outcomes: [contract],
          },
        ],
        scenarioOutcomes: [{ ...contract, scope: 'scenario' }],
      }),
    ).toThrow(/成功条件 id 不能重复/)
  })
})

describe('OCB-07 未求值条件保留', () => {
  it('manifest 左连接结果，缺行就是 NOT_EVALUATED', () => {
    const rows = joinOutcomeEvaluations(
      {
        entries: [
          {
            contractId: '00000000-0000-4000-8000-000000000401',
            scope: 'step',
            meaning: '订单存在',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            stepId: '00000000-0000-4000-8000-000000000402',
            rule: { kind: 'deterministic', expect: { kind: 'exists' } },
          },
          {
            contractId: '00000000-0000-4000-8000-000000000403',
            scope: 'step',
            meaning: '状态正常',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            stepId: '00000000-0000-4000-8000-000000000404',
            rule: { kind: 'deterministic', expect: { kind: 'visible' } },
          },
        ],
      },
      [
        {
          id: '00000000-0000-4000-8000-000000000405',
          runId: '00000000-0000-4000-8000-000000000406',
          stepRunId: '00000000-0000-4000-8000-000000000407',
          attemptId: '00000000-0000-4000-8000-000000000408',
          contractId: '00000000-0000-4000-8000-000000000401',
          scope: 'step',
          meaning: '订单存在',
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'manual',
          verdict: 'PASS',
          evaluatedAt: '2026-09-17T12:00:00.000Z',
        },
      ],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.displayVerdict).toBe('PASS')
    expect(rows[1]?.displayVerdict).toBe('NOT_EVALUATED')
  })
})
