import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { LOCAL_SECRET_PROVIDER } from '@cairn/shared'
import { DRIVERS, type ContractDriver, openContractDb } from './contract-fixture.js'
import { newId } from '../id.js'
import * as api from '../index.js'
import { expose, connection } from '../database.js'
import { schemaFor } from '../native.js'
import type { DbHandle } from '../client.js'

describe.each(DRIVERS)('%s 凭据目录', (driver: ContractDriver) => {
  const handles: DbHandle[] = []
  afterEach(async () => {
    for (const handle of handles.splice(0).reverse()) await handle.close()
  })

  async function setup() {
    const handle = await openContractDb(driver)
    handles.push(handle)
    const db = expose(handle)
    const rbac = new api.RbacStore(db, {
      hash: async (value) => value,
      verify: async (value, hashed) => value === hashed,
    })
    const admin = (await rbac.listRoles()).items.find((role) => role.key === 'admin')!
    const actor = await rbac.createAccount(
      {
        email: `cred_${newId()}@test.com`,
        displayName: '凭据管理员',
        password: 'Password123!',
        roleIds: [admin.id],
      },
      null,
    )
    const targets = new api.TargetsStore(db, (_id, password) => Buffer.from(password))
    const target = await targets.createTarget(
      {
        loginFields: null,
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        name: '凭据目标',
        code: `C_${newId().slice(0, 8)}`,
        entryUrl: 'https://example.com/app',
      },
      actor,
    )
    return { handle, db, actor, targets, target }
  }

  it('创建带密码账号会登记目录，替换保留旧密文，到期不改账号状态', async () => {
    const { db, actor, targets, target } = await setup()
    const startedAt = '2026-01-01T00:00:00.000Z'
    const account = await targets.createAccount(
      target.id,
      {
        displayName: '甲',
        username: 'alice',
        password: 'first-secret',
        status: 'active',
        usage: 'business',
        validity: { mode: 'days', amount: 30, timeZone: 'UTC', startedAt },
      },
      actor,
    )
    expect(account.credentialId).toBe(account.id)
    expect(account.maintenanceStatus).toBe('due')
    expect(account.status).toBe('active')

    const native = connection(db)
    const { secrets, targetAccounts, credentialVersions } = schemaFor(native)
    const [before] = await native.select().from(targetAccounts).where(eq(targetAccounts.id, account.id))
    const firstSecretId = before!.secretId!

    await targets.updateAccount(
      target.id,
      account.id,
      {
        password: 'second-secret',
        validity: { mode: 'days', amount: 90, timeZone: 'UTC', startedAt },
        expectedRevision: account.credentialRevision,
      },
      actor,
    )
    const leftover = await native.select().from(secrets).where(eq(secrets.id, firstSecretId))
    expect(leftover).toHaveLength(1)
    const versions = await native.select().from(credentialVersions).where(eq(credentialVersions.credentialId, account.id))
    expect(versions.some((row) => row.secretId === firstSecretId && row.materialStatus === 'superseded')).toBe(true)
    expect(versions.some((row) => row.materialStatus === 'current')).toBe(true)

    const listed = await api.listCredentials(db, {}, actor)
    expect(listed.items.some((item) => item.id === account.id && item.type === 'target_password')).toBe(true)
    const latest = await api.getCredential(db, account.id, actor)
    const paused = await api.setCredentialEnabled(db, account.id, { expectedRevision: latest.revision }, false, actor)
    expect(paused.managementStatus).toBe('disabled')
    const again = await targets.getAccount(target.id, account.id)
    expect(again.status).toBe('active')
    expect(await api.resolveAccountCurrentCredential(db, account.id)).toBeNull()
  })

  it('只改登录名进入待确认，当前取用被挡住；确认后恢复', async () => {
    const { db, actor, targets, target } = await setup()
    const account = await targets.createAccount(
      target.id,
      {
        displayName: '乙',
        username: 'bob',
        password: 'keep-secret',
        status: 'active',
        usage: 'business',
        validity: { mode: 'permanent' },
      },
      actor,
    )
    await targets.updateAccount(target.id, account.id, { username: 'bob2' }, actor)
    expect(await api.resolveAccountCurrentCredential(db, account.id)).toBeNull()
    const view = await targets.getAccount(target.id, account.id)
    expect(view.identityBindingStatus).toBe('pending_reconfirm')
    await targets.updateAccount(
      target.id,
      account.id,
      { username: 'bob2', confirmIdentityMaterial: true, expectedRevision: view.credentialRevision },
      actor,
    )
    const granted = await api.resolveAccountCurrentCredential(db, account.id)
    expect(granted?.username).toBe('bob2')
  })

  it('凭据中心更新复用目标账号及同一秘密引用，不复制账号或密码材料', async () => {
    const { db, actor, targets, target } = await setup()
    const account = await targets.createAccount(target.id, {
      displayName: '同源账号', username: 'shared-account', password: 'before', status: 'active',
      usage: 'business',
      validity: { mode: 'permanent' },
    }, actor)
    const current = await api.getCredential(db, account.id, actor)
    const secretId = newId()
    await api.registerStandaloneSecret(db, { id: secretId, ciphertext: Buffer.from('after') })
    const updated = await api.replaceCredentialMaterial(db, account.id, {
      expectedRevision: current.revision, password: 'after', validity: { mode: 'permanent' },
    }, actor, { id: secretId, provider: LOCAL_SECRET_PROVIDER })

    const native = connection(db)
    const tables = schemaFor(native)
    const [storedAccount] = await native.select().from(tables.targetAccounts).where(eq(tables.targetAccounts.id, account.id))
    const sourceView = await targets.getAccount(target.id, account.id)
    expect(updated.id).toBe(account.id)
    expect(updated.targetAccountId).toBe(account.id)
    expect(updated.currentVersionId).toBe(secretId)
    expect(storedAccount!.secretId).toBe(secretId)
    expect(sourceView.credentialId).toBe(updated.id)
    expect(sourceView.credentialRevision).toBe(updated.revision)
    expect((await targets.listAccounts(target.id, {})).items).toHaveLength(1)
    expect((await api.listCredentials(db, { targetId: target.id }, actor)).items).toHaveLength(1)
    expect(await native.select().from(tables.secrets).where(eq(tables.secrets.id, secretId))).toHaveLength(1)
  })

  it.each(['account_deleted', 'target_deleted', 'account_missing', 'binding_mismatch'] as const)(
    '%s 的登记不再作为可维护目标凭据展示',
    async (state) => {
      const { db, actor, targets, target } = await setup()
      const account = await targets.createAccount(target.id, {
        displayName: '历史登记', username: 'former-account', status: 'active',
        usage: 'business',
      }, actor)
      const native = connection(db)
      const tables = schemaFor(native)
      if (state === 'account_deleted') {
        await targets.deleteAccount(target.id, account.id, actor)
      } else if (state === 'target_deleted') {
        await targets.deleteTarget(target.id, actor)
      } else if (state === 'account_missing') {
        await native.delete(tables.targetAccounts).where(eq(tables.targetAccounts.id, account.id))
      } else {
        await native.update(tables.credentialBindings).set({ targetId: newId() }).where(eq(tables.credentialBindings.credentialId, account.id))
      }
      const listed = await api.listCredentials(db, {}, actor)
      expect(listed.items).toHaveLength(0)
      expect(listed.stats.visible).toBe(0)
      await expect(api.getCredential(db, account.id, actor)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' })
      await expect(api.replaceCredentialMaterial(db, account.id, {
        expectedRevision: 1, password: 'must-not-save', validity: { mode: 'permanent' },
      }, actor)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' })
    },
  )

  it('旧版本被撤销后不能再取用', async () => {
    const { db, actor, targets, target } = await setup()
    const account = await targets.createAccount(
      target.id,
      {
        displayName: '丙',
        username: 'carol',
        password: 'old-secret',
        status: 'active',
        usage: 'business',
        validity: { mode: 'permanent' },
      },
      actor,
    )
    const latest = await api.getCredential(db, account.id, actor)
    const granted = await api.resolveAccountCurrentCredential(db, account.id)
    expect(granted?.secretId).toBeTruthy()
    await api.revokeCredentialVersion(
      db,
      account.id,
      latest.currentVersionId!,
      { expectedRevision: latest.revision },
      actor,
    )
    await expect(api.authorizeSecretConsume(db, { secretId: granted!.secretId })).rejects.toMatchObject({
      code: 'CREDENTIAL_VERSION_REVOKED',
    })
  })

  it('改登录名后旧版本仍可按冻结登录名取用，当前取用被挡住', async () => {
    const { db, actor, targets, target } = await setup()
    const account = await targets.createAccount(
      target.id,
      {
        displayName: '丁',
        username: 'dave',
        password: 'frozen-secret',
        status: 'active',
        usage: 'business',
        validity: { mode: 'permanent' },
      },
      actor,
    )
    const frozen = await api.resolveAccountCurrentCredential(db, account.id)
    expect(frozen?.username).toBe('dave')
    await targets.updateAccount(target.id, account.id, { username: 'dave2' }, actor)
    await expect(
      api.authorizeSecretConsume(db, { secretId: frozen!.secretId, expectedUsername: 'dave' }),
    ).resolves.toMatchObject({ username: 'dave', secretId: frozen!.secretId })
    expect(await api.resolveAccountCurrentCredential(db, account.id)).toBeNull()
  })

  it('维护期限扫描会打开提醒，改期限后关闭旧提醒', async () => {
    const { db, actor, targets, target } = await setup()
    const startedAt = '2026-01-01T00:00:00.000Z'
    const account = await targets.createAccount(
      target.id,
      {
        displayName: '戊',
        username: 'erin',
        password: 'due-secret',
        status: 'active',
        usage: 'business',
        validity: { mode: 'days', amount: 1, timeZone: 'UTC', startedAt },
      },
      actor,
    )
    const first = await api.scanCredentialReminders(db)
    expect(first.opened).toBeGreaterThan(0)
    const open = await api.listOpenCredentialReminders(db)
    expect(open.some((row) => row.reminder.credentialId === account.id && row.reminder.stage === 'due')).toBe(true)

    const latest = await api.getCredential(db, account.id, actor)
    await api.updateCredentialMetadata(
      db,
      account.id,
      { expectedRevision: latest.revision, validity: { mode: 'permanent' } },
      actor,
    )
    const closed = await api.listOpenCredentialReminders(db)
    expect(closed.some((row) => row.reminder.credentialId === account.id && row.reminder.status === 'open')).toBe(false)
  })

  it('元数据批次幂等，密码批次须提交密文引用', async () => {
    const { db, actor, targets, target } = await setup()
    const account = await targets.createAccount(
      target.id,
      {
        displayName: '己',
        username: 'fay',
        password: 'batch-secret',
        status: 'active',
        usage: 'business',
      },
      actor,
    )
    const latest = await api.getCredential(db, account.id, actor)
    const itemId = newId()
    const first = await api.createCredentialBatch(
      db,
      {
        kind: 'metadata',
        idempotencyKey: 'cred-batch-meta-01',
        items: [
          {
            itemId,
            credentialId: account.id,
            expectedRevision: latest.revision,
            validity: { mode: 'permanent' },
          },
        ],
      },
      actor,
    )
    const again = await api.createCredentialBatch(
      db,
      {
        kind: 'metadata',
        idempotencyKey: 'cred-batch-meta-01',
        items: [
          {
            itemId,
            credentialId: account.id,
            expectedRevision: latest.revision,
            validity: { mode: 'permanent' },
          },
        ],
      },
      actor,
    )
    expect(again.batchId).toBe(first.batchId)
    expect(first.items[0]?.status).toBe('succeeded')
    const afterMeta = await api.getCredential(db, account.id, actor)
    expect(afterMeta.validityPolicy.mode).toBe('permanent')

    const passwordItem = newId()
    const passwordBatch = await api.createCredentialBatch(
      db,
      {
        kind: 'password_replace',
        idempotencyKey: 'cred-batch-pw-01',
        items: [
          {
            itemId: passwordItem,
            credentialId: account.id,
            targetAccountId: account.id,
            expectedRevision: afterMeta.revision,
          },
        ],
      },
      actor,
    )
    expect(passwordBatch.items[0]?.status).toBe('pending_material')
    await expect(api.submitCredentialBatchItem(
      db,
      passwordBatch.batchId,
      passwordItem,
      {
        idempotencyKey: passwordItem,
        password: 'next-batch-secret',
        validity: { mode: 'days', amount: 30, timeZone: 'UTC' },
      },
      actor,
    )).rejects.toMatchObject({ code: 'CREDENTIAL_MATERIAL_UNAVAILABLE' })

    const sealedId = newId()
    const native = connection(db)
    const { secrets } = schemaFor(native)
    await native.insert(secrets).values({
      id: sealedId,
      provider: 'local',
      ciphertext: Buffer.from('sealed-batch'),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const sealed = await api.submitSealedBatchPassword(db, {
      batchId: passwordBatch.batchId,
      itemId: passwordItem,
      idempotencyKey: passwordItem,
      requestDigest: 'protected-test-digest',
      sealed: { id: sealedId, provider: 'local' },
      validity: { mode: 'days', amount: 30, timeZone: 'UTC' },
      actor,
    })
    expect(sealed.items[0]?.status).toBe('succeeded')
    const current = await api.resolveAccountCurrentCredential(db, account.id)
    expect(current?.secretId).toBe(sealedId)
  })

  it('模型、Webhook 与服务密钥保留原领域数据，但凭据菜单不可见或操作', async () => {
    const { db, actor } = await setup()
    const channelId = newId()
    const firstSecret = newId()
    const secondSecret = newId()
    await api.replaceAlertWebhookSecret(db, {
      channelId,
      channelName: '值班群',
      sealed: { id: firstSecret, provider: 'local' },
      actor,
    })
    await api.replaceAlertWebhookSecret(db, {
      channelId,
      channelName: '值班群',
      sealed: { id: secondSecret, provider: 'local' },
      actor,
    })
    await expect(api.getCredential(db, channelId, actor)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' })
    const native = connection(db)
    const { credentialVersions } = schemaFor(native)
    const versions = await native.select().from(credentialVersions)
    expect(versions.some((row) => row.secretId === firstSecret && row.materialStatus === 'superseded')).toBe(true)

    const serviceId = newId()
    await api.syncServiceKeyProjection(db, {
      credentialId: serviceId,
      name: '开放调用方',
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
      actor,
    })
    await expect(api.getCredential(db, serviceId, actor)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' })
    expect((await api.listCredentials(db, {}, actor)).items).toEqual([])
  })
}, 30_000)
