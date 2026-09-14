import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createAccountBodySchema, operationAuditQuerySchema, loginAuditQuerySchema } from '@cairn/shared'
import * as api from '../index.js'
import { expose, connection } from '../database.js'
import { type DbHandle } from '../client.js'
import { recordLoginAudit, recordAudit } from '../audit/record.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'

const passwordAdapter = {
  hash: async (s: string) => createHash('sha256').update(s).digest('hex'),
  verify: async (s: string, h: string) => createHash('sha256').update(s).digest('hex') === h,
}

const handles: DbHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.close()
})

async function fixture(driver: (typeof DRIVERS)[number]) {
  const h = await openContractDb(driver)
  handles.push(h)
  const db = expose(h)
  const rbac = new api.RbacStore(db, passwordAdapter)
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: 'audit-admin',
      displayName: '审计管理员',
      password: 'secret-password',
    }),
    null,
  )
  return { db, rbac, actor, native: connection(db) }
}

describe.each(DRIVERS)('控制台审计拆分 (%s)', (driver) => {
  it('新建账号不传角色时绑定编写者', async () => {
    const f = await fixture(driver)
    expect(f.actor.roles.map((role) => role.key)).toEqual(['author'])
  })

  it('登录成功与失败分列，操作列表不含登录行', async () => {
    const f = await fixture(driver)
    await f.rbac.completeSuccessfulLogin({
      identityId: (await api.findLocalIdentity(f.db, 'audit-admin'))!.id,
      accountId: f.actor.id,
      identifier: 'Audit-Admin',
      client: { ip: '10.0.0.8', userAgent: 'vitest', kind: 'web' },
    })
    await f.rbac.recordLoginFailure({
      identifier: 'ghost',
      reason: 'unknown_account',
      client: { ip: '10.0.0.9', kind: 'web' },
    })
    await f.rbac.recordLoginFailure({
      identifier: 'audit-admin',
      reason: 'invalid_password',
      accountId: f.actor.id,
      client: { ip: '10.0.0.10', kind: 'extension' },
    })

    const operations = await f.rbac.listAuditEvents(operationAuditQuerySchema.parse({ limit: 50 }))
    expect(operations.items.every((row) => row.action !== 'auth.login')).toBe(true)
    expect(operations.items.some((row) => row.action === 'account.create')).toBe(true)

    const logins = await f.rbac.listLoginAuditEvents(loginAuditQuerySchema.parse({ limit: 50 }))
    expect(logins.items).toHaveLength(3)
    expect(logins.items.map((row) => row.outcome)).toEqual(['failure', 'failure', 'success'])
    expect(logins.items[2]).toMatchObject({
      loginIdentifier: 'audit-admin',
      outcome: 'success',
      clientIp: '10.0.0.8',
      clientKind: 'web',
    })
    expect(logins.items[1]).toMatchObject({
      loginIdentifier: 'ghost',
      outcome: 'failure',
      failureReason: 'unknown_account',
      actor: null,
    })
    expect(JSON.stringify(logins)).not.toContain('secret-password')
  })

  it('超过一页时给出 nextCursor，回传可取下一页', async () => {
    const f = await fixture(driver)
    const identity = (await api.findLocalIdentity(f.db, 'audit-admin'))!
    for (let i = 0; i < 3; i += 1) {
      await f.rbac.completeSuccessfulLogin({
        identityId: identity.id,
        accountId: f.actor.id,
        identifier: 'audit-admin',
        client: { ip: `10.0.0.${i + 1}`, kind: 'web' },
      })
    }
    const first = await f.rbac.listLoginAuditEvents(loginAuditQuerySchema.parse({ limit: 2 }))
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await f.rbac.listLoginAuditEvents(
      loginAuditQuerySchema.parse({ limit: 2, cursor: first.nextCursor }),
    )
    expect(second.items).toHaveLength(1)
    expect(first.items.map((row) => row.id)).not.toContain(second.items[0]!.id)
  })

  it('写路径拒绝把登录动作写进操作审计', async () => {
    const f = await fixture(driver)
    await expect(
      recordAudit(f.native, { id: f.actor.id }, 'auth.login', 'auth', f.actor.id, '登录成功'),
    ).rejects.toThrow(/recordLoginAudit/)
    await expect(
      recordLoginAudit(f.native, {
        identifier: 'ghost',
        outcome: 'failure',
        failureReason: 'unknown_account',
        accountId: f.actor.id,
      }),
    ).rejects.toThrow(/未知账号/)
  })

  it('登录行 category 为 login，操作行保持 operation', async () => {
    const f = await fixture(driver)
    await f.rbac.recordLoginFailure({
      identifier: 'nobody',
      reason: 'unknown_account',
      client: { kind: 'web' },
    })
    const { consoleAuditEvents } = schemaFor(f.native)
    const rows = await f.native.select().from(consoleAuditEvents)
    expect(rows.filter((row) => row.action === 'account.create').every((row) => row.category === 'operation')).toBe(
      true,
    )
    expect(rows.filter((row) => row.action === 'auth.login').every((row) => row.category === 'login')).toBe(true)
    expect(rows.some((row) => row.action === 'auth.login' && row.loginIdentifier === 'nobody')).toBe(true)
  })
})
