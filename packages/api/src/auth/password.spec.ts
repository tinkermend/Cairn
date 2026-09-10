import { describe, expect, it } from 'vitest'
import { hashSecret, verifySecret } from './password'

describe('password scrypt', () => {
  it('同源密码验证通过，错误密码失败', async () => {
    const stored = await hashSecret('cairn-admin')
    expect(stored.startsWith('$scrypt$')).toBe(true)
    expect(await verifySecret('cairn-admin', stored)).toBe(true)
    expect(await verifySecret('wrong-password', stored)).toBe(false)
  })

  it('非法哈希串不会抛错', async () => {
    expect(await verifySecret('anything', '$argon2id$not-this')).toBe(false)
    expect(await verifySecret('anything', 'plain')).toBe(false)
  })
})
