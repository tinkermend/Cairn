import { describe, expect, it } from 'vitest'
import { LOCAL_SECRET_PROVIDER, secretRefSchema } from '../secret-ref.js'

describe('secretRefSchema', () => {
  it('只接受 provider 与 secretId', () => {
    expect(
      secretRefSchema.parse({ provider: LOCAL_SECRET_PROVIDER, secretId: 'acct-secret-1' }),
    ).toEqual({
      provider: 'local',
      secretId: 'acct-secret-1',
    })
  })

  it('拒绝夹带明文密码', () => {
    expect(() =>
      secretRefSchema.parse({
        provider: 'local',
        secretId: 'acct-secret-1',
        password: 'hunter2',
      }),
    ).toThrow()
  })

  it('拒绝 value / secret 别名', () => {
    expect(() =>
      secretRefSchema.parse({ provider: 'local', secretId: 'acct-secret-1', value: 'tok' }),
    ).toThrow()
    expect(() =>
      secretRefSchema.parse({ provider: 'local', secretId: 'acct-secret-1', secret: 'tok' }),
    ).toThrow()
  })
})
