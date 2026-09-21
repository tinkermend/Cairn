import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { ensureFrozenAccessPolicyTx } from '../map/access.js'
import { atomic, schemaFor } from '../native.js'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import { type NativeHandle as DbHandle } from '../test-entry.js'

/**
 * 目标访问策略首次创建时还没有行可锁，`FOR UPDATE` 拦不住并发：同一个新目标上
 * 两个几乎同时的 Run 会都判定「没有策略」。此前第二个事务撞主键抛 23505，
 * 表现为新目标上的并发首跑其中一个 500。
 *
 * 光靠 Promise.all 并发不可靠：事务在线程池里跑得快，多数时候恰好串行，
 * 撤掉修复测试也照样绿（已验证）。所以这里把交错做成确定的：
 * 事务 A 读完「还没有策略」后停在门口，事务 B 完整提交，再放行 A。
 */
describe.each(DRIVERS)('%s 目标访问策略首次创建的并发', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `acc_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'race',
      email: `race-${actorId}@example.com`,
      status: 'active',
    })
    await grantAdminScope(handle.db, actorId)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function freshTarget(): Promise<string> {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      // UUIDv7 前缀是时间戳，同一毫秒内会重复；取末段随机位。
      code: `race-${id.slice(-12)}`,
      name: '竞态夹具',
      entryUrl: 'https://race.example/home',
    })
    return id
  }

  // 只在 PostgreSQL 上做人为交错：MySQL 的 InnoDB 对 SELECT ... FOR UPDATE 的空结果加间隙锁，
  // 「A 读到空后停住」会把 B 的 INSERT 挡在锁外，而 A 又在等 B，于是死锁到超时——
  // 那是这个手法造出来的、真实场景里不会出现的持锁停顿，不是产品缺陷。
  // MySQL 由下面的并发压测覆盖（真实并发下不报错、只落一行）。
  it.runIf(driver === 'postgres')('确定性交错：A 读到「无策略」后 B 先提交，A 不得撞主键，且回读 B 落库的那一份', async () => {
    const targetId = await freshTarget()
    const { targetAccessPolicies } = schemaFor(handle.db)

    let releaseA!: () => void
    const gate = new Promise<void>((resolve) => { releaseA = resolve })
    let aSawNoRow!: () => void
    const aReadEmpty = new Promise<void>((resolve) => { aSawNoRow = resolve })

    // A：包一层 db，在它第一次读到空结果之后停住，等 B 提交完再继续。
    const a = atomic(handle.db, async (tx) => {
      const proxied = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver)
          if (prop !== 'select') return typeof value === 'function' ? value.bind(target) : value
          return (...args: unknown[]) => {
            const builder = (value as (...a: unknown[]) => any).apply(target, args)
            return {
              from: (table: unknown) => {
                const q = builder.from(table)
                if (table !== targetAccessPolicies) return q
                return new Proxy(q, {
                  get(qt, qp, qr) {
                    const qv = Reflect.get(qt, qp, qr)
                    if (qp !== 'where') return typeof qv === 'function' ? qv.bind(qt) : qv
                    return (...w: unknown[]) => {
                      const filtered = (qv as (...a: unknown[]) => any).apply(qt, w)
                      const origThen = filtered.then.bind(filtered)
                      filtered.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
                        origThen(async (rows: unknown[]) => {
                          if (rows.length === 0) { aSawNoRow(); await gate }
                          return ok(rows)
                        }, bad)
                      return filtered
                    }
                  },
                })
              },
            }
          }
        },
      })
      return ensureFrozenAccessPolicyTx(proxied as never, { targetId, actorId })
    })

    await aReadEmpty
    const b = await atomic(handle.db, (tx) => ensureFrozenAccessPolicyTx(tx, { targetId, actorId }))
    releaseA()
    const resolvedA = await a

    expect(resolvedA.frozen.digest).toBe(b.frozen.digest)
    const rows = await handle.db
      .select()
      .from(targetAccessPolicies)
      .where(eq(targetAccessPolicies.targetId, targetId))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.policyDigest).toBe(b.frozen.digest)
  })

  it('真实并发首建（两个驱动都跑）：全部成功、只落一行、拿到同一份冻结策略', async () => {
    const { targetAccessPolicies } = schemaFor(handle.db)
    // 多轮：单轮里事务可能恰好串行而碰不到窗口。
    for (let round = 0; round < 4; round++) {
      const targetId = await freshTarget()
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          atomic(handle.db, (tx) => ensureFrozenAccessPolicyTx(tx, { targetId, actorId })),
        ),
      )
      expect(new Set(results.map((r) => r.frozen.digest)).size).toBe(1)
      const rows = await handle.db
        .select()
        .from(targetAccessPolicies)
        .where(eq(targetAccessPolicies.targetId, targetId))
      expect(rows).toHaveLength(1)
    }
  })

  it('策略已存在时不重复创建，也不改动已落库的版本', async () => {
    const targetId = await freshTarget()
    const first = await atomic(handle.db, (tx) => ensureFrozenAccessPolicyTx(tx, { targetId, actorId }))
    const second = await atomic(handle.db, (tx) => ensureFrozenAccessPolicyTx(tx, { targetId, actorId }))
    expect(second.frozen).toEqual(first.frozen)
  })
})
