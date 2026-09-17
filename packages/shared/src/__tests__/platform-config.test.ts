import { describe, expect, it } from 'vitest'
import { resolveStepPolicy } from '../policy.js'
import {
  FACTORY_PLATFORM_CONFIG,
  PLATFORM_CONFIG_SCHEMA_UNSUPPORTED,
  PLATFORM_CONFIG_SCHEMA_VERSION,
  assertAiRequestTimeoutFitsSteps,
  idempotentRequestMatches,
  platformConfigDiff,
  platformConfigDocumentSchema,
  modelServiceOrigin,
  overridesCompatible,
  resolvePlatformEvidencePolicy,
  resolvePlatformExecutionPolicy,
  platformConfigRevisionSchema,
  storedPlatformConfigDocumentSchema,
  upgradePlatformConfigDocument,
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

describe('平台配置默认值单源', () => {
  /** 每一节的 .default() 只能有一个来源：FACTORY_PLATFORM_CONFIG。 */
  it('只带必填节的文档补默认后必须逐字等于出厂配置', () => {
    const minimal = {
      schemaVersion: FACTORY_PLATFORM_CONFIG.schemaVersion,
      execution: FACTORY_PLATFORM_CONFIG.execution,
      session: FACTORY_PLATFORM_CONFIG.session,
      evidence: FACTORY_PLATFORM_CONFIG.evidence,
      browserAi: FACTORY_PLATFORM_CONFIG.browserAi,
    }
    expect(platformConfigDocumentSchema.parse(minimal)).toEqual(FACTORY_PLATFORM_CONFIG)
  })

  it('旧文档缺证据录像字段时补出厂值，与出厂配置同源', () => {
    const { video: _mode, retainDays, ...evidence } = FACTORY_PLATFORM_CONFIG.evidence
    const { video: _days, ...legacyRetainDays } = retainDays
    const parsed = platformConfigDocumentSchema.parse({
      ...FACTORY_PLATFORM_CONFIG,
      evidence: { ...evidence, retainDays: legacyRetainDays },
    })
    expect(parsed.evidence).toEqual(FACTORY_PLATFORM_CONFIG.evidence)
  })

  it('平台 AI 出厂值不是另抄的一份字面量', () => {
    const { platformAi: _dropped, ...legacy } = FACTORY_PLATFORM_CONFIG
    expect(platformConfigDocumentSchema.parse(legacy).platformAi).toEqual(
      FACTORY_PLATFORM_CONFIG.platformAi,
    )
  })
})

describe('平台配置文档版本升级', () => {
  it('当前版本文档原样通过并补齐缺省节', () => {
    const { moduleResolver: _dropped, ...legacy } = FACTORY_PLATFORM_CONFIG
    expect(upgradePlatformConfigDocument(legacy)).toEqual(FACTORY_PLATFORM_CONFIG)
  })

  it('schemaVersion 缺失或非法时给出可识别的错误码', () => {
    for (const bad of [undefined, null, 0, -1, 1.5, '1']) {
      const { schemaVersion: _dropped, ...rest } = FACTORY_PLATFORM_CONFIG
      const document = bad === undefined ? rest : { ...rest, schemaVersion: bad }
      expect(() => upgradePlatformConfigDocument(document)).toThrowError(
        expect.objectContaining({ code: PLATFORM_CONFIG_SCHEMA_UNSUPPORTED }),
      )
    }
  })

  it('文档版本高于本版本时拒绝读取，而不是当成当前版本解析', () => {
    expect(() =>
      upgradePlatformConfigDocument({
        ...FACTORY_PLATFORM_CONFIG,
        schemaVersion: PLATFORM_CONFIG_SCHEMA_VERSION + 1,
      }),
    ).toThrowError(/高于本版本支持的/)
  })

  it('非对象文档被拒绝', () => {
    for (const bad of [null, undefined, 'x', 1, []]) {
      expect(() => upgradePlatformConfigDocument(bad)).toThrowError(
        expect.objectContaining({ code: PLATFORM_CONFIG_SCHEMA_UNSUPPORTED }),
      )
    }
  })

  it('存量文档补录像字段且不改已有截图策略，也不占一个 schema 版本', () => {
    const stored = {
      ...FACTORY_PLATFORM_CONFIG,
      schemaVersion: PLATFORM_CONFIG_SCHEMA_VERSION,
      evidence: {
        screenshot: 'on_failure' as const,
        trace: 'off' as const,
        retainDays: {
          screenshot: 30,
          trace: 14,
          debugTrace: 7,
        },
      },
    }
    const read = upgradePlatformConfigDocument(stored)
    expect(read.schemaVersion).toBe(PLATFORM_CONFIG_SCHEMA_VERSION)
    expect(read.evidence.screenshot).toBe('on_failure')
    expect(read.evidence.video).toBe(FACTORY_PLATFORM_CONFIG.evidence.video)
    expect(read.evidence.retainDays.video).toBe(
      FACTORY_PLATFORM_CONFIG.evidence.retainDays.video,
    )
  })

  it('内容非法仍按 Schema 报错，不被升级流程吞掉', () => {
    expect(() =>
      upgradePlatformConfigDocument({
        ...FACTORY_PLATFORM_CONFIG,
        execution: { defaultTimeoutMs: -1, defaultRetryLimit: 0 },
      }),
    ).toThrowError()
  })
})

describe('历史修订读取不被当前 Schema 绑死', () => {
  it('含已删除节或未知节的历史文档仍可解析出来展示', () => {
    const stored = { ...FACTORY_PLATFORM_CONFIG, retiredSection: { legacy: true } }
    expect(storedPlatformConfigDocumentSchema.parse(stored)).toEqual(stored)
  })

  it('修订 DTO 不按当前文档 Schema 校验历史内容', () => {
    const item = platformConfigRevisionSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      revision: 7,
      document: { schemaVersion: 1, retiredSection: { legacy: true } },
      actorAccountId: null,
      reason: '历史修订',
      source: 'update',
      createdAt: '2026-09-17T00:00:00.000Z',
      diff: [],
    })
    expect(item.document).toEqual({ schemaVersion: 1, retiredSection: { legacy: true } })
  })

  it('差异计算接受任意历史形状', () => {
    const diffs = platformConfigDiff(
      { schemaVersion: 1, retiredSection: { legacy: true } },
      { schemaVersion: 1, retiredSection: { legacy: false } },
    )
    expect(diffs).toEqual([{ path: 'retiredSection.legacy', from: true, to: false }])
  })
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

  it('旧修订 session 缺保活字段时补出厂 IDLE', () => {
    const { session, ...rest } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse({
      ...rest,
      session: {
        reuse: session.reuse,
        idleTtlSeconds: session.idleTtlSeconds,
        maxLifetimeSeconds: session.maxLifetimeSeconds,
        authWaitSeconds: session.authWaitSeconds,
      },
    })
    expect(parsed.session.reclaim).toBe('IDLE')
    expect(parsed.session.keepAliveSeconds).toBe(3600)
    expect(parsed.session.authProbeIntervalSeconds).toBe(900)
    expect(parsed.session.evictionPriority).toBe(0)
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

  it('旧修订没有 runtimeInvariants 时补出厂关闭逐步探测', () => {
    const { runtimeInvariants: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.runtimeInvariants).toEqual({ allowEachStepProbe: false })
    expect('runtimeInvariants' in legacy).toBe(false)
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
          reclaim: 'IDLE',
          keepAliveSeconds: 3_600,
          authProbeIntervalSeconds: 900,
          evictionPriority: 0,
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
        retainDays: { screenshot: 30, video: 14, trace: 21, debugTrace: 5 },
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
