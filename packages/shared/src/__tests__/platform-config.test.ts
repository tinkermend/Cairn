import { describe, expect, it } from 'vitest'
import { resolveStepPolicy } from '../policy.js'
import {
  FACTORY_PLATFORM_CONFIG,
  assertAiRequestTimeoutFitsSteps,
  idempotentRequestMatches,
  platformConfigDiff,
  platformConfigDocumentSchema,
  requiresAiSecretRebind,
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
    expect(platformConfigDocumentSchema.parse(FACTORY_PLATFORM_CONFIG)).toEqual(FACTORY_PLATFORM_CONFIG)
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
    expect(resolvePlatformExecutionPolicy({ timeoutMs: 1, retryLimit: 0 }, FACTORY_PLATFORM_CONFIG.execution)).toEqual({
      timeoutMs: 1,
      retryLimit: 0,
    })
  })

  it('AI Action 强制 retryLimit=0', () => {
    expect(resolveStepPolicy({ timeoutMs: 8_000, retryLimit: 3 }, undefined, 'ai_action').retryLimit).toBe(0)
    expect(
      resolveStepPolicy({ timeoutMs: 8_000, retryLimit: 3 }, { retryLimit: 5 }, 'ai_action').retryLimit,
    ).toBe(0)
    expect(resolveStepPolicy({ timeoutMs: 8_000, retryLimit: 3 }, undefined, 'click').retryLimit).toBe(3)
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
        snapshotSession: { reuse: 'NEW_PAGE', idleTtlSeconds: 600, maxLifetimeSeconds: 14_400, leaseTtlSeconds: 30, authWaitSeconds: 300 },
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

  it('更换模型服务 origin 且沿用旧 Secret 时必须重新登记', () => {
    expect(requiresAiSecretRebind(enabledAi.browserAi, enabledAi.browserAi)).toBe(false)
    expect(
      requiresAiSecretRebind(enabledAi.browserAi, {
        ...enabledAi.browserAi,
        baseUrl: 'https://model.example/v2',
      }),
    ).toBe(false)
    expect(
      requiresAiSecretRebind(enabledAi.browserAi, {
        ...enabledAi.browserAi,
        baseUrl: 'https://other.example/v1',
      }),
    ).toBe(true)
    expect(
      requiresAiSecretRebind(enabledAi.browserAi, {
        ...enabledAi.browserAi,
        baseUrl: 'https://other.example/v1',
        secretRef: { provider: 'local', secretId: '00000000-0000-4000-8000-000000000098' },
      }),
    ).toBe(false)
  })
})
