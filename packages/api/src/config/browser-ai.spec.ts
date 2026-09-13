import { describe, expect, it } from 'vitest'
import { DomainError } from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  localSecretRef,
  type PlatformConfigDocument,
} from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { assertAiExecutePermission, browserAiCapabilitiesFrom, resolveAiExecution } from './browser-ai'

const actor = (permissions: string[]): RequestAccount => ({
  id: 'acc-1',
  displayName: 'Tester',
  email: 't@example.com',
  status: 'active',
  roles: [],
  permissions,
})

const enabled: PlatformConfigDocument = {
  ...FACTORY_PLATFORM_CONFIG,
  browserAi: {
    enabled: true,
    baseUrl: 'https://model.example/v1',
    model: 'demo-model',
    modelFamily: 'openai',
    secretRef: localSecretRef('00000000-0000-4000-8000-000000000099'),
    requestTimeoutMs: 15_000,
    stepMaxCalls: 8,
    maxOutputTokens: 1_024,
  },
}

describe('browser AI 控制面', () => {
  it('默认关闭时能力查询不含 AI 类型，但带精简 defaults', () => {
    const capabilities = browserAiCapabilitiesFrom(FACTORY_PLATFORM_CONFIG, 1)
    expect(capabilities.executableStepTypes).not.toContain('ai_action')
    expect(capabilities.unavailableReasons.map((item) => item.code)).toContain('AI_DISABLED')
    expect(capabilities.defaults.browserAiEnabled).toBe(false)
    expect(capabilities.defaults.execution.defaultTimeoutMs).toBe(30_000)
    expect(JSON.stringify(capabilities)).not.toMatch(/secretRef|model.example/)
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
    expect(() => resolveAiExecution([{ type: 'ai_extract' }], FACTORY_PLATFORM_CONFIG, { revision: 1 })).toThrow(
      DomainError,
    )
    try {
      resolveAiExecution([{ type: 'ai_extract' }], FACTORY_PLATFORM_CONFIG, { revision: 1 })
    } catch (error) {
      expect(error).toMatchObject({ code: 'AI_DISABLED' })
    }
  })

  it('启用后能力查询含 AI 类型，且冻结出可解释的执行配置', () => {
    const capabilities = browserAiCapabilitiesFrom(enabled, 4)
    expect(capabilities.executableStepTypes).toEqual(
      expect.arrayContaining(['ai_action', 'ai_extract', 'ai_assert']),
    )
    expect(capabilities.unavailableReasons).toEqual([])
    expect(resolveAiExecution([{ type: 'ai_extract' }], enabled, { revision: 4 })).toMatchObject({
      modelName: 'demo-model',
      modelFamily: 'openai',
      modelBaseUrl: 'https://model.example/v1',
      secretRef: { secretId: '00000000-0000-4000-8000-000000000099' },
      configVersion: '4',
    })
  })

  it('启用但配置不全时拒绝冻结，不把半套配置写进快照', () => {
    const incomplete = {
      ...enabled,
      browserAi: { ...enabled.browserAi, model: undefined },
    }
    expect(() => resolveAiExecution([{ type: 'ai_assert' }], incomplete, { revision: 1 })).toThrow(DomainError)
    try {
      resolveAiExecution([{ type: 'ai_assert' }], incomplete, { revision: 1 })
    } catch (error) {
      expect(error).toMatchObject({ code: 'AI_CONFIG_INVALID' })
    }
  })

  it('不含 AI 步骤时不冻结 AI 配置', () => {
    expect(resolveAiExecution([{ type: 'navigate' }], enabled, { revision: 1 })).toBeUndefined()
  })
})
