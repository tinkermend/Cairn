import { describe, expect, it } from 'vitest'
import {
  createKnowledgeProposalBodySchema,
  createTerminologyBodySchema,
  knowledgeSourceRefSchema,
  terminologyListQuerySchema,
  diffKnowledgeDocuments,
} from '../business-knowledge.js'
import type { ScenarioDocument } from '../scenario.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const objectId = '44444444-4444-4444-8444-444444444444'

describe('OM-E 业务知识契约', () => {
  it('审阅差异只展示实际变更，区分新增空值并保留大范围变化', () => {
    const before: ScenarioDocument = { schemaVersion: 1, inputs: [], steps: [{ id: objectId, name: '读取', type: 'echo', effectType: 'READ_ONLY', input: { value: {} } }] }
    const after: ScenarioDocument = { ...before, steps: [{ ...before.steps[0], name: '读取订单', type: 'echo', input: { value: { status: null } } }] }
    expect(diffKnowledgeDocuments(before, after)).toEqual([
      { fieldPath: ['steps', '0', 'name'], from: '读取', to: '读取订单' },
      { fieldPath: ['steps', '0', 'input', 'value', 'status'], from: undefined, to: null },
    ])
    expect(diffKnowledgeDocuments(before, before)).toEqual([])
    const lots: ScenarioDocument = { ...after, steps: [{ ...after.steps[0], type: 'echo', input: { value: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, index])) } }] }
    expect(diffKnowledgeDocuments(before, lots)).toEqual([{ fieldPath: ['steps'], from: before.steps, to: lots.steps }])
  })
  it('术语创建拒绝秘密类来源和超长别名', () => {
    expect(knowledgeSourceRefSchema.safeParse({ kind: 'map_asset', assetRef: { targetId, objectId } }).success).toBe(
      true,
    )
    expect(
      createTerminologyBodySchema.safeParse({
        idempotencyKey: 'term-create-1',
        canonicalName: '订单',
        aliases: Array.from({ length: 17 }, (_, index) => `别名${index}`),
        meaning: '按订单号定位一笔订单',
      }).success,
    ).toBe(false)
  })

  it('建议创建必须冻结草稿修订与摘要', () => {
    expect(
      createKnowledgeProposalBodySchema.safeParse({
        idempotencyKey: 'proposal-1',
        question: '按订单号查询状态',
        expectedDraftRevision: 1,
      }).success,
    ).toBe(false)
    const parsed = createKnowledgeProposalBodySchema.parse({
      idempotencyKey: 'proposal-1',
      question: '按订单号查询状态',
      expectedDraftRevision: 2,
      documentDigest: 'a'.repeat(64),
    })
    expect(parsed.selectedTermIds).toEqual([])
  })

  it('术语列表默认 20、最大 100', () => {
    expect(terminologyListQuerySchema.parse({}).limit).toBe(20)
    expect(terminologyListQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
  })
})
