import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createAccountBodySchema } from '@cairn/shared'
import * as api from '../index.js'
import { connection, expose } from '../database.js'
import { schemaFor } from '../native.js'
import type { DbHandle } from '../client.js'
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
      email: 'shape-admin',
      displayName: '形状用例',
      password: 'secret-password',
    }),
    null,
  )
  return { h, db, rbac, actor, native: connection(db) }
}

/**
 * 登录审计的形状约束在三库必须给出同一个结论。
 *
 * MySQL 禁止 CHECK 引用带 referential action 的外键列（8.4 报 3823），
 * 而 `actor_console_account_id` 是 `ON DELETE SET NULL` 的外键列，所以数据库层
 * 的形状只能落在 `resource_id` 上。actor 与 resource_id 的对应关系改由写路径
 * 保证，这里把它当成跨库业务断言钉住，而不是靠读代码相信。
 */
describe.each(DRIVERS)('登录审计形状 (%s)', (driver) => {
  it('写入时 actor 与 resource_id 一致，成功必有账号、未知账号必无', async () => {
    const f = await fixture(driver)
    const identity = (await api.findLocalIdentity(f.db, 'shape-admin'))!
    await f.rbac.completeSuccessfulLogin({
      identityId: identity.id,
      accountId: f.actor.id,
      identifier: 'shape-admin',
      client: { kind: 'web' },
    })
    await f.rbac.recordLoginFailure({
      identifier: 'ghost',
      reason: 'unknown_account',
      client: { kind: 'web' },
    })
    await f.rbac.recordLoginFailure({
      identifier: 'shape-admin',
      reason: 'invalid_password',
      accountId: f.actor.id,
      client: { kind: 'web' },
    })

    const rows = (await f.native.select().from(schemaFor(f.native).consoleAuditEvents)).filter(
      (row) => row.category === 'login',
    )
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.actorConsoleAccountId).toBe(row.resourceId)
    }
    expect(rows.find((row) => row.outcome === 'success')?.actorConsoleAccountId).toBe(f.actor.id)
    expect(rows.find((row) => row.failureReason === 'unknown_account')?.actorConsoleAccountId).toBeNull()
    expect(rows.find((row) => row.failureReason === 'invalid_password')?.actorConsoleAccountId).toBe(
      f.actor.id,
    )
  })

  // 形状约束一旦引用外键列，删除账号时外键置空会当场把这一行判为非法，
  // DELETE 整体失败。三库都必须能删掉登录过的账号，并保留登录历史。
  it('删除登录过的账号不被形状约束反噬，登录历史留下但 actor 置空', async () => {
    const f = await fixture(driver)
    const identity = (await api.findLocalIdentity(f.db, 'shape-admin'))!
    await f.rbac.completeSuccessfulLogin({
      identityId: identity.id,
      accountId: f.actor.id,
      identifier: 'shape-admin',
      client: { kind: 'web' },
    })
    const admin = await f.rbac.createAccount(
      createAccountBodySchema.parse({
        email: 'shape-keeper',
        displayName: '保留管理员',
        password: 'secret-password',
        roleKeys: ['admin'],
      }),
      null,
    )

    await f.rbac.deleteAccount(f.actor.id, admin)

    const logins = (await f.native.select().from(schemaFor(f.native).consoleAuditEvents)).filter(
      (row) => row.category === 'login',
    )
    expect(logins).toHaveLength(1)
    expect(logins[0]).toMatchObject({ loginIdentifier: 'shape-admin', outcome: 'success' })
    expect(logins[0]!.actorConsoleAccountId).toBeNull()
  })
})
