import { describe, expect, it } from 'vitest'
import { DEV_CREDENTIAL_KEY } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '../local-secret-provider.js'

const idA = '11111111-1111-4111-8111-111111111111'
const idB = '22222222-2222-4222-8222-222222222222'

describe('LocalSecretProvider', () => {
  const provider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))

  it('同一 secretId 可往返', () => {
    const blob = provider.encrypt(idA, 'hunter2')
    expect(blob[0]).toBe(1)
    expect(provider.decrypt(idA, blob)).toBe('hunter2')
  })

  it('换行后的密文不能用另一 id 解开', () => {
    const blob = provider.encrypt(idA, 'hunter2')
    expect(() => provider.decrypt(idB, blob)).toThrow()
  })

  it('每次写入 IV 不同', () => {
    const a = provider.encrypt(idA, 'same')
    const b = provider.encrypt(idA, 'same')
    expect(Buffer.compare(a, b) === 0).toBe(false)
  })
})
