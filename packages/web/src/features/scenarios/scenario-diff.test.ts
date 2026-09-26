import { describe, expect, it } from 'vitest'
import type {
  ScenarioDocument,
  ScenarioAuthoringDocumentV2,
  Step,
  ScenarioModuleInvocationNode,
} from '@cairn/shared'
import { computeScenarioDiff } from './scenario-diff'

describe('computeScenarioDiff', () => {
  const step1: Step = {
    id: '00000000-0000-4000-8000-000000000001',
    name: '打开页面',
    type: 'navigate',
    effectType: 'READ_ONLY',
    input: { url: 'https://example.com' },
  }

  const step2: Step = {
    id: '00000000-0000-4000-8000-000000000002',
    name: '输入用户名',
    type: 'fill',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'css', value: '#username' }] },
      value: 'admin',
    },
  }

  const step3: Step = {
    id: '00000000-0000-4000-8000-000000000003',
    name: '点击登录',
    type: 'click',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'css', value: '#login-btn' }] },
    },
  }

  it('初始发布（无基线）识别为 isInitialPublish 并将所有节点记为 added', () => {
    const draft: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [{ key: 'account', label: '账号' }],
      steps: [step1, step2],
    }

    const diff = computeScenarioDiff(undefined, draft)
    expect(diff.isInitialPublish).toBe(true)
    expect(diff.hasChanges).toBe(true)
    expect(diff.nodeChanges).toHaveLength(2)
    expect(diff.nodeChanges[0]?.kind).toBe('step_added')
    expect(diff.nodeChanges[1]?.kind).toBe('step_added')
    expect(diff.inputChanges).toHaveLength(1)
    expect(diff.inputChanges[0]?.kind).toBe('added')
    expect(diff.summary.addedCount).toBe(3)
  })

  it('草稿与基线完全一致时 hasChanges 为 false', () => {
    const baseline: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [step1, step2],
    }
    const draft: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [step1, step2],
    }

    const diff = computeScenarioDiff(baseline, draft)
    expect(diff.hasChanges).toBe(false)
    expect(diff.nodeChanges).toHaveLength(0)
    expect(diff.summary.addedCount).toBe(0)
    expect(diff.summary.modifiedCount).toBe(0)
    expect(diff.summary.removedCount).toBe(0)
  })

  it('能够精准识别步骤的新增、删除与属性修改', () => {
    const baseline: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [step1, step2],
    }

    const modifiedStep2: Step = {
      ...step2,
      name: '输入管理员用户名',
      disabled: true,
      input: {
        ...step2.input,
        value: 'superadmin',
      },
    }

    const draft: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [modifiedStep2, step3], // 删除了 step1，修改了 step2，新增了 step3
    }

    const diff = computeScenarioDiff(baseline, draft)
    expect(diff.hasChanges).toBe(true)
    expect(diff.summary.removedCount).toBe(1) // step1
    expect(diff.summary.modifiedCount).toBe(1) // step2
    expect(diff.summary.addedCount).toBe(1) // step3

    const removed = diff.nodeChanges.find((c) => c.kind === 'step_removed')
    expect(removed).toBeDefined()
    if (removed?.kind === 'step_removed') {
      expect(removed.step.id).toBe(step1.id)
    }

    const added = diff.nodeChanges.find((c) => c.kind === 'step_added')
    expect(added).toBeDefined()
    if (added?.kind === 'step_added') {
      expect(added.step.id).toBe(step3.id)
    }

    const modified = diff.nodeChanges.find((c) => c.kind === 'step_modified')
    expect(modified).toBeDefined()
    if (modified?.kind === 'step_modified') {
      expect(modified.stepId).toBe(step2.id)
      const fieldNames = modified.changes.map((c) => c.field)
      expect(fieldNames).toContain('name')
      expect(fieldNames).toContain('disabled')
      expect(fieldNames).toContain('input')
    }
  })

  it('支持 V2 规范中的复合动作模块节点比对', () => {
    const module1: ScenarioModuleInvocationNode = {
      kind: 'module',
      invocationId: '00000000-0000-4000-8000-000000000010',
      moduleId: '00000000-0000-4000-8000-000000000020',
      moduleVersionId: '00000000-0000-4000-8000-000000000030',
      name: '统一登录模块',
      implementationKey: 'default',
      inputBindings: {},
      outputBindings: {},
    }

    const baselineV2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1 as const,
      inputs: [],
      nodes: [
        { kind: 'step', step: step1 },
        module1,
      ],
      scenarioOutcomes: [],
      runtimeInvariants: [],
    }

    const modifiedModule1: ScenarioModuleInvocationNode = {
      ...module1,
      disabled: true,
      name: '统一登录模块（停用）',
    }

    const draftV2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1 as const,
      inputs: [],
      nodes: [
        { kind: 'step', step: step1 },
        modifiedModule1,
      ],
      scenarioOutcomes: [],
      runtimeInvariants: [],
    }

    const diff = computeScenarioDiff(baselineV2, draftV2)
    expect(diff.hasChanges).toBe(true)
    expect(diff.summary.modifiedCount).toBe(1)
    const modChange = diff.nodeChanges[0]
    expect(modChange?.kind).toBe('module_modified')
    if (modChange?.kind === 'module_modified') {
      expect(modChange.invocationId).toBe(module1.invocationId)
      expect(modChange.changes.map((c) => c.field)).toEqual(['name', 'disabled'])
    }
  })

  it('当 draftDoc 为空时返回规范的空态结果', () => {
    const diff = computeScenarioDiff(null, null)
    expect(diff.hasChanges).toBe(false)
    expect(diff.isInitialPublish).toBe(true)
    expect(diff.summary).toEqual({ addedCount: 0, modifiedCount: 0, removedCount: 0 })
    expect(diff.nodeChanges).toEqual([])
    expect(diff.inputChanges).toEqual([])
    expect(diff.outcomeChanges).toEqual([])
  })
})
