import { describe, expect, it } from 'vitest'
import {
  authoringSteps,
  isAuthoringDocumentV2,
  normalizeAuthoringDocument,
  saveScenarioDraftBodySchema,
  scenarioAuthoringDocumentV2Schema,
  CANDIDATE_GROUPS_PROTOCOL,
  MODULE_MANIFEST_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
  type ScenarioDocument,
} from '../index.js'

describe('ScenarioAuthoringDocument V2', () => {
  it('声明正确的 Worker 协议常量', () => {
    expect(MODULE_MANIFEST_PROTOCOL).toBe('snapshot.moduleManifest@1')
    expect(CANDIDATE_GROUPS_PROTOCOL).toBe('snapshot.candidateGroups@1')
    expect(RUNTIME_INVARIANT_MANIFEST_PROTOCOL).toBe('snapshot.runtimeInvariantManifest@1')
  })

  it('能校验合法的 V2 编写文档（含普通步骤与动作模块调用）', () => {
    const doc = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [{ key: 'orderNo', label: '订单编号' }],
      nodes: [
        {
          kind: 'step',
          step: {
            id: '11111111-1111-4111-8111-111111111111',
            name: '打开页面',
            type: 'navigate',
            effectType: 'READ_ONLY',
            input: { url: 'https://example.com' },
          },
        },
        {
          kind: 'module',
          invocationId: '22222222-2222-4222-8222-222222222222',
          name: '查询订单',
          moduleId: '33333333-3333-4333-8333-333333333333',
          moduleVersionId: '44444444-4444-4444-8444-444444444444',
          implementationKey: 'default',
          inputBindings: {
            orderId: { kind: 'from', key: 'orderNo' },
          },
          outputBindings: {
            orderStatus: 'status',
          },
        },
      ],
    }

    const parsed = scenarioAuthoringDocumentV2Schema.parse(doc)
    expect(parsed.nodes).toHaveLength(2)
    expect(isAuthoringDocumentV2(parsed)).toBe(true)
  })

  it('模块调用节点必须提供 moduleVersionId 或 moduleDraft', () => {
    const doc = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'module',
          invocationId: '22222222-2222-4222-8222-222222222222',
          moduleId: '33333333-3333-4333-8333-333333333333',
          // 缺少 moduleVersionId 和 moduleDraft
        },
      ],
    }
    expect(() => scenarioAuthoringDocumentV2Schema.parse(doc)).toThrow(
      /必须提供 moduleVersionId 或 moduleDraft/,
    )
  })

  it('normalizeAuthoringDocument 能无损将 V1 场景转换为 V2 文档', () => {
    const v1Doc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [{ key: 'userId', label: '用户ID' }],
      steps: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: '延时等待',
          type: 'delay',
          effectType: 'READ_ONLY',
          input: { durationMs: 1000 },
        },
      ],
    }

    expect(isAuthoringDocumentV2(v1Doc)).toBe(false)
    const normalized = normalizeAuthoringDocument(v1Doc)
    expect(normalized.authoringSchemaVersion).toBe(2)
    expect(normalized.inputs).toEqual(v1Doc.inputs)
    expect(normalized.nodes).toHaveLength(1)
    expect(normalized.nodes[0]).toEqual({
      kind: 'step',
      step: v1Doc.steps[0],
    })
  })

  it('保存草稿契约同时接受 V1 与 V2', () => {
    const v1 = saveScenarioDraftBodySchema.parse({
      revision: 1,
      document: {
        schemaVersion: 1,
        inputs: [],
        steps: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: '延时等待',
            type: 'delay',
            effectType: 'READ_ONLY',
            input: { durationMs: 1000 },
          },
        ],
      },
    })
    expect('steps' in v1.document).toBe(true)

    const v2 = saveScenarioDraftBodySchema.parse({
      revision: 2,
      document: {
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'module',
            invocationId: '22222222-2222-4222-8222-222222222222',
            moduleId: '33333333-3333-4333-8333-333333333333',
            moduleVersionId: '44444444-4444-4444-8444-444444444444',
          },
        ],
      },
    })
    expect(isAuthoringDocumentV2(v2.document)).toBe(true)
    expect(authoringSteps(v1.document).map((step) => step.type)).toEqual(['delay'])
    expect(authoringSteps(v2.document)).toEqual([])
  })

  it('运行期约束与成功条件 id 不能重复', () => {
    expect(() =>
      scenarioAuthoringDocumentV2Schema.parse({
        authoringSchemaVersion: 2,
        schemaVersion: 1,
        inputs: [],
        nodes: [
          {
            kind: 'step',
            step: {
              id: '11111111-1111-4111-8111-111111111111',
              name: '打开页面',
              type: 'navigate',
              effectType: 'READ_ONLY',
              input: { url: 'https://example.com' },
            },
          },
        ],
        scenarioOutcomes: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            scope: 'scenario',
            meaning: '页面打开',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'manual',
            rule: { kind: 'deterministic', expect: { kind: 'visible' } },
          },
        ],
        runtimeInvariants: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            meaning: '不得离开允许的访问范围',
            kind: 'navigation_boundary',
            severity: 'MUST',
            onViolation: 'halt',
            evaluateAt: 'step_boundary',
          },
        ],
      }),
    ).toThrow(/成功条件 id 不能重复/)
  })
})
