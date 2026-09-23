import crypto from 'node:crypto'

/**
 * Base32 字符映射表 (RFC 4648 标准，不带 padding 兼容带 padding)
 */
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(encoded: string): Buffer {
  const cleaned = encoded.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const output: number[] = []

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!
    const idx = BASE32_CHARS.indexOf(char)
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${char}`)
    }
    value = (value << 5) | idx
    bits += 5

    if (bits >= 8) {
      bits -= 8
      output.push((value >> bits) & 0xff)
    }
  }

  return Buffer.from(output)
}

export type TotpOptions = {
  /** 时间周期（秒），RFC 6238 默认为 30 秒 */
  periodSeconds?: number
  /** 口令长度，默认为 6 位 */
  digits?: number
  /** 当前参考时间戳（毫秒），默认为 Date.now() */
  timestampMs?: number
}

/**
 * 计算 RFC 6238 标准 TOTP 动态口令
 * 纯原生 node:crypto 实现，零第三方依赖
 */
export function generateTotp(secretBase32: string, options: TotpOptions = {}): string {
  const period = options.periodSeconds ?? 30
  const digits = options.digits ?? 6
  const timestamp = options.timestampMs ?? Date.now()

  const key = decodeBase32(secretBase32)
  const counter = Math.floor(timestamp / 1000 / period)

  // 8 字节大端整数
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter), 0)

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest()

  // 动态截断 Dynamic Truncation
  const offset = hmac[hmac.length - 1]! & 0x0f
  const binaryCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff)

  const otp = binaryCode % Math.pow(10, digits)
  return String(otp).padStart(digits, '0')
}
