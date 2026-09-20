import { describe, expect, it, vi } from 'vitest'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    resolveSnapshotCredential: vi.fn(),
    resolveAccountCurrentCredential: vi.fn(),
    loadSecretCiphertext: vi.fn(),
    recordCredentialVerification: vi.fn(),
    loadAccountForExecution: vi.fn(),
  }
})

import {
  loadSecretCiphertext,
  resolveAccountCurrentCredential,
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
    vi.mocked(resolveAccountCurrentCredential).mockResolvedValue(null)
    const ctx = { secrets: { decrypt: () => 'pw' }, dbHandle: {} }
    await expect(resolveAccountCredential.call(ctx as never, 'account-1')).resolves.toBeNull()
  })
})
