import { describe, expect, it } from 'vitest'
import { decodeBase32, generateTotp } from './totp.js'

describe('RFC 6238 TOTP 原生算法验证', () => {
  // ASCII: "12345678901234567890" -> Base32
  const rfcSecretBase32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  it('Base32 解码应正确还原原始字节', () => {
    const decoded = decodeBase32(rfcSecretBase32)
    expect(decoded.toString('ascii')).toBe('12345678901234567890')
  })

  it('解码应容忍空格、小写与连字符', () => {
    const decoded = decodeBase32('gezd-gnbv gy3t-qojq gezd-gnbv gy3t-qojq')
    expect(decoded.toString('ascii')).toBe('12345678901234567890')
  })

  it('符合 RFC 6238 官方附录 B 标准测试向量 (HMAC-SHA1)', () => {
    // Unix Time: 59 -> step 1 -> 287082
    expect(generateTotp(rfcSecretBase32, { timestampMs: 59 * 1000 })).toBe('287082')

    // Unix Time: 1111111109 -> step 37037036 -> 081804
    expect(generateTotp(rfcSecretBase32, { timestampMs: 1111111109 * 1000 })).toBe('081804')

    // Unix Time: 1111111111 -> step 37037037 -> 050471
    expect(generateTotp(rfcSecretBase32, { timestampMs: 1111111111 * 1000 })).toBe('050471')

    // Unix Time: 1234567890 -> step 41152263 -> 005924
    expect(generateTotp(rfcSecretBase32, { timestampMs: 1234567890 * 1000 })).toBe('005924')

    // Unix Time: 2000000000 -> step 66666666 -> 279037
    expect(generateTotp(rfcSecretBase32, { timestampMs: 2000000000 * 1000 })).toBe('279037')
  })

  it('常规当前时间生成 6 位纯数字口令', () => {
    const code = generateTotp('JBSWY3DPEHPK3PXP')
    expect(code).toMatch(/^\d{6}$/)
  })
})
