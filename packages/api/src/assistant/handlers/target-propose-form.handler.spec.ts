import { describe, expect, it } from 'vitest'
import { handleTargetProposeForm } from './target-propose-form.handler.js'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import type { RequestAccount as Actor } from '../../common/request-account.js'

function mockContext(overrides: Partial<AssistantCapabilityHandlerContext> = {}): AssistantCapabilityHandlerContext {
  const actor: Actor = {
    id: 'user-1',
    displayName: '测试员',
    email: 'test@example.com',
    status: 'active',
    roles: [{ id: 'role-admin', key: 'admin', name: '管理员', kind: 'system' }],
    permissions: ['ai:assist', 'target:write'],
  }

  return {
    db: {} as any,
    actor,
    slots: {},
    question: '',
    body: { question: '' },
    session: null,
    platformConfig: {} as any,
    targets: {} as any,
    models: {} as any,
    ...overrides,
  }
}

describe('target.propose-form 目标配置向导与草稿生成', () => {
  it('当用户意图不完整（仅说“帮我新建一个财务系统”）时，生成带默认超时与编码的草稿，并将 entryUrl 标记为 pendingFields', async () => {
    const ctx = mockContext({
      question: '帮我新建一个财务系统',
      body: { question: '帮我新建一个财务系统' },
    })

    const result = await handleTargetProposeForm(ctx)
    expect(result.kind).toBe('target_form')
    if (result.kind !== 'target_form') return

    expect(result.mode).toBe('create')
    expect(result.changes).toEqual(
      expect.arrayContaining([
        { fieldId: 'name', value: '财务系统' },
        { fieldId: 'code', value: 'finance-system' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
      ])
    )
    expect(result.pendingFields).toEqual(['entryUrl'])
    expect(result.clarifyPrompt).toContain('入口地址')
    expect(result.summary).toContain('缺少最关键的入口地址')
  })

  it('多轮延续：上一轮未填 entryUrl，用户直接回复 URL 时增量补齐提案为完整绿灯态', async () => {
    const prevTurnProposal = {
      kind: 'target_form' as const,
      mode: 'create' as const,
      summary: '规划财务系统',
      changes: [
        { fieldId: 'name' as const, value: '财务系统' },
        { fieldId: 'code' as const, value: 'finance-system' },
        { fieldId: 'loginLeaveTimeoutSeconds' as const, value: '30' },
      ],
      pendingFields: ['entryUrl' as const],
      clarifyPrompt: '请提供系统的业务入口地址（URL）：',
    }

    const ctx = mockContext({
      question: 'https://finance.oa.corp',
      slots: {
        continuation: true,
        previousProposal: prevTurnProposal,
      },
    })

    const result = await handleTargetProposeForm(ctx)
    expect(result.kind).toBe('target_form')
    if (result.kind !== 'target_form') return

    expect(result.changes).toEqual(
      expect.arrayContaining([
        { fieldId: 'name', value: '财务系统' },
        { fieldId: 'code', value: 'finance-system' },
        { fieldId: 'loginLeaveTimeoutSeconds', value: '30' },
        { fieldId: 'entryUrl', value: 'https://finance.oa.corp' },
      ])
    )
    expect(result.pendingFields).toEqual([])
    expect(result.clarifyPrompt).toBeUndefined()
    expect(result.summary).toContain('已成功补齐入口地址')
  })

  it('确定性防幻觉：若用户或模型尝试注入 example.com 伪地址，自动清洗并降级为 pendingFields', async () => {
    const ctx = mockContext({
      question: '帮我新建一个OA系统，入口地址是 https://oa.example.com',
      body: { question: '帮我新建一个OA系统，入口地址是 https://oa.example.com' },
    })

    const result = await handleTargetProposeForm(ctx)
    expect(result.kind).toBe('target_form')
    if (result.kind !== 'target_form') return

    expect(result.changes.some((c) => c.fieldId === 'entryUrl')).toBe(false)
    expect(result.pendingFields).toContain('entryUrl')
  })

  it('两轮熔断：若用户在第二轮仍未提供 URL（如“我手头没有，先帮我建个壳子”），不再发问，直接输出草稿', async () => {
    const prevTurnProposal = {
      kind: 'target_form' as const,
      mode: 'create' as const,
      summary: '规划财务系统',
      changes: [
        { fieldId: 'name' as const, value: '财务系统' },
        { fieldId: 'code' as const, value: 'finance-system' },
        { fieldId: 'loginLeaveTimeoutSeconds' as const, value: '30' },
      ],
      pendingFields: ['entryUrl' as const],
      clarifyPrompt: '请提供系统的业务入口地址（URL）：',
    }

    const ctx = mockContext({
      question: '我手头没有，先帮我建个壳子',
      slots: {
        continuation: true,
        previousProposal: prevTurnProposal,
      },
    })

    const result = await handleTargetProposeForm(ctx)
    expect(result.kind).toBe('target_form')
    if (result.kind !== 'target_form') return

    expect(result.clarifyPrompt).toBeUndefined()
    expect(result.summary).toContain('未识别到有效入口地址')
  })

  it('最低门槛守卫：若用户提问完全无法提取系统名称，严禁输出空草稿，降级为 clarify 澄清', async () => {
    const ctx = mockContext({
      question: '帮我配一个',
      body: { question: '帮我配一个' },
    })

    const result = await handleTargetProposeForm(ctx)
    expect(result.kind).toBe('clarify')
    if (result.kind !== 'clarify') return
    expect(result.question).toContain('请提供系统名称')
  })

  it('权限拦截：无 target:write 权限的用户请求被拦截为 PERMISSION_DENIED', async () => {
    const ctx = mockContext({
      actor: {
        id: 'viewer-1',
        displayName: '查看员',
        email: null,
        status: 'active',
        roles: [{ id: 'role-viewer', key: 'viewer', name: '查看员', kind: 'system' }],
        permissions: ['ai:assist'], // lacks target:write
      },
      question: '帮我新建财务系统',
    })

    const result = await handleTargetProposeForm(ctx)
    expect(result.kind).toBe('unsupported')
    if (result.kind !== 'unsupported') return
    expect(result.reasonCode).toBe('PERMISSION_DENIED')
  })
})
