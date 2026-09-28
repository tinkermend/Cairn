import { describe, expect, it, vi } from 'vitest'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

vi.mock('@cairn/db', () => ({
  getScenario: vi.fn(),
  DomainError: class DomainError extends Error {
    constructor(public kind: string, public code: string, message: string) { super(message) }
  },
}))
vi.mock('./common.js', () => ({ requireVisibleTarget: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../scenarios/knowledge-operations.js', () => ({ composeScenarioKnowledge: vi.fn() }))

import { getScenario } from '@cairn/db'
import { composeScenarioKnowledge } from '../../scenarios/knowledge-operations.js'
import { handleComposeKnowledge } from './compose-knowledge.handler.js'

describe('compose-knowledge.handler V2 安全边界', () => {
  it('含成功条件的已保存草稿给出可行动限制说明，且不创建会丢失条件的平面提案', async () => {
    vi.mocked(getScenario).mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      draft: { revision: 4, document: {
        authoringSchemaVersion: 2, schemaVersion: 1, inputs: [],
        nodes: [{ kind: 'step', step: { id: '33333333-3333-4333-8333-333333333333',
          name: '打开页面', type: 'navigate', effectType: 'READ_ONLY', input: { url: 'https://example.com' } },
          outcomes: [{ id: '44444444-4444-4444-8444-444444444444' }] }],
      } },
    } as never)
    const getConfig = vi.fn()
    const ctx = {
      db: {} as never,
      actor: { id: 'author', displayName: 'Author', email: 'author@example.com', status: 'active', roles: [],
        permissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read', 'map:read'] },
      slots: { scenarioId: '11111111-1111-4111-8111-111111111111', draftRevision: 4 },
      question: '根据已发布做法给当前场景提建议',
      body: { question: '根据已发布做法给当前场景提建议' },
      session: null, platformConfig: { get: getConfig } as never,
      targets: {} as never, models: {} as never,
    } satisfies AssistantCapabilityHandlerContext
    const result = await handleComposeKnowledge(ctx)
    expect(result).toMatchObject({ kind: 'unsupported', reasonCode: 'AUTHORING_SCHEMA_UNSUPPORTED' })
    if (result.kind === 'unsupported') {
      expect(result.message).toContain('没有生成提案')
      expect(result.message).toContain('场景编排建议')
    }
    expect(composeScenarioKnowledge).not.toHaveBeenCalled()
    expect(getConfig).not.toHaveBeenCalled()
  })
})
