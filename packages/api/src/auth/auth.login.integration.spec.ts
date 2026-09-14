import { postgresEnvSchema as dbEnvSchema } from '@cairn/db/testing'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type DbHandle } from '@cairn/db/testing'
import { loginAuditQuerySchema } from '@cairn/shared'
import { RbacStore } from '@cairn/db'
import { AuthService } from './auth.service'
import { RbacService } from '../rbac/rbac.service'
import { hashSecret, verifySecret } from './password'

const envFile = resolve(__dirname, '../../../../.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const parsed = dbEnvSchema.safeParse(process.env)
const prefix = `login-${Date.now().toString(36)}`

describe.skipIf(!parsed.success)('AuthService 登录审计（集成）', () => {
  let handle: DbHandle
  let auth: AuthService
  let rbac: RbacService
  let store: RbacStore
  let accountId: string
  const login = `${prefix}-user`
  const password = 'secret-password'

  beforeAll(async () => {
    handle = createDb(parsed.data!)
    store = new RbacStore(handle, { hash: hashSecret, verify: verifySecret })
    rbac = new RbacService(handle)
    auth = new AuthService(handle, { signAsync: async () => 'jwt-token' } as never, rbac)
    const account = await store.createAccount(
      { email: login, displayName: '登录审计', password },
      null,
    )
    accountId = account.id
  })

  afterAll(async () => {
    if (handle) {
      const schema = parsed.data!.CAIRN_DB_SCHEMA
      await handle.pool.query(`DELETE FROM ${schema}.console_audit_events WHERE login_identifier = $1`, [
        login,
      ])
      await handle.pool.query(`DELETE FROM ${schema}.console_audit_events WHERE login_identifier = $1`, [
        `${prefix}-ghost`,
      ])
      try {
        await store.deleteAccount(accountId, null)
      } catch {
        // 清理失败不挡测试收尾
      }
      await handle.close()
    }
  })

  it('成功登录写 login/success，响应不含口令', async () => {
    const result = await auth.login(login, password, {
      ip: '203.0.113.10',
      userAgent: 'vitest',
      kind: 'extension',
    })
    expect(result.accessToken).toBe('jwt-token')
    expect(JSON.stringify(result)).not.toContain(password)
    const logins = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: login, outcome: 'success' }),
    )
    expect(logins.items[0]).toMatchObject({
      loginIdentifier: login,
      outcome: 'success',
      clientIp: '203.0.113.10',
      clientKind: 'extension',
    })
    expect(JSON.stringify(logins)).not.toContain(password)
  })

  it('错误密码与未知账号保持 401 文案，对内原因分开', async () => {
    await expect(auth.login(login, 'wrong-password', { kind: 'web' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    await expect(auth.login(`${prefix}-ghost`, 'wrong-password', { kind: 'web' })).rejects.toBeInstanceOf(
      UnauthorizedException,
    )
    const failed = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: login, outcome: 'failure' }),
    )
    expect(failed.items.some((row) => row.failureReason === 'invalid_password' && row.actor?.id === accountId)).toBe(
      true,
    )
    const ghost = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: `${prefix}-ghost` }),
    )
    expect(ghost.items[0]).toMatchObject({
      failureReason: 'unknown_account',
      actor: null,
    })
  })

  it('停用账号且密码正确：403，failure_reason=account_disabled', async () => {
    await store.updateAccount(accountId, { status: 'disabled' }, null)
    await expect(auth.login(login, password, { kind: 'web' })).rejects.toBeInstanceOf(ForbiddenException)
    const failed = await store.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ identifier: login, outcome: 'failure' }),
    )
    expect(failed.items.some((row) => row.failureReason === 'account_disabled')).toBe(true)
  })
})
