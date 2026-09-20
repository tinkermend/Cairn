import { describe, expect, it } from 'vitest'
import {
  FACTORY_SESSION_AUTH,
  assertFreshnessInRange,
  compareAuthIdentity,
  activeDetectionReady,
  deriveAuthCapability,
  isAuthEvidenceFresh,
  platformSessionAuthSchema,
  evaluateAuthVerify,
  planAuthEnsure,
  classifyAuthSignals,
  readJsonPath,
  resolveVerifyUrl,
  targetAuthProfileDefinitionSchema,
  targetCaptchaDefinitionSchema,
  captchaFingerprintRuleSchema,
  mergeCaptchaLoginKindParams,
  resolveCaptchaHoldSeconds,
  challengeAuditRecordSchema,
  validationStepComplete,
  type AuthObservation,
  type AuthProfileValidation,
  type TargetAuthProfileDefinition,
} from '../session-auth.js'
import { BUILTIN_CAPTCHA_FINGERPRINTS } from '../captcha-fingerprints.js'

const httpDefinition: TargetAuthProfileDefinition = targetAuthProfileDefinitionSchema.parse({
  verify: {
    mode: 'http',
    success: { status: 200, jsonPath: '$.ok', equals: true },
    failure: { status: 401 },
  },
  identity: { source: 'json', jsonPath: '$.user', normalize: 'trim' },
  scope: { origins: ['https://example.com'], pathPrefixes: ['/api/me'] },
})

const actor = '00000000-0000-4000-8000-000000000001'
const operation = '00000000-0000-4000-8000-000000000002'

function observation(overrides: Partial<AuthObservation>): AuthObservation {
  return {
    authState: 'UNKNOWN',
    identityState: 'UNVERIFIED',
    observedIdentity: null,
    unknownClass: null,
    evidenceSummary: null,
    authProfileRevision: 1,
    diagnosticCode: null,
    ...overrides,
  }
}

function validation(steps: AuthProfileValidation['steps']): AuthProfileValidation {
  return {
    recordedAt: '2026-09-16T00:00:00.000Z',
    actorId: actor,
    operationId: operation,
    steps,
  }
}

describe('deriveAuthCapability', () => {
  it('无修订或验收未齐为 LEGACY', () => {
    expect(deriveAuthCapability({ definition: null, validation: null, expectedIdentity: null })).toBe('LEGACY')
    expect(
      deriveAuthCapability({
        definition: httpDefinition,
        validation: validation({ valid_pass: observation({ authState: 'AUTHENTICATED' }) }),
        expectedIdentity: 'alice',
      }),
    ).toBe('LEGACY')
  })

  it('通过与撤销两项通过且无完整身份为 LOGIN_VERIFIED', () => {
    expect(
      deriveAuthCapability({
        definition: httpDefinition,
        validation: validation({
          valid_pass: observation({ authState: 'AUTHENTICATED' }),
          server_revoked: observation({ authState: 'EXPIRED' }),
        }),
        expectedIdentity: 'alice',
      }),
    ).toBe('LOGIN_VERIFIED')
  })

  it('主动检测就绪只看规则与验收，不看期望身份', () => {
    expect(activeDetectionReady({ definition: null, validation: null })).toBe(false)
    expect(
      activeDetectionReady({
        definition: httpDefinition,
        validation: validation({ valid_pass: observation({ authState: 'AUTHENTICATED' }) }),
      }),
    ).toBe(false)
    expect(
      activeDetectionReady({
        definition: httpDefinition,
        validation: validation({
          valid_pass: observation({ authState: 'AUTHENTICATED' }),
          server_revoked: observation({ authState: 'EXPIRED' }),
        }),
      }),
    ).toBe(true)
  })

  it('三项通过且账号有期望身份为 IDENTITY_VERIFIED', () => {
    expect(
      deriveAuthCapability({
        definition: httpDefinition,
        validation: validation({
          valid_pass: observation({ authState: 'AUTHENTICATED' }),
          server_revoked: observation({ authState: 'EXPIRED' }),
          other_account: observation({ authState: 'AUTHENTICATED', identityState: 'MISMATCH' }),
        }),
        expectedIdentity: 'alice',
      }),
    ).toBe('IDENTITY_VERIFIED')
  })
})

