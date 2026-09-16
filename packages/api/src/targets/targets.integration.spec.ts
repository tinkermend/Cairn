import { postgresEnvSchema as dbEnvSchema } from '@cairn/db/testing'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ConflictException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, eq, secrets, sql, targetAccounts, type DbHandle } from '@cairn/db/testing'
import { DEV_CREDENTIAL_KEY } from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { TargetsService } from './targets.service'

// api 的 tsconfig 带 types:["node"]，CJS 程序不允许 import.meta；vitest 运行时提供 __dirname
const envFile = resolve(__dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const parsed = dbEnvSchema.safeParse(process.env)

const prefix = `itest-${Date.now().toString(36)}`

describe.skipIf(!parsed.success)('TargetsService（集成，需真实 PostgreSQL）', () => {
  let handle: DbHandle
  let service: TargetsService
  let actor: RequestAccount

  beforeAll(async () => {
    handle = createDb(parsed.data!)
    const { rows } = await handle.pool.query<{ id: string; display_name: string; email: string | null }>(
      `SELECT id, display_name, email FROM ${parsed.data!.CAIRN_DB_SCHEMA}.console_accounts LIMIT 1`,
    )
    const row = rows[0]
    if (!row) throw new Error('集成测试需要至少一条 console_accounts')
    actor = {
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      status: 'active',
      roles: [],
      permissions: ['target:write', 'target:delete', 'target:read'],
    }
    service = new TargetsService(handle, new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)))
  })

  afterAll(async () => {
    if (handle) {
      const schema = parsed.data!.CAIRN_DB_SCHEMA
      const { rows: secretRows } = await handle.pool.query<{ secret_id: string | null }>(
        `SELECT secret_id FROM ${schema}.target_accounts
         WHERE target_id IN (SELECT id FROM ${schema}.targets WHERE code LIKE $1)`,
        [`${prefix}%`],
      )
      await handle.pool.query(
        `DELETE FROM ${schema}.target_account_auth_budget
         WHERE target_account_id IN (
           SELECT id FROM ${schema}.target_accounts
           WHERE target_id IN (SELECT id FROM ${schema}.targets WHERE code LIKE $1)
         )`,
        [`${prefix}%`],
      )
      await handle.pool.query(
        `DELETE FROM ${schema}.target_accounts
         WHERE target_id IN (SELECT id FROM ${schema}.targets WHERE code LIKE $1)`,
        [`${prefix}%`],
      )
      const secretIds = secretRows.map((row) => row.secret_id).filter((id): id is string => !!id)
      if (secretIds.length > 0) {
        await handle.pool.query(`DELETE FROM ${schema}.secrets WHERE id = ANY($1::uuid[])`, [secretIds])
      }
      await handle.pool.query(`DELETE FROM ${schema}.targets WHERE code LIKE $1`, [`${prefix}%`])
      await handle.close()
    }
  })

  it('重复 code 返回 TARGET_CODE_CONFLICT，不是 500', async () => {
    const created = await service.createTarget(
      {
        code: `${prefix}-dup`,
        name: '甲',
        entryUrl: 'https://a.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    try {
      await service.createTarget(
        {
          code: `${prefix}-dup`,
          name: '乙',
          entryUrl: 'https://b.example',
          authMethod: 'password',
          captchaMode: 'none',
          status: 'active',
          loginFields: null,
        },
        actor,
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'TARGET_CODE_CONFLICT' })
    }
    expect(created.code).toBe(`${prefix}-dup`)
  })

  it('同系统同名账号并发写入映射为 TARGET_ACCOUNT_CONFLICT', async () => {
    const target = await service.createTarget(
      {
        code: `${prefix}-acc`,
        name: '账号冲突',
        entryUrl: 'https://c.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    const body = {
      displayName: '运维',
      username: 'ops',
      status: 'active' as const,
    }
    const results = await Promise.allSettled([
      service.createAccount(target.id, body, actor),
      service.createAccount(target.id, body, actor),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ConflictException)
      expect((rejected[0].reason as ConflictException).getResponse()).toMatchObject({
        code: 'TARGET_ACCOUNT_CONFLICT',
      })
    }
  })

  it('轮换密码删除旧 secrets 行；clearPassword 后无密文', async () => {
    const target = await service.createTarget(
      {
        code: `${prefix}-sec`,
        name: '凭据',
        entryUrl: 'https://s.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    const created = await service.createAccount(
      target.id,
      { displayName: '甲', username: 'alice', password: 'first-secret', status: 'active' },
      actor,
    )
    expect(created.hasPassword).toBe(true)
    expect(JSON.stringify(created)).not.toContain('first-secret')

    const [beforeRotate] = await handle.db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, created.id))
    const firstSecretId = beforeRotate?.secretId
    expect(firstSecretId).toBeTruthy()

    await service.updateAccount(
      target.id,
      created.id,
      { password: 'second-secret' },
      actor,
    )
    const rotated = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(secrets)
      .innerJoin(targetAccounts, eq(targetAccounts.secretId, secrets.id))
      .where(eq(targetAccounts.id, created.id))
    expect(Number(rotated[0]?.n ?? 0)).toBe(1)
    const leftover = await handle.db.select().from(secrets).where(eq(secrets.id, firstSecretId!))
    expect(leftover).toHaveLength(0)

    const cleared = await service.updateAccount(target.id, created.id, { clearPassword: true }, actor)
    expect(cleared.hasPassword).toBe(false)
    const cleared_ = await handle.db
      .select({ n: sql<number>`count(*)::int` })
      .from(secrets)
      .innerJoin(targetAccounts, eq(targetAccounts.secretId, secrets.id))
      .where(eq(targetAccounts.id, created.id))
    expect(Number(cleared_[0]?.n ?? 0)).toBe(0)
  })

  it('删光账号后再删系统，对应 secret 不残留', async () => {
    const target = await service.createTarget(
      {
        code: `${prefix}-gone`,
        name: '清干净',
        entryUrl: 'https://g.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    const created = await service.createAccount(
      target.id,
      { displayName: '丙', username: 'carol', password: 'temp-secret', status: 'active' },
      actor,
    )
    const [row] = await handle.db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, created.id))
    const secretId = row?.secretId
    expect(secretId).toBeTruthy()

    await service.deleteAccount(target.id, created.id, actor)
    await service.deleteTarget(target.id, actor)

    const leftover = await handle.db.select().from(secrets).where(eq(secrets.id, secretId!))
    expect(leftover).toHaveLength(0)
  })

  it('OCC 预期不一致时删除系统失败；审计与成功写入同行', async () => {
    const target = await service.createTarget(
      {
        code: `${prefix}-del`,
        name: '删除',
        entryUrl: 'https://d.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    await service.createAccount(
      target.id,
      { displayName: '乙', username: 'bob', status: 'active' },
      actor,
    )
    try {
      await service.deleteTarget(target.id, actor, { expectedCounts: { targetAccounts: 0 } })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException)
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'DELETE_SCOPE_EXPANDED' })
    }
    const { rows: audits } = await handle.pool.query<{ action: string }>(
      `SELECT action FROM ${parsed.data!.CAIRN_DB_SCHEMA}.console_audit_events
       WHERE resource_id = $1 ORDER BY created_at`,
      [target.id],
    )
    expect(audits.map((r) => r.action)).toContain('target.create')
    expect(audits.map((r) => r.action)).not.toContain('target.delete')
  })

  it('创建可带首个账号与定位；响应与审计无明文口令', async () => {
    const created = await service.createTarget(
      {
        code: `${prefix}-bundle`,
        name: '带账号',
        entryUrl: 'https://bundle.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: { username: { by: 'id', value: 'username' } },
        account: { displayName: '演示', username: 'demo', password: 'bundle-secret', status: 'active' },
      },
      actor,
    )
    expect(created.accountCount).toBe(1)
    expect(created.loginFields).toEqual({ username: { by: 'id', value: 'username' } })
    expect(created).not.toHaveProperty('password')
    expect(JSON.stringify(created)).not.toContain('bundle-secret')

    const accounts = await service.listAccounts(created.id)
    expect(accounts.items).toHaveLength(1)
    expect(accounts.items[0]?.hasPassword).toBe(true)
    expect(accounts.items[0]).not.toHaveProperty('password')
    expect(JSON.stringify(accounts)).not.toContain('bundle-secret')

    const { rows: audits } = await handle.pool.query<{ action: string; summary: string }>(
      `SELECT action, summary FROM ${parsed.data!.CAIRN_DB_SCHEMA}.console_audit_events
       WHERE resource_id IN ($1, $2) ORDER BY created_at`,
      [created.id, accounts.items[0]!.id],
    )
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining(['target.create', 'target_account.create', 'target_account.password']),
    )
    expect(JSON.stringify(audits)).not.toContain('bundle-secret')
  })

  it('loginFields 往返；只改定位时审计不写选择器', async () => {
    const created = await service.createTarget(
      {
        code: `${prefix}-loc`,
        name: '定位',
        entryUrl: 'https://loc.example',
        authMethod: 'password',
        captchaMode: 'none',
        status: 'active',
        loginFields: null,
      },
      actor,
    )
    expect(created.loginFields).toBeNull()

    const updated = await service.updateTarget(
      created.id,
      { loginFields: { password: { by: 'name', value: 'password' } } },
      actor,
    )
    expect(updated.loginFields).toEqual({ password: { by: 'name', value: 'password' } })

    const { rows: audits } = await handle.pool.query<{ summary: string }>(
      `SELECT summary FROM ${parsed.data!.CAIRN_DB_SCHEMA}.console_audit_events
       WHERE resource_id = $1 AND action = 'target.update'`,
      [created.id],
    )
    expect(audits.map((row) => row.summary)).toContain('更新了登录框定位')
    expect(JSON.stringify(audits)).not.toContain('password')
  })
})
