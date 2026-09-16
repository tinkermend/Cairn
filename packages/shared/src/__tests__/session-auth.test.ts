import { describe, expect, it } from 'vitest'
import {
  FACTORY_SESSION_AUTH,
  assertFreshnessInRange,
  compareAuthIdentity,
  deriveAuthCapability,
  isAuthEvidenceFresh,
  platformSessionAuthSchema,
  evaluateAuthVerify,
  planAuthEnsure,
  classifyAuthSignals,
  readJsonPath,
  resolveVerifyUrl,
  targetAuthProfileDefinitionSchema,
  validationStepComplete,
  type AuthObservation,
  type AuthProfileValidation,
  type TargetAuthProfileDefinition,
} from '../session-auth.js'

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

  it('LOGIN_VERIFIED 不自动登录；infra 先退避再回交', () => {
    expect(
      planAuthEnsure({
        capability: 'LOGIN_VERIFIED',
        fresh: false,
        observation: observation({ authState: 'EXPIRED' }),
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
