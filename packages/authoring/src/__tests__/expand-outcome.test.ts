import { describe, expect, it } from 'vitest'
import {
  type OutcomeContract,
  type ScenarioAuthoringDocumentV2,
  type Step,
} from '@cairn/shared'
import {
  deterministicStepId,
  expandAuthoringDocument,
  type ExpansionContext,
} from '../index.js'

describe('OC-A: 编写展开与契约派生 (expand-outcome)', () => {
  const targetId = '11111111-1111-4111-8111-111111111111'

  function makeContext(): ExpansionContext {
    return {
      targetId,
      mode: 'publish',
      loadedModules: new Map(),
      compilerCtx: {
        executableTypes: [
          'navigate',
          'click',
          'fill',
          'assert',
          'ai_assert',
          'ai_action',
          'echo',
        ],
      },
    }
  }

  const navigateStep: Step = {
    id: '10000000-0000-4000-8000-000000000001',
    name: '打开页面',
    type: 'navigate',
    effectType: 'SIDE_EFFECT',
    input: { url: 'https://example.com/app' },
  }

  const clickStep: Step = {
    id: '10000000-0000-4000-8000-000000000002',
    name: '点击提交',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'css', value: '#submit' }] },
    },
  }

  it('OCA-EXP-01: 动作步上的步骤契约派生断言步骤，并记录 sourceStepId', () => {
    const outcomeContract: OutcomeContract = {
      id: '20000000-0000-4000-8000-000000000001',
      scope: 'step',
      meaning: '提交按钮应处于不可用状态',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        target: { framePath: [], candidates: [{ by: 'css', value: '#submit[disabled]' }] },
        expect: { kind: 'visible' },
      },
    }

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: navigateStep },
        { kind: 'step', step: clickStep, outcomes: [outcomeContract] },
      ],
    }

    const result = expandAuthoringDocument(doc, makeContext())
    expect(result.ok).toBe(true)
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toHaveLength(0)

    // 展开步骤应为 3 个：navigate, click, derived assert
    expect(result.definition?.steps).toHaveLength(3)
    const derivedStep = result.definition?.steps[2]!
    const expectedDerivedId = deterministicStepId(clickStep.id, outcomeContract.id)
    expect(derivedStep.id).toBe(expectedDerivedId)
    expect(derivedStep.type).toBe('assert')
    expect(derivedStep.effectType).toBe('READ_ONLY')
    expect(derivedStep.name).toBe('提交按钮应处于不可用状态')

    // OutcomeManifest 应包含该条目
    expect(result.outcomeManifest?.entries).toHaveLength(1)
    const entry = result.outcomeManifest!.entries[0]!
    expect(entry.contractId).toBe(outcomeContract.id)
    expect(entry.stepId).toBe(expectedDerivedId)
    expect(entry.sourceStepId).toBe(clickStep.id)
    expect(entry.severity).toBe('MUST')
    expect(entry.onViolation).toBe('halt')
  })

  it('OCA-EXP-02: 直接挂在 assert/ai_assert 上的契约直接绑定，不追加多余步骤', () => {
    const assertStep: Step = {
      id: '10000000-0000-4000-8000-000000000003',
      name: '检查标题',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: 'title' }] },
        expect: { kind: 'text_contains', value: '首页' },
      },
    }

    const contract: OutcomeContract = {
      id: '20000000-0000-4000-8000-000000000002',
      scope: 'step',
      meaning: '页面标题必须包含首页',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        target: { framePath: [], candidates: [{ by: 'css', value: 'title' }] },
        expect: { kind: 'text_contains', value: '首页' },
      },
    }

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: navigateStep },
        { kind: 'step', step: assertStep, outcomes: [contract] },
      ],
    }

    const result = expandAuthoringDocument(doc, makeContext())
    expect(result.ok).toBe(true)
    expect(result.definition?.steps).toHaveLength(2)
    expect(result.definition?.steps[1]!.id).toBe(assertStep.id)

    expect(result.outcomeManifest?.entries).toHaveLength(1)
    const entry = result.outcomeManifest!.entries[0]!
    expect(entry.contractId).toBe(contract.id)
    expect(entry.stepId).toBe(assertStep.id)
    expect(entry.sourceStepId).toBeUndefined()
  })

  it('OCA-EXP-03: 存量 assert/ai_assert 步骤自动收编为 legacy_assert 契约', () => {
    const assertStep: Step = {
      id: '10000000-0000-4000-8000-000000000004',
      name: '存量元素断言',
      type: 'assert',
      effectType: 'READ_ONLY',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '#greeting' }] },
        expect: { kind: 'text_contains', value: 'Welcome' },
      },
    }
    const aiAssertStep: Step = {
      id: '10000000-0000-4000-8000-000000000005',
      name: '存量 AI 视觉断言',
      type: 'ai_assert',
      effectType: 'READ_ONLY',
      input: {
        instruction: '确认页面无错误弹窗',
      },
    }

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: navigateStep },
        { kind: 'step', step: assertStep },
        { kind: 'step', step: aiAssertStep },
      ],
    }

    const result = expandAuthoringDocument(doc, makeContext())
    expect(result.ok).toBe(true)
    expect(result.definition?.steps).toHaveLength(3)

    expect(result.outcomeManifest?.entries).toHaveLength(2)
    const [e1, e2] = result.outcomeManifest!.entries
    expect(e1!.contractId).toBe(assertStep.id)
    expect(e1!.stepId).toBe(assertStep.id)
    expect(e1!.provenance).toBe('legacy_assert')
    expect(e1!.severity).toBe('MUST')
    expect(e1!.onViolation).toBe('halt')
    expect(e1!.rule.kind).toBe('deterministic')

    expect(e2!.contractId).toBe(aiAssertStep.id)
    expect(e2!.stepId).toBe(aiAssertStep.id)
    expect(e2!.provenance).toBe('legacy_assert')
    expect(e2!.severity).toBe('MUST')
    expect(e2!.onViolation).toBe('halt')
    expect(e2!.rule.kind).toBe('ai')
  })

  it('OCA-EXP-04: 场景级 scenarioOutcomes 在末尾追加派生断言步骤', () => {
    const scenarioContract: OutcomeContract = {
      id: '20000000-0000-4000-8000-000000000010',
      scope: 'scenario',
      meaning: '最终页面应显示支付成功提示',
      severity: 'MUST',
      onViolation: 'halt',
      provenance: 'manual',
      rule: {
        kind: 'deterministic',
        target: { framePath: [], candidates: [{ by: 'css', value: '.success-tip' }] },
        expect: { kind: 'visible' },
      },
    }

    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: navigateStep },
        { kind: 'step', step: clickStep },
      ],
      scenarioOutcomes: [scenarioContract],
    }

    const result = expandAuthoringDocument(doc, makeContext())
    expect(result.ok).toBe(true)
    expect(result.definition?.steps).toHaveLength(3)

    const lastStep = result.definition?.steps[2]!
    const expectedId = deterministicStepId('scenario', scenarioContract.id)
    expect(lastStep.id).toBe(expectedId)
    expect(lastStep.type).toBe('assert')
    expect(lastStep.name).toBe('最终页面应显示支付成功提示')

    expect(result.outcomeManifest?.entries).toHaveLength(1)
    const entry = result.outcomeManifest!.entries[0]!
    expect(entry.contractId).toBe(scenarioContract.id)
    expect(entry.scope).toBe('scenario')
    expect(entry.stepId).toBe(expectedId)
  })

  it('OCA-EXP-05: 纯操作场景无断言且无契约时，outcomeManifest 为 undefined', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: navigateStep },
        { kind: 'step', step: clickStep },
      ],
    }

    const result = expandAuthoringDocument(doc, makeContext())
    expect(result.ok).toBe(true)
    expect(result.outcomeManifest).toBeUndefined()
  })

  it('OCA-EXP-06: SHOULD/INFO 配置 halt 在静态校验阶段阻断', () => {
    const invalidDoc = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: clickStep,
          outcomes: [
            {
              id: '20000000-0000-4000-8000-000000000099',
              scope: 'step',
              meaning: '次要检查项',
              severity: 'SHOULD',
              onViolation: 'halt', // 非法组合
              provenance: 'manual',
              rule: {
                kind: 'deterministic',
                expect: { kind: 'visible' },
              },
            },
          ],
        },
      ],
    }

    const result = expandAuthoringDocument(invalidDoc, makeContext())
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === 'OUTCOME_CONTRACT_INVALID')).toBe(true)
  })

  it('OCA-EXP-07: 契约展开结果严格幂等且确定性一致', () => {
    const doc: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        { kind: 'step', step: navigateStep },
        {
          kind: 'step',
          step: clickStep,
          outcomes: [
            {
              id: '20000000-0000-4000-8000-000000000001',
              scope: 'step',
              meaning: '断言1',
              severity: 'MUST',
              onViolation: 'halt',
              provenance: 'manual',
              rule: { kind: 'deterministic', expect: { kind: 'visible' } },
            },
          ],
        },
      ],
      scenarioOutcomes: [
        {
          id: '20000000-0000-4000-8000-000000000002',
          scope: 'scenario',
          meaning: '场景断言2',
          severity: 'SHOULD',
          onViolation: 'continue',
          provenance: 'manual',
          rule: { kind: 'ai', instruction: '检查最终结果' },
        },
      ],
    }

    const r1 = expandAuthoringDocument(doc, makeContext())
    const r2 = expandAuthoringDocument(structuredClone(doc), makeContext())
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r1.definition?.steps).toEqual(r2.definition?.steps)
    expect(r1.outcomeManifest).toEqual(r2.outcomeManifest)
    expect(r1.sourceDigest).toBe(r2.sourceDigest)
  })
})