describe('identity 与新鲜度', () => {
  it('规范化后精确比较', () => {
    expect(compareAuthIdentity(' Alice ', 'alice', 'lowercase')).toBe('MATCH')
    expect(compareAuthIdentity('bob', 'alice', 'trim')).toBe('MISMATCH')
    expect(compareAuthIdentity(null, 'alice', 'trim')).toBe('UNVERIFIED')
  })

  it('新鲜度看成功时间、代次、修订与期望身份', () => {
    const fresh = isAuthEvidenceFresh({
      lastAuthSuccessAt: '2026-09-16T00:04:00.000Z',
      freshnessSeconds: 300,
      nowMs: Date.parse('2026-09-16T00:05:00.000Z'),
      sessionGeneration: 2,
      frozenGeneration: 2,
      profileRevision: 3,
      frozenRevision: 3,
      expectedIdentity: 'alice',
      frozenExpectedIdentity: 'alice',
    })
    expect(fresh).toBe(true)
    expect(
      isAuthEvidenceFresh({
        lastAuthSuccessAt: '2026-09-16T00:00:00.000Z',
        freshnessSeconds: 300,
        nowMs: Date.parse('2026-09-16T00:06:00.000Z'),
        sessionGeneration: 2,
        frozenGeneration: 2,
        profileRevision: 3,
        frozenRevision: 3,
        expectedIdentity: 'alice',
        frozenExpectedIdentity: 'alice',
      }),
    ).toBe(false)
    expect(
      isAuthEvidenceFresh({
        lastAuthSuccessAt: '2026-09-16T00:04:00.000Z',
        freshnessSeconds: 300,
        nowMs: Date.parse('2026-09-16T00:05:00.000Z'),
        sessionGeneration: 3,
        frozenGeneration: 2,
        profileRevision: 3,
        frozenRevision: 3,
        expectedIdentity: 'alice',
        frozenExpectedIdentity: 'alice',
      }),
    ).toBe(false)
    expect(
      isAuthEvidenceFresh({
        lastAuthSuccessAt: '2026-09-16T00:04:00.000Z',
        freshnessSeconds: 300,
        nowMs: Date.parse('2026-09-16T00:05:00.000Z'),
        sessionGeneration: 2,
        frozenGeneration: 2,
        profileRevision: 3,
        frozenRevision: 3,
        expectedIdentity: 'alice',
        frozenExpectedIdentity: 'bob',
      }),
    ).toBe(false)
  })

  it('被动信号只分类不门禁', () => {
    const expired = classifyAuthSignals({
      observation: observation({ authState: 'EXPIRED', evidenceSummary: '失效条件 HTTP 401' }),
      pageUrl: 'https://example.com/login',
      loginUrl: 'https://example.com/login',
      at: '2026-09-16T00:00:00.000Z',
    })
    expect(expired.map((item) => item.kind)).toEqual(['auth_endpoint_expired', 'navigated_to_login'])
  })

  it('hash 登录页记导航信号，同 pathname 的后台不记', () => {
    const login = classifyAuthSignals({
      observation: observation({ authState: 'EXPIRED' }),
      pageUrl: 'https://demo.gin-vue-admin.com/#/login',
      loginUrl: 'https://demo.gin-vue-admin.com/#/login',
      at: '2026-09-16T00:00:00.000Z',
    })
    expect(login.map((item) => item.kind)).toEqual(['auth_endpoint_expired', 'navigated_to_login'])
    const dashboard = classifyAuthSignals({
      observation: observation({ authState: 'AUTHENTICATED' }),
      pageUrl: 'https://demo.gin-vue-admin.com/#/layout/dashboard',
      loginUrl: 'https://demo.gin-vue-admin.com/#/login',
      at: '2026-09-16T00:00:00.000Z',
    })
    expect(dashboard.map((item) => item.kind)).toEqual([])
  })

  it('覆盖值越界被拒绝，范围内通过', () => {
    expect(() => assertFreshnessInRange(30, FACTORY_SESSION_AUTH)).toThrow()
    expect(() => assertFreshnessInRange(120, FACTORY_SESSION_AUTH)).not.toThrow()
  })
})

describe('sessionAuth 出厂', () => {
  it('出厂默认可解析且退避非递减', () => {
    expect(platformSessionAuthSchema.parse(FACTORY_SESSION_AUTH)).toEqual(FACTORY_SESSION_AUTH)
    expect(() =>
      platformSessionAuthSchema.parse({
        ...FACTORY_SESSION_AUTH,
        verifyRetryBackoffSeconds: [120, 30],
      }),
    ).toThrow()
  })

  it('验收步形状', () => {
    expect(validationStepComplete('valid_pass', observation({ authState: 'AUTHENTICATED' }))).toBe(true)
    expect(validationStepComplete('server_revoked', observation({ authState: 'EXPIRED' }))).toBe(true)
    expect(validationStepComplete('other_account', observation({ identityState: 'MISMATCH' }))).toBe(true)
  })
})

