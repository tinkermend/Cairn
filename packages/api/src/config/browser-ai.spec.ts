import { describe, expect, it } from 'vitest'
import { DomainError } from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  localSecretRef,
  resolveAiExecutionFromPlatform,
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
    expect(capabilities.resolution).toMatchObject({
      ceiling: 'deterministic_only',
      default: 'prefer_deterministic',
      aiRungAvailable: false,
    })
    expect(capabilities.resolution?.waitKindsAvailable).not.toContain('semantic')
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
    // 夹具闸门与 AI 闸门相互独立：AI 开着不代表夹具步也开放。
    expect(capabilities.executableStepTypes).not.toEqual(
      expect.arrayContaining(['echo', 'delay', 'fail']),
    )
    expect(capabilities.unavailableReasons.map((item) => item.code)).toEqual([
      'FIXTURE_STEPS_DISABLED',
      'FIXTURE_STEPS_DISABLED',
      'FIXTURE_STEPS_DISABLED',
    ])
  })

  it('开放夹具后编写清单才出现 echo / delay / fail', () => {
    const withFixtures = { ...enabled, fixtureStepsEnabled: true }
    const capabilities = browserAiCapabilitiesFrom(withFixtures, 4)
    expect(capabilities.executableStepTypes).toEqual(
      expect.arrayContaining(['echo', 'delay', 'fail']),
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

  it('有效档位含 A 级时要求 ai:execute', () => {
    const step = {
      id: '00000000-0000-4000-8000-0000000000c1',
      type: 'click',
      policy: { resolution: 'prefer_deterministic' as const },
    }
    const openCeiling = {
      ...enabled,
      browserAi: {
        ...enabled.browserAi,
        resolutionCeiling: 'prefer_deterministic' as const,
        defaultResolution: 'prefer_deterministic' as const,
      },
    }
    expect(() => assertAiExecutePermission(actor(['run:execute']), [step], { document: openCeiling })).toThrow(
      DomainError,
    )
    expect(() =>
      assertAiExecutePermission(actor(['run:execute', 'ai:execute']), [step], { document: openCeiling }),
    ).not.toThrow()
    expect(() =>
      assertAiExecutePermission(actor(['run:execute']), [step], { document: FACTORY_PLATFORM_CONFIG }),
    ).not.toThrow()
  })

  it('目标优先顺序抬高时要求 ai:execute，目标上限压低时不要求', () => {
    const step = {
      id: '00000000-0000-4000-8000-0000000000c1',
      type: 'click',
      policy: {},
    }
    const platformDefaultClosed = {
      ...enabled,
      browserAi: {
        ...enabled.browserAi,
        resolutionCeiling: 'prefer_deterministic' as const,
        defaultResolution: 'deterministic_only' as const,
      },
    }
    expect(() =>
      assertAiExecutePermission(actor(['run:execute']), [step], { document: platformDefaultClosed }),
    ).not.toThrow()
    expect(() =>
      assertAiExecutePermission(actor(['run:execute']), [step], {
        document: platformDefaultClosed,
        targetPreference: 'prefer_deterministic',
      }),
    ).toThrow(DomainError)
    expect(() =>
      assertAiExecutePermission(actor(['run:execute']), [step], {
        document: {
          ...enabled,
          browserAi: {
            ...enabled.browserAi,
            resolutionCeiling: 'prefer_deterministic' as const,
            defaultResolution: 'prefer_deterministic' as const,
          },
        },
        targetCeiling: 'deterministic_only',
      }),
    ).not.toThrow()
  })

  it('v2 仅文本定位独立于视觉配置，仍要求 AI 执行权限', () => {
    const textOnly = {
      ...FACTORY_PLATFORM_CONFIG,
      browserAi: { ...FACTORY_PLATFORM_CONFIG.browserAi, enabled: false, secretRef: undefined },
      platformAi: { ...FACTORY_PLATFORM_CONFIG.platformAi, enabled: true, secretRef: localSecretRef('00000000-0000-4000-8000-000000000099') },
      locator: { defaultPlan: { v: 2 as const, order: ['text_ai' as const] }, limits: { v: 2 as const, allowed: ['rule' as const, 'text_ai' as const] } },
    }
    const step = { id: '00000000-0000-4000-8000-0000000000c1', type: 'click', policy: { locatorPlan: { v: 2 as const, order: ['text_ai' as const] } } }
    expect(() => assertAiExecutePermission(actor(['run:execute']), [step], { document: textOnly, locatorProtocol: 2 })).toThrow(DomainError)
    expect(resolveAiExecutionFromPlatform([step], textOnly, {
      revision: 3, hangWaitMs: 20_000, requiredLocatorRoutes: ['text_ai'],
    })).toMatchObject({ visionEnabled: false, modelBaseUrl: textOnly.platformAi.baseUrl, platformAi: { secretRef: textOnly.platformAi.secretRef } })
  })
})
