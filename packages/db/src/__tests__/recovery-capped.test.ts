import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { DEFAULT_MONITOR_MAX_RECOVERIES, type Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { forceGrantForRun } from './lease-harness.js'
import {
  countRecoveryCappedRuns,
  countRecoveryCappedRunsFromRuns,
  createRunWithSnapshot,
  createScenarioWithVersion,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000c1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s recoveryCappedRuns 等价', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let scenarioId: string
  let accountId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `capped_${Date.now().toString(36)}`)
    const { consoleAccounts, targetAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    const targetId = newId()
    accountId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'capped',
      email: `capped-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `capped-${targetId.slice(0, 8)}`,
      name: '上限夹具',
      entryUrl: 'https://example.com',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '上限账号',
      username: 'capped',
      status: 'active',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '上限场景',
      steps: [echoStep],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function queueRun() {
    return createRunWithSnapshot(handle.db, {
      scenarioId,
      targetAccountId: accountId,
      actor: { id: actorId },
      idempotencyKey: newId(),
    })
  }

  async function addFailedLeases(runId: string, statuses: Array<'EXPIRED' | 'REVOKED'>) {
    for (const status of statuses) {
      const grant = await forceGrantForRun(handle, runId, `cap-${newId()}`)
      const { runLeases } = schemaFor(handle.db)
      await handle.db
        .update(runLeases)
        .set({ status, releasedAt: new Date(), releaseReason: status === 'REVOKED' ? 'revoked' : 'expired' })
        .where(eq(runLeases.id, grant.leaseId))
    }
  }

  it('PS12 软删、NEEDS_REVIEW、阈值边界与 REVOKED 混合结果一致', async () => {
    const max = DEFAULT_MONITOR_MAX_RECOVERIES
    const under = await queueRun()
    const exact = await queueRun()
    const over = await queueRun()
    const review = await queueRun()
    const soft = await queueRun()
    await addFailedLeases(under.detail.id, Array.from({ length: max - 1 }, () => 'EXPIRED'))
    await addFailedLeases(exact.detail.id, Array.from({ length: max }, () => 'EXPIRED'))
    await addFailedLeases(over.detail.id, [...Array.from({ length: max }, () => 'EXPIRED' as const), 'REVOKED'])
    await addFailedLeases(review.detail.id, Array.from({ length: max }, () => 'REVOKED'))
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'QUEUED' }).where(eq(runs.id, under.detail.id))
    await handle.db.update(runs).set({ status: 'QUEUED' }).where(eq(runs.id, exact.detail.id))
    await handle.db.update(runs).set({ status: 'QUEUED' }).where(eq(runs.id, over.detail.id))
    await handle.db.update(runs).set({ status: 'NEEDS_REVIEW' }).where(eq(runs.id, review.detail.id))
    await addFailedLeases(soft.detail.id, Array.from({ length: max }, () => 'EXPIRED'))
    await handle.db
      .update(runs)
      .set({
        deletedAt: new Date(),
        deletedBy: { id: actorId, displayName: 'capped', kind: 'console' },
        status: 'QUEUED',
      })
      .where(eq(runs.id, soft.detail.id))

    const next = await countRecoveryCappedRuns(handle.db, max)
    const prev = await countRecoveryCappedRunsFromRuns(handle.db, max)
    expect(next).toBe(prev)
    expect(next).toBe(3)
  })

  it('PS12 EXPLAIN 从异常租约聚合而不对每条活跃 Run 相关子查询', async () => {
    const max = DEFAULT_MONITOR_MAX_RECOVERIES
    const schema = driver === 'postgres' ? 'cairn.' : ''
    const nextSql = `
      SELECT count(*) FROM (
        SELECT run_id FROM ${schema}run_leases
         WHERE status IN ('EXPIRED', 'REVOKED')
         GROUP BY run_id
        HAVING count(*) >= ${max}
      ) capped_lease_runs
      INNER JOIN ${schema}runs AS runs ON runs.id = capped_lease_runs.run_id
       WHERE runs.deleted_at IS NULL
         AND runs.status IN ('QUEUED', 'RECOVERING', 'RUNNING', 'HOLDING', 'WAITING_FOR_AUTH', 'NEEDS_REVIEW')
    `
    const prevSql = `
      SELECT count(*) FROM ${schema}runs AS runs
       WHERE runs.deleted_at IS NULL
         AND runs.status IN ('QUEUED', 'RECOVERING', 'RUNNING', 'HOLDING', 'WAITING_FOR_AUTH', 'NEEDS_REVIEW')
         AND (
           SELECT count(*) FROM ${schema}run_leases l
            WHERE l.run_id = runs.id AND l.status IN ('EXPIRED', 'REVOKED')
         ) >= ${max}
    `
    const explain = (sql: string) =>
      driver === 'postgres' ? handle.raw(`EXPLAIN (FORMAT JSON) ${sql}`) : handle.raw(`EXPLAIN ${sql}`)
    const nextPlan = JSON.stringify(await explain(nextSql))
    const prevPlan = JSON.stringify(await explain(prevSql))
    expect(prevPlan.toLowerCase()).toMatch(/subplan|subquery|dependent|correlated/)
    expect(nextPlan.toLowerCase()).toMatch(/group|aggregate|hash|derived/)
    expect(nextPlan.toLowerCase()).not.toMatch(/dependent subquery/)
  })
})