describe('evaluateAuthVerify', () => {
  it('正向 http 条件且读到身份为 AUTHENTICATED', () => {
    expect(resolveVerifyUrl(httpDefinition)).toBe('https://example.com/api/me')
    expect(readJsonPath({ user: 'alice' }, '$.user')).toBe('alice')
    const result = evaluateAuthVerify({
      definition: httpDefinition,
      raw: { kind: 'http', status: 200, body: { ok: true, user: 'alice' }, url: 'https://example.com/api/me' },
      expectedIdentity: 'alice',
      revision: 1,
    })
    expect(result).toMatchObject({
      authState: 'AUTHENTICATED',
      identityState: 'MATCH',
      observedIdentity: 'alice',
      diagnosticCode: 'verified',
    })
  })

  it('401 失效条件为 EXPIRED；5xx 与超时为 infra', () => {
    expect(
      evaluateAuthVerify({
        definition: httpDefinition,
        raw: { kind: 'http', status: 401, body: {}, url: 'https://example.com/api/me' },
        expectedIdentity: 'alice',
        revision: 1,
      }).authState,
    ).toBe('EXPIRED')
    expect(
      evaluateAuthVerify({
        definition: httpDefinition,
        raw: { kind: 'http', status: 500, body: {}, url: 'https://example.com/api/me' },
        expectedIdentity: 'alice',
        revision: 1,
      }),
    ).toMatchObject({ authState: 'UNKNOWN', unknownClass: 'infra' })
    expect(
      evaluateAuthVerify({
        definition: httpDefinition,
        raw: { kind: 'infra', message: 'timeout' },
        expectedIdentity: 'alice',
        revision: 1,
      }).unknownClass,
    ).toBe('infra')
  })

  it('无关 403 为 unmatched，不判过期', () => {
    expect(
      evaluateAuthVerify({
        definition: httpDefinition,
        raw: { kind: 'http', status: 403, body: { ok: false }, url: 'https://example.com/api/me' },
        expectedIdentity: 'alice',
        revision: 1,
      }),
    ).toMatchObject({ authState: 'UNKNOWN', unknownClass: 'unmatched' })
  })
})

describe('planAuthEnsure', () => {
  it('IDENTITY_VERIFIED 新鲜则复用，过期自动登录，不符进人工', () => {
    expect(planAuthEnsure({ capability: 'IDENTITY_VERIFIED', fresh: true, infraAttempts: 0, backoffSeconds: [30] })).toEqual({
      action: 'reuse',
    })
    expect(
      planAuthEnsure({
        capability: 'IDENTITY_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'EXPIRED' }),
        infraAttempts: 0,
        backoffSeconds: [30],
      }).action,
    ).toBe('auto_login')
    expect(
      planAuthEnsure({
        capability: 'IDENTITY_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'AUTHENTICATED', identityState: 'MISMATCH' }),
        infraAttempts: 0,
        backoffSeconds: [30],
      }),
    ).toMatchObject({ action: 'manual', code: 'AUTH_IDENTITY_MISMATCH' })
  })

  it('LOGIN_VERIFIED 失效后自动登录，不因该档改走人工；infra 先退避再回交', () => {
    expect(
      planAuthEnsure({
        capability: 'LOGIN_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'EXPIRED' }),
        infraAttempts: 0,
        backoffSeconds: [30],
      }).action,
    ).toBe('auto_login')
    expect(
      planAuthEnsure({
        capability: 'LOGIN_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'UNKNOWN', unknownClass: 'unmatched' }),
        infraAttempts: 0,
        backoffSeconds: [30],
      }).action,
    ).toBe('manual')
    expect(
      planAuthEnsure({
        capability: 'IDENTITY_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'UNKNOWN', unknownClass: 'infra' }),
        infraAttempts: 0,
        backoffSeconds: [30, 120],
      }),
    ).toEqual({ action: 'backoff_verify', delaySeconds: 30 })
    expect(
      planAuthEnsure({
        capability: 'IDENTITY_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'UNKNOWN', unknownClass: 'infra' }),
        infraAttempts: 2,
        backoffSeconds: [30, 120],
      }).action,
    ).toBe('yield')
  })
})

