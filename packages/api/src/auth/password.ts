import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

const N = 16_384
const R = 8
const P = 1
const KEY_LEN = 32

/**
 * 本地密码哈希。用 Node 自带 scrypt，避免 argon2 原生编译——
 * 私有化离线安装时那是一个会炸的依赖。
 *
 * 格式：`$scrypt$n=<N>,r=<r>,p=<p>$<salt_b64>$<hash_b64>`
 */
export async function hashSecret(plain: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(plain, salt, KEY_LEN, { N, r: R, p: P })
  return `$scrypt$n=${N},r=${R},p=${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export async function verifySecret(plain: string, stored: string): Promise<boolean> {
  const match = stored.match(/^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/)
  if (!match) return false
  const n = Number(match[1])
  const r = Number(match[2])
  const p = Number(match[3])
  const salt = Buffer.from(match[4]!, 'base64url')
  const expected = Buffer.from(match[5]!, 'base64url')
  const derived = await scryptAsync(plain, salt, expected.length, { N: n, r, p })
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}
