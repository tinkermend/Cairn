import { describe, expect, it } from 'vitest'
import { resolveStepPolicy } from '../policy.js'
import {
  FACTORY_PLATFORM_CONFIG,
  assertAiRequestTimeoutFitsSteps,
  idempotentRequestMatches,
  platformConfigDiff,
  platformConfigDocumentSchema,
  modelServiceOrigin,
  overridesCompatible,
  resolvePlatformEvidencePolicy,
  resolvePlatformExecutionPolicy,
} from '../platform-config.js'

const enabledAi = platformConfigDocumentSchema.parse({
  ...FACTORY_PLATFORM_CONFIG,
  browserAi: {
    enabled: true,
    baseUrl: 'https://model.example/v1',
    model: 'demo-model',
    modelFamily: 'openai',
    secretRef: { provider: 'local', secretId: '00000000-0000-4000-8000-000000000099' },
    requestTimeoutMs: 15_000,
    stepMaxCalls: 20,
    maxOutputTokens: 2048,
  },
})

describe('平台配置契约', () => {
  it('出厂值可通过 Schema', () => {
    expect(platformConfigDocumentSchema.parse(FACTORY_PLATFORM_CONFIG)).toEqual(
      FACTORY_PLATFORM_CONFIG,
    )
  })

  it('旧修订没有 sessionScheduling 时补出厂亲和与排队期限', () => {
    const { sessionScheduling: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.sessionScheduling).toEqual(FACTORY_PLATFORM_CONFIG.sessionScheduling)
    expect('sessionScheduling' in legacy).toBe(false)
  })

  it('旧修订没有 sessionAuth 时补出厂核验与登录预算', () => {
    const { sessionAuth: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.sessionAuth).toEqual(FACTORY_PLATFORM_CONFIG.sessionAuth)
    expect('sessionAuth' in legacy).toBe(false)
  })

  it('旧修订没有 sessionRetention 时补出厂保留配额与后台间隔', () => {
    const { sessionRetention: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.sessionRetention).toEqual(FACTORY_PLATFORM_CONFIG.sessionRetention)
    expect(parsed.sessionRetention.maxRetainSeconds).toBe(28_800)
    expect(parsed.sessionRetention.reservedFreeSlotsPerWorker).toBe(1)
    expect('sessionRetention' in legacy).toBe(false)
  })

  it('旧修订没有 runAuthRecovery 时补出厂每 Run 恢复次数', () => {
    const { runAuthRecovery: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.runAuthRecovery).toEqual(FACTORY_PLATFORM_CONFIG.runAuthRecovery)
    expect(parsed.runAuthRecovery.maxAutoRecoveriesPerRun).toBe(1)
    expect(parsed.runAuthRecovery.maxManualRecoveriesPerRun).toBe(1)
    expect('runAuthRecovery' in legacy).toBe(false)
  })

  it('旧修订没有 moduleResolver 时补出厂候选上限与保留期', () => {
    const { moduleResolver: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.moduleResolver).toEqual(FACTORY_PLATFORM_CONFIG.moduleResolver)
    expect(parsed.moduleResolver.maxCandidates).toBe(10)
    expect('moduleResolver' in legacy).toBe(false)
  })

  it('旧修订没有 moduleQuality 时补出厂窗口与退化阈值', () => {
    const { moduleQuality: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.moduleQuality).toEqual(FACTORY_PLATFORM_CONFIG.moduleQuality)
    expect(parsed.moduleQuality.windowDays).toBe(7)
    expect(parsed.moduleQuality.minSamples).toBe(10)
    expect('moduleQuality' in legacy).toBe(false)
  })

  it('旧修订没有 moduleFallback 时补出厂关闭', () => {
    const { moduleFallback: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.moduleFallback).toEqual({ enabled: false })
    expect('moduleFallback' in legacy).toBe(false)
  })

  it('旧修订没有 platformAi 时按关闭补齐，不改写调用方对象', () => {
    const { platformAi: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.platformAi.enabled).toBe(false)
    expect(parsed.platformAi.routeId).toBe('platform-default')
    expect('platformAi' in legacy).toBe(false)
  })

  it('启用 AI 时拒绝 URL 内嵌凭据', () => {
    expect(() =>
      platformConfigDocumentSchema.parse({
        ...enabledAi,
        browserAi: { ...enabledAi.browserAi, baseUrl: 'https://user:pass@model.example/v1' },
      }),
    ).toThrow()
  })

  it('AI 请求超时必须小于默认步骤超时', () => {
    expect(() =>
      platformConfigDocumentSchema.parse({
        ...enabledAi,
        browserAi: { ...enabledAi.browserAi, requestTimeoutMs: 30_000 },
      }),
    ).toThrow()
  })

  it('off/false/0 是有效覆盖，不会丢回默认', () => {
    const evidence = resolvePlatformEvidencePolicy(
      { screenshot: 'off', trace: 'off' },
      FACTORY_PLATFORM_CONFIG.evidence,
    )
    expect(evidence.screenshot).toBe('off')
    expect(evidence.trace).toBe('off')
    expect(
      resolvePlatformExecutionPolicy(
        { timeoutMs: 1, retryLimit: 0 },
        FACTORY_PLATFORM_CONFIG.execution,
      ),
    ).toEqual({
      timeoutMs: 1,
      retryLimit: 0,
    })
  })

  it('AI Action 强制 retryLimit=0', () => {
    expect(
      resolveStepPolicy({ timeoutMs: 8_000, retryLimit: 3 }, undefined, 'ai_action').retryLimit,
    ).toBe(0)
    expect(
      resolveStepPolicy({ timeoutMs: 8_000, retryLimit: 3 }, { retryLimit: 5 }, 'ai_action')
        .retryLimit,
    ).toBe(0)
    expect(
      resolveStepPolicy({ timeoutMs: 8_000, retryLimit: 3 }, undefined, 'click').retryLimit,
    ).toBe(3)
  })

  it('AI 请求超时按解析后的步骤超时校验', () => {
    expect(() =>
      assertAiRequestTimeoutFitsSteps(
        [{ type: 'ai_extract', policy: { timeoutMs: 10_000 } }],
        { timeoutMs: 30_000, retryLimit: 0 },
        12_000,
      ),
    ).toThrow(/10000/)
    expect(() =>
      assertAiRequestTimeoutFitsSteps(
        [{ type: 'ai_extract' }],
        { timeoutMs: 20_000, retryLimit: 0 },
        15_000,
      ),
    ).not.toThrow()
  })

  it('幂等兼容旧 resolved 摘要，改默认不误冲突', () => {
    const raw = 'raw-digest'
    const legacy = 'legacy-digest'
    expect(
      idempotentRequestMatches({
        existingDigest: raw,
        rawDigest: raw,
        legacyDigest: legacy,
      }),
    ).toBe(true)
    expect(
      idempotentRequestMatches({
        existingDigest: legacy,
        rawDigest: raw,
        legacyDigest: legacy,
        snapshotSession: {
          reuse: 'NEW_PAGE',
          idleTtlSeconds: 600,
          maxLifetimeSeconds: 14_400,
          leaseTtlSeconds: 30,
          authWaitSeconds: 300,
        },
        snapshotEvidence: { screenshot: 'on_failure', trace: 'off' },
      }),
    ).toBe(true)
    expect(
      idempotentRequestMatches({
        existingDigest: 'other',
        rawDigest: raw,
        legacyDigest: legacy,
      }),
    ).toBe(false)
  })

  it('差异不含密钥明文', () => {
    const next = {
      ...enabledAi,
      browserAi: {
        ...enabledAi.browserAi,
        secretRef: { provider: 'local' as const, secretId: '00000000-0000-4000-8000-000000000098' },
      },
    }
    const diffs = platformConfigDiff(enabledAi, next)
    expect(JSON.stringify(diffs)).not.toMatch(/sk-|password|apiKey/i)
    expect(diffs.some((item) => item.path.includes('secretRef'))).toBe(true)
  })

  it('首份修订没有上一版，差异为空', () => {
    expect(platformConfigDiff(undefined, FACTORY_PLATFORM_CONFIG)).toEqual([])
  })

  it('模型 origin 归一化且保留端口边界', () => {
    expect(modelServiceOrigin('https://MODEL.example:443/v2')).toBe('https://model.example')
    expect(modelServiceOrigin('https://model.example:8443/v1')).toBe('https://model.example:8443')
  })

  it('旧摘要按提供的嵌套字段比较，不把补齐的默认字段当作新请求', () => {
    const snapshot = { retainDays: { screenshot: 10, trace: 14 }, required: ['input', 'error'] }
    expect(overridesCompatible({ retainDays: { screenshot: 10 } }, snapshot)).toBe(true)
    expect(overridesCompatible({ retainDays: { trace: 14 } }, snapshot)).toBe(true)
    expect(overridesCompatible({ retainDays: { trace: 14, screenshot: 10 } }, snapshot)).toBe(true)
    expect(overridesCompatible({ retainDays: { trace: 7 } }, snapshot)).toBe(false)
    expect(overridesCompatible({ required: ['input'] }, snapshot)).toBe(false)
    expect(overridesCompatible({ retainDays: { trace: 14 } }, { retainDays: null })).toBe(false)
  })

  it.each(['off', 'on_failure', 'always'] as const)(
    'Trace 保留期按最终模式解析：平台 %s',
    (platformMode) => {
      const platform = {
        ...FACTORY_PLATFORM_CONFIG.evidence,
        trace: platformMode,
        retainDays: { screenshot: 30, trace: 21, debugTrace: 5 },
      }
      for (const mode of ['off', 'on_failure', 'always'] as const) {
        expect(resolvePlatformEvidencePolicy({ trace: mode }, platform).retainDays.trace).toBe(
          mode === 'always' ? 5 : 21,
        )
        expect(
          resolvePlatformEvidencePolicy({ trace: mode, retainDays: { trace: 3 } }, platform)
            .retainDays.trace,
        ).toBe(3)
      }
      expect(resolvePlatformEvidencePolicy(undefined, platform).retainDays.trace).toBe(
        platformMode === 'always' ? 5 : 21,
      )
    },
  )
})