describe('captcha schemas and fingerprints', () => {
  it('验证 targetCaptchaDefinitionSchema 支持图形与滑块配置', () => {
    const graphic = targetCaptchaDefinitionSchema.parse({
      type: 'IMAGE',
      image: {
        imageLocator: { by: 'css', value: 'img.captcha' },
        inputLocator: { by: 'css', value: 'input[name="code"]' },
        charsetRange: 0,
        expectedLength: 6,
        colors: ['red'],
      },
    })
    expect(graphic.type).toBe('IMAGE')
    expect(graphic.image?.imageLocator.value).toBe('img.captcha')
    expect(graphic.image?.charsetRange).toBe(0)

    const slider = targetCaptchaDefinitionSchema.parse({
      type: 'SLIDER',
      slider: {
        bgLocator: { by: 'css', value: '.slider-bg' },
        knobLocator: { by: 'css', value: '.slider-knob' },
        mode: 'TRACK',
      },
    })
    expect(slider.type).toBe('SLIDER')
    expect(slider.slider?.mode).toBe('TRACK')
  })

  it('出厂平台配置包含合法的验证码与拖拽参数', () => {
    expect(FACTORY_SESSION_AUTH.captchaMaxAttempts).toBe(2)
    expect(FACTORY_SESSION_AUTH.captchaSolveTimeoutMs).toBe(20_000)
    expect(FACTORY_SESSION_AUTH.captchaHumanWaitSeconds).toBe(300)
    expect(FACTORY_SESSION_AUTH.sliderDragMinDurationMs).toBe(800)
    expect(FACTORY_SESSION_AUTH.sliderDragMaxDurationMs).toBe(1_500)

    // 最小耗时大于最大耗时应抛错
    expect(() =>
      platformSessionAuthSchema.parse({
        ...FACTORY_SESSION_AUTH,
        sliderDragMinDurationMs: 2000,
        sliderDragMaxDurationMs: 1000,
      }),
    ).toThrow('滑块拖拽最小耗时不得大于最大耗时')
  })

  it('内置指纹库包含 Gin-Vue-Admin 与 Vben Admin 探针', () => {
    expect(BUILTIN_CAPTCHA_FINGERPRINTS.length).toBeGreaterThanOrEqual(2)
    const gva = BUILTIN_CAPTCHA_FINGERPRINTS.find((f) => f.id === 'gin-vue-admin-image')
    expect(gva?.challengeType).toBe('IMAGE_CAPTCHA')
    expect(gva?.detectors.imageSelector).toContain('data:image/png;base64')
    expect(gva?.charsetRange).toBe(0)
    expect(gva?.expectedLength).toBe(6)
    expect(
      captchaFingerprintRuleSchema.parse(gva).charsetRange,
    ).toBe(0)

    const vben = BUILTIN_CAPTCHA_FINGERPRINTS.find((f) => f.id === 'vben-admin-slider')
    expect(vben?.challengeType).toBe('SLIDER_CAPTCHA')
    expect(vben?.detectors.knobSelector).toBe('.cursor-move')
  })

  it('challengeAuditRecord 接受合法的挑战事实', () => {
    const record = challengeAuditRecordSchema.parse({
      challengeId: '00000000-0000-4000-8000-000000000091',
      sessionId: '00000000-0000-4000-8000-000000000092',
      challengeType: 'SLIDER_CAPTCHA',
      handledBy: 'MACHINE',
      attemptsUsed: 1,
      success: true,
      durationMs: 950,
      timestamp: '2026-09-18T12:00:00.000Z',
    })
    expect(record.handledBy).toBe('MACHINE')
    expect(record.attemptsUsed).toBe(1)
  })

  it('mergeCaptchaLoginKindParams 累积尝试并保留 MACHINE_HANDLING', () => {
    const first = mergeCaptchaLoginKindParams(undefined, {
      attempt: 1,
      maxAttempts: 2,
      challengeType: 'IMAGE_CAPTCHA',
      outcome: 'captcha_failed',
      audit: {
        challengeId: '00000000-0000-4000-8000-000000000091',
        sessionId: '00000000-0000-4000-8000-000000000092',
        challengeType: 'IMAGE_CAPTCHA',
        handledBy: 'MACHINE',
        attemptsUsed: 1,
        success: false,
        durationMs: 120,
        timestamp: '2026-09-18T12:00:00.000Z',
      },
    })
    expect(first.captchaPhase).toBe('MACHINE_HANDLING')
    expect(first.attempt).toBe(1)
    const second = mergeCaptchaLoginKindParams(first, {
      attempt: 2,
      maxAttempts: 2,
      challengeType: 'IMAGE_CAPTCHA',
      outcome: 'ambiguous',
      audit: {
        challengeId: '00000000-0000-4000-8000-000000000091',
        sessionId: '00000000-0000-4000-8000-000000000092',
        challengeType: 'IMAGE_CAPTCHA',
        handledBy: 'MACHINE',
        attemptsUsed: 2,
        success: false,
        durationMs: 240,
        timestamp: '2026-09-18T12:00:01.000Z',
      },
    })
    expect(second.outcome).toBe('ambiguous')
    expect(second.attempts).toHaveLength(2)
  })

  it('resolveCaptchaHoldSeconds 优先用平台验证码人工等待', () => {
    expect(resolveCaptchaHoldSeconds({ captchaHumanWaitSeconds: 180 }, 300)).toBe(180)
    expect(resolveCaptchaHoldSeconds(undefined, 300)).toBe(300)
  })
})

