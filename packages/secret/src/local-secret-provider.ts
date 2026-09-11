import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { decodeCredentialKey } from '@cairn/shared'

const VERSION = 1
const IV_LENGTH = 12
const TAG_LENGTH = 16

export function credentialKeyFromEnv(raw: string): Buffer {
  const bytes = decodeCredentialKey(raw)
  if (!bytes) throw new Error('CAIRN_CREDENTIAL_KEY 不是合法的 32 字节 base64 密钥')
  return Buffer.from(bytes)
}

/**
 * 本地 AES-256-GCM 实现。密文：版本(1) ‖ IV(12) ‖ tag(16) ‖ 正文。
 * AAD 固定为 secrets.id 的 36 个 ASCII 字节。
 * 控制面与执行面共用，业务代码不得依赖其它 Secret Backend 形态。
 */
export class LocalSecretProvider {
  constructor(private readonly key: Buffer) {
    if (this.key.length !== 32) throw new Error('凭据主密钥必须是 32 字节')
  }

  encrypt(secretId: string, plaintext: string): Buffer {
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(secretId, 'ascii'))
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([Buffer.from([VERSION]), iv, tag, encrypted])
  }

  decrypt(secretId: string, blob: Buffer): string {
    if (blob.length < 1 + IV_LENGTH + TAG_LENGTH) throw new Error('密文过短')
    if (blob[0] !== VERSION) throw new Error(`不支持的密文版本 ${blob[0]}`)
    const iv = blob.subarray(1, 1 + IV_LENGTH)
    const tag = blob.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH)
    const data = blob.subarray(1 + IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAAD(Buffer.from(secretId, 'ascii'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  }
}
