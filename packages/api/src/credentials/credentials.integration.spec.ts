import { randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { RbacStore } from '@cairn/db'
import { openIsolatedDb, eq, secrets, targetAccounts, type DbHandle } from '@cairn/db/testing'
import { DEV_CREDENTIAL_KEY } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { TargetsService } from '../targets/targets.service'
import type { RequestAccount } from '../common/request-account'
import { CredentialsService } from './credentials.service'

describe('凭据服务：真实加密与隔离数据库', () => {
  let handle: DbHandle; let service: CredentialsService; let targets: TargetsService; let actor: RequestAccount; let provider: LocalSecretProvider
  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_credentials_${randomUUID().replaceAll('-', '')}`)
    const rbac = new RbacStore(handle, { hash: async s => s, verify: async (s, h) => s === h })
    const role = (await rbac.listRoles()).items.find(r => r.key === 'admin')!
    actor = await rbac.createAccount({ email: 'credential-test', displayName: '凭据集成测试', password: 'fixture-password', roleIds: [role.id] }, null)
    provider = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    service = new CredentialsService(handle, provider); targets = new TargetsService(handle, provider)
  })
  afterAll(async () => { await handle?.close() })
  it('Excel 匹配不写入；保存原样密码；重试幂等；冲突回执不增加秘密行', async () => {
    const target = await targets.createTarget({ code: 'credential-integration', name: '凭据联调', entryUrl: 'https://example.com', authMethod: 'password', captchaMode: 'none', status: 'active', loginFields: null }, actor)
    const account = await targets.createAccount(target.id, { displayName: '零开头账号', username: '000001', password: 'old-fixture', usage: 'business', status: 'active', validity: { mode: 'permanent' } }, actor)
    const before = await handle.db.select().from(secrets)
    const matched = await service.resolve({ version: 1, rows: [{ row: 2, targetCode: target.code, username: '000001' }] }, actor)
    const item = matched.rows[0]!.item!
    expect(await handle.db.select().from(secrets)).toHaveLength(before.length)
    const itemId = randomUUID()
    const batch = await service.createBatch({ kind: 'password_replace', source: 'excel', idempotencyKey: randomUUID(), items: [{ itemId, credentialId: item.id, targetId: target.id, targetAccountId: account.id, expectedRevision: item.revision }] }, actor)
    const body = { password: '  fixture-密码🔑  ', validity: { mode: 'permanent' as const }, idempotencyKey: itemId }
    const [first, again] = await Promise.all([service.submitBatchItem(batch.batchId, itemId, body, actor), service.submitBatchItem(batch.batchId, itemId, body, actor)])
    expect(first.items[0]?.status).toBe('succeeded'); expect(again.items[0]?.status).toBe('succeeded')
    const [stored] = await handle.db.select({ id: secrets.id, ciphertext: secrets.ciphertext }).from(secrets).innerJoin(targetAccounts, eq(targetAccounts.secretId, secrets.id)).where(eq(targetAccounts.id, account.id))
    expect(provider.decrypt(stored!.id, stored!.ciphertext)).toBe(body.password)
    expect(await handle.db.select().from(secrets)).toHaveLength(before.length + 1)
    expect(JSON.stringify(first)).not.toContain(body.password)
    const conflictId = randomUUID()
    const conflictBatch = await service.createBatch({ kind: 'password_replace', source: 'excel', idempotencyKey: randomUUID(), items: [{ itemId: conflictId, credentialId: item.id, expectedRevision: item.revision }] }, actor)
    const conflict = await service.submitBatchItem(conflictBatch.batchId, conflictId, { ...body, idempotencyKey: conflictId }, actor)
    expect(conflict.items[0]?.status).toBe('conflict')
    expect(await handle.db.select().from(secrets)).toHaveLength(before.length + 1)
    expect((await targets.listAccounts(target.id, {})).items[0]?.credentialRevision).toBe(first.items[0]?.resultRevision)
  })
})
