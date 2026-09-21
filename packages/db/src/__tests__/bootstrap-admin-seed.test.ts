import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scryptSync, timingSafeEqual } from 'node:crypto'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { type NativeHandle as DbHandle } from '../test-entry.js'

/** 与 packages/api/src/auth/password.ts 同格式，不引 api 包。 */
function verifyScrypt(plain: string, stored: string): boolean {
  const m = stored.match(/^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/)
  if (!m) return false
  const expected = Buffer.from(m[5]!, 'base64url')
  const derived = scryptSync(plain, Buffer.from(m[4]!, 'base64url'), expected.length, {
    N: Number(m[1]),
    r: Number(m[2]),
    p: Number(m[3]),
  })
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/**
 * 空库迁完就该有管理员：交付不依赖 API 起没起过、起的是哪个版本。
 * openContractDb 每次建一个全新库并跑完全部迁移，正好是「首次部署」这条路径。
 */
describe.each(DRIVERS)('%s 初始管理员种子数据', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle

  beforeAll(async () => {
    handle = await openContractDb(driver, `seed_${Date.now().toString(36)}`)
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('迁移跑完即存在 admin 账号、本地身份与管理员角色绑定', async () => {
    const { consoleAccounts, consoleIdentities, consoleAccountRoles, consoleRoles } = schemaFor(
      handle.db,
    )
    const [identity] = await handle.db
      .select()
      .from(consoleIdentities)
      .where(eq(consoleIdentities.subject, 'admin'))
    expect(identity?.provider).toBe('local')
    expect(identity?.secret).toMatch(/^\$scrypt\$/)

    const [account] = await handle.db
      .select()
      .from(consoleAccounts)
      .where(eq(consoleAccounts.id, identity!.consoleAccountId))
    expect(account?.email).toBe('admin')
    expect(account?.status).toBe('active')

    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    const bindings = await handle.db
      .select()
      .from(consoleAccountRoles)
      .where(eq(consoleAccountRoles.consoleAccountId, account!.id))
    expect(bindings.map((b) => b.consoleRoleId)).toContain(admin!.id)
  })

  it('种下的口令哈希能通过控制面同款校验', async () => {
    const { consoleIdentities } = schemaFor(handle.db)
    const [identity] = await handle.db
      .select()
      .from(consoleIdentities)
      .where(eq(consoleIdentities.subject, 'admin'))
    expect(verifyScrypt('cairn-admin', identity!.secret!)).toBe(true)
    expect(verifyScrypt('not-the-password', identity!.secret!)).toBe(false)
  })

  it('只种一个：重复迁移不会再建第二个管理员', async () => {
    const { consoleIdentities } = schemaFor(handle.db)
    const rows = await handle.db
      .select()
      .from(consoleIdentities)
      .where(eq(consoleIdentities.subject, 'admin'))
    expect(rows).toHaveLength(1)
  })
})
