import { describe, expect, it } from 'vitest'
import { targetAuthProfileDefinitionSchema, type FrozenAuthVerification } from '@cairn/shared'
import { verifyAuthProfile } from './session-auth'
import type { BrowserHandle } from './runtime'

const definition = targetAuthProfileDefinitionSchema.parse({
  verify: {
    mode: 'http',
    success: { status: 200, jsonPath: '$.ok', equals: true },
    failure: { status: 401 },
  },
  identity: { source: 'json', jsonPath: '$.user', normalize: 'trim' },
  scope: { origins: ['https://example.com'], pathPrefixes: ['/api/me'] },
})

const verification: FrozenAuthVerification = {
  profileRevision: 1,
  profileDigest: 'digest',
  loginFieldsDigest: 'digest',
  expectedIdentity: 'alice',
  capability: 'IDENTITY_VERIFIED',
  freshnessSeconds: 300,
  verifyTimeoutMs: 1_000,
  loginTimeoutMs: 1_000,
  verifyRetryBackoffSeconds: [1],
  platformConfigRevision: 1,
}

function stubHttp(status: number, body: unknown): BrowserHandle {
  return {
    context: {
      request: {
        get: async () => ({
          status: () => status,
          json: async () => body,
          text: async () => JSON.stringify(body),
        }),
      },
    },
  } as unknown as BrowserHandle
}

describe('verifyAuthProfile', () => {
  it('正向 http 条件且身份匹配为 AUTHENTICATED', async () => {
    const result = await verifyAuthProfile(stubHttp(200, { ok: true, user: 'alice' }), {
      definition,
      verification,
    })
    expect(result.observation).toMatchObject({
      authState: 'AUTHENTICATED',
      identityState: 'MATCH',
      diagnosticCode: 'verified',
    })
  })

  it('401 为 EXPIRED；超时为 infra，不判成功', async () => {
    expect(
      (await verifyAuthProfile(stubHttp(401, {}), { definition, verification })).observation.authState,
    ).toBe('EXPIRED')
    const timedOut = await verifyAuthProfile(
      {
        context: {
          request: {
            get: async () => {
              throw new Error('timeout')
            },
          },
        },
      } as unknown as BrowserHandle,
      { definition, verification },
    )
    expect(timedOut.observation).toMatchObject({ authState: 'UNKNOWN', unknownClass: 'infra' })
  })
})
