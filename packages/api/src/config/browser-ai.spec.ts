import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '@cairn/db'
import type { RequestAccount } from '../common/request-account'

/**
 * AI 开关的两条分支都要能在本地和 CI 稳定跑。
 * 直接读仓库根 .env 的话，开发机把 AI 打开就会让「未启用」的用例挂掉，
 * 挂的是环境而不是实现，所以这里把进程配置替换成用例自己控制的值。
 */
const env = vi.hoisted(() => ({
  config: {
    CAIRN_BROWSER_AI_ENABLED: false,
    CAIRN_BROWSER_AI_BASE_URL: 'https://model.example/v1',
    CAIRN_BROWSER_AI_MODEL: 'demo-model',
    CAIRN_BROWSER_AI_MODEL_FAMILY: 'openai',
    CAIRN_BROWSER_AI_API_KEY_SECRET_ID: 'secret-1',
    CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS: 15_000,
    CAIRN_BROWSER_AI_HANG_WAIT_MS: 5_000,
    CAIRN_BROWSER_AI_STEP_MAX_CALLS: 8,
    CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS: 1_024,
  } as Record<string, unknown>,
}))

vi.mock('./env', () => ({ config: env.config }))

const { assertAiExecutePermission, browserAiCapabilities, resolveAiExecution } = await import('./browser-ai')

const actor = (permissions: string[]): RequestAccount => ({
  id: 'acc-1',
  displayName: 'Tester',
  email: 't@example.com',
  status: 'active',
  roles: [],
  permissions,
})

describe('browser AI 控制面', () => {
  beforeEach(() => {
    env.config.CAIRN_BROWSER_AI_ENABLED = false
  })

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

  it('启用后能力查询含 AI 类型，且冻结出可解释的执行配置', () => {
    env.config.CAIRN_BROWSER_AI_ENABLED = true
    const capabilities = browserAiCapabilities()
    expect(capabilities.executableStepTypes).toEqual(
      expect.arrayContaining(['ai_action', 'ai_extract', 'ai_assert']),
    )
    expect(capabilities.unavailableReasons).toEqual([])
    expect(resolveAiExecution([{ type: 'ai_extract' }])).toMatchObject({
      modelName: 'demo-model',
      modelFamily: 'openai',
      modelBaseUrl: 'https://model.example/v1',
      secretRef: { secretId: 'secret-1' },
    })
  })

  it('启用但配置不全时拒绝冻结，不把半套配置写进快照', () => {
    env.config.CAIRN_BROWSER_AI_ENABLED = true
    env.config.CAIRN_BROWSER_AI_MODEL = undefined
    try {
      expect(() => resolveAiExecution([{ type: 'ai_assert' }])).toThrow(DomainError)
      try {
        resolveAiExecution([{ type: 'ai_assert' }])
      } catch (error) {
        expect(error).toMatchObject({ code: 'AI_CONFIG_INVALID' })
      }
    } finally {
      env.config.CAIRN_BROWSER_AI_MODEL = 'demo-model'
    }
  })

  it('不含 AI 步骤时不冻结 AI 配置', () => {
    env.config.CAIRN_BROWSER_AI_ENABLED = true
    expect(resolveAiExecution([{ type: 'navigate' }])).toBeUndefined()
  })
})
