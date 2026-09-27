import { describe, expect, it, vi } from 'vitest'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    resolveSnapshotCredential: vi.fn(),
    resolveAccountCurrentCredential: vi.fn(),
    resolveAccountAuthMaterials: vi.fn(),
    loadSecretCiphertext: vi.fn(),
    recordCredentialVerification: vi.fn(),
    loadAccountForExecution: vi.fn(),
  }
})

import {
  loadSecretCiphertext,
  resolveAccountAuthMaterials,
  resolveSnapshotCredential,
} from '@cairn/db'
import { resolveLoginCredential } from './session-claim.js'
import { resolveAccountCredential } from './session-maintenance-runtime.js'

describe('凭据取用配对', () => {
  it('快照取用只认冻结登录名，不回落当前账号名', async () => {
    vi.mocked(resolveSnapshotCredential).mockResolvedValue({
      username: 'frozen-user',
      secretId: '00000000-0000-4000-8000-000000000001',
      provider: 'local',
      credentialId: 'c1',
      versionId: 'v1',
      identityRevision: 1,
    })
    vi.mocked(loadSecretCiphertext).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000001',
      provider: 'local',
      ciphertext: Buffer.from('cipher'),
    })
    const ctx = {
      resolveCredential: undefined,
      secrets: { decrypt: () => 'pw' },
      dbHandle: {},
    }
    const resolved = await resolveLoginCredential.call(
      ctx as never,
      { secretRef: { provider: 'local', secretId: '00000000-0000-4000-8000-000000000001' } } as never,
    )
    expect(resolved).toEqual({
      username: 'frozen-user',
      password: 'pw',
      secretId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('待确认身份时当前账号凭据不可取用', async () => {
    // resolveAccountCredential 现在走 resolveAccountAuthMaterials 取素材（含 TOTP／
    // storageState），不再经旧的 resolveAccountCurrentCredential；素材查不到即视为
    // 身份未确认，凭据不可取用。
    vi.mocked(resolveAccountAuthMaterials).mockResolvedValue(null)
    const ctx = { secrets: { decrypt: () => 'pw' }, dbHandle: {} }
    await expect(resolveAccountCredential.call(ctx as never, 'account-1')).resolves.toBeNull()
  })

  it('未配置密码 secretId 时 password 为 undefined，不是空字符串', async () => {
    vi.mocked(resolveAccountAuthMaterials).mockResolvedValue({
      username: 'bob',
      passwordSecretId: null,
      totpSecretId: null,
      storageStateSecretId: null,
      storageStateUpdatedAt: null,
    } as any)
    const ctx = { secrets: { decrypt: () => 'pw' }, dbHandle: {} }
    const result = await resolveAccountCredential.call(ctx as never, 'account-1')
    expect(result).toEqual({
      username: 'bob',
      password: undefined,
      totpSecret: undefined,
      storageState: undefined,
      secretId: null,
    })
    expect(result?.password).toBeUndefined()
  })

  it.each([
    {
      field: 'password',
      materials: { username: 'bob', passwordSecretId: 'sec-pw' },
      loadRow: null,
      desc: '密文缺失',
    },
    {
      field: 'password',
      materials: { username: 'bob', passwordSecretId: 'sec-pw' },
      loadRow: { id: 'sec-pw', provider: 'vault', ciphertext: Buffer.from('c') },
      desc: 'provider 非 local',
    },
    {
      field: 'password',
      materials: { username: 'bob', passwordSecretId: 'sec-pw' },
      loadRow: { id: 'sec-pw', provider: 'local', ciphertext: Buffer.from('c') },
      decryptThrows: true,
      desc: 'decrypt 抛错',
    },
    {
      field: 'totp',
      materials: { username: 'bob', totpSecretId: 'sec-totp' },
      loadRow: null,
      desc: 'TOTP 密文缺失',
    },
    {
      field: 'totp',
      materials: { username: 'bob', totpSecretId: 'sec-totp' },
      loadRow: { id: 'sec-totp', provider: 'vault', ciphertext: Buffer.from('c') },
      desc: 'TOTP provider 非 local',
    },
    {
      field: 'totp',
      materials: { username: 'bob', totpSecretId: 'sec-totp' },
      loadRow: { id: 'sec-totp', provider: 'local', ciphertext: Buffer.from('c') },
      decryptThrows: true,
      desc: 'TOTP decrypt 抛错',
    },
    {
      field: 'storageState',
      materials: { username: 'bob', storageStateSecretId: 'sec-ss' },
      loadRow: null,
      desc: 'storageState 密文缺失',
    },
    {
      field: 'storageState',
      materials: { username: 'bob', storageStateSecretId: 'sec-ss' },
      loadRow: { id: 'sec-ss', provider: 'vault', ciphertext: Buffer.from('c') },
      desc: 'storageState provider 非 local',
    },
    {
      field: 'storageState',
      materials: { username: 'bob', storageStateSecretId: 'sec-ss' },
      loadRow: { id: 'sec-ss', provider: 'local', ciphertext: Buffer.from('c') },
      decryptThrows: true,
      desc: 'storageState decrypt 抛错',
    },
    {
      field: 'storageState',
      materials: { username: 'bob', storageStateSecretId: 'sec-ss' },
      loadRow: { id: 'sec-ss', provider: 'local', ciphertext: Buffer.from('c') },
      decryptedText: 'invalid json {{{',
      desc: 'storageState JSON.parse 失败',
    },
  ])('resolveAccountCredential 在已配置 $field 遇到 $desc 时抛出 AUTH_CREDENTIAL_UNREADABLE 且不泄露明文', async (tc) => {
    vi.mocked(resolveAccountAuthMaterials).mockResolvedValue(tc.materials as any)
    vi.mocked(loadSecretCiphertext).mockResolvedValue(tc.loadRow as any)
    const ctx = {
      secrets: {
        decrypt: () => {
          if (tc.decryptThrows) throw new Error('decrypt failed: bad key')
          return tc.decryptedText ?? 'secret-clear-text'
        },
      },
      dbHandle: {},
    }
    const err = await resolveAccountCredential.call(ctx as never, 'account-1').catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('AUTH_CREDENTIAL_UNREADABLE')
    expect(err.message).not.toContain('secret-clear-text')
    expect(err.message).not.toContain('bad key')
  })

  it('resolveLoginCredential 在密文缺失/非 local/decrypt 抛错时抛出 AUTH_CREDENTIAL_UNREADABLE', async () => {
    vi.mocked(resolveSnapshotCredential).mockResolvedValue({
      username: 'frozen-user',
      secretId: 'sec-run',
      provider: 'local',
      credentialId: 'c1',
      versionId: 'v1',
      identityRevision: 1,
    })
    vi.mocked(loadSecretCiphertext).mockResolvedValue({
      id: 'sec-run',
      provider: 'local',
      ciphertext: Buffer.from('cipher'),
    })
    const ctx = {
      secrets: {
        decrypt: () => {
          throw new Error('decrypt key invalid')
        },
      },
      dbHandle: {},
    }
    const err = await resolveLoginCredential
      .call(ctx as never, { secretRef: { provider: 'local', secretId: 'sec-run' } } as never)
      .catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('AUTH_CREDENTIAL_UNREADABLE')
    expect(err.message).not.toContain('decrypt key invalid')
  })
})
