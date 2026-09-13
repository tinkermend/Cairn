import { describe, expect, it } from 'vitest'
import { DomainError } from '@cairn/db'
import { assertAiExecutePermission, browserAiCapabilities, resolveAiExecution } from './browser-ai'
import type { RequestAccount } from '../common/request-account'

const actor = (permissions: string[]): RequestAccount => ({
  id: 'acc-1',
  displayName: 'Tester',
  email: 't@example.com',
  status: 'active',
  roles: [],
  permissions,
})

describe('browser AI 控制面', () => {
  it('默认关闭时能力查询不含 AI 类型', () => {
    const capabilities = browserAiCapabilities()
    expect(capabilities.executableStepTypes).not.toContain('ai_action')
    expect(capabilities.unavailableReasons.map((item) => item.code)).toContain('AI_DISABLED')
  })

  it('确定性步骤不要求 ai:execute', () => {
    expect(() => assertAiExecutePermission(actor(['run:execute']), [{ type: 'navigate' }])).not.toThrow()
  })

  it('含 AI 步骤且无权限时拒绝', () => {
    expect(() => assertAiExecutePermission(actor(['run:execute']), [{ type: 'ai_action' }])).toThrow(DomainError)
    try {
      assertAiExecutePermission(actor(['run:execute']), [{ type: 'ai_action' }])
    } catch (error) {
      expect(error).toMatchObject({ code: 'AI_EXECUTE_FORBIDDEN' })
    }
  })

  it('未启用时不能冻结 AI 配置', () => {
    expect(() => resolveAiExecution([{ type: 'ai_extract' }])).toThrow(DomainError)
    try {
      resolveAiExecution([{ type: 'ai_extract' }])
    } catch (error) {
      expect(error).toMatchObject({ code: 'AI_DISABLED' })
    }
  })
})
