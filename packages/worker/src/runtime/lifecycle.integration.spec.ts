import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  targets,
  type DbHandle,
} from '@cairn/db'
import type { Step } from '@cairn/shared'
import { ExecutionEngine } from '../engine/engine.js'
import { LifecycleService } from './lifecycle.service'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_lc`

describe('LifecycleService（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: '停机夹具',
      email: `lc-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `lc-${SCHEMA.slice(-8)}`,
      name: '停机夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('停机落在领取期间：已领取的 Run 必须收尾，停机不得提前返回', async () => {
    const steps: Step[] = [
      {
        id: '00000000-0000-4000-8000-0000000000c1',
        name: '慢步骤',
        type: 'delay',
        effectType: 'READ_ONLY',
        input: { durationMs: 5_000 },
      },
    ]
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '停机竞态',
      steps,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })

    // 闸门卡住 claim：停机信号正好落在「已领取、还没开始执行」之间。
    const claimEntered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    // 第三个构造参数是对象存储清理用的 ObjectService，与本用例无关：给个同形的占位即可，
    // 免得停机竞态的测试被另一个模块的依赖链拖住。
    const noObjects = { purgeExpiredObjects: async () => ({ purged: 0 }) }
    const lifecycle = new LifecycleService(
      gatedPoolHandle(handle, gate.promise, () => claimEntered.resolve()),
      new ExecutionEngine(handle),
      noObjects as never,
    )

    await lifecycle.onApplicationBootstrap()
    await claimEntered.promise

    let shutdownSettled = false
    const shutdown = lifecycle.onApplicationShutdown('SIGTERM').then(() => {
      shutdownSettled = true
    })
    const { promise: ticked, resolve: tick } = Promise.withResolvers<void>()
    setTimeout(tick, 50)
    await tick

    // 在途 pump 还没结束，停机就必须还没返回——否则这条 Run 会被留在 RUNNING。
    expect(shutdownSettled).toBe(false)

    gate.resolve()
    await shutdown

    const detail = await getRun(handle.db, created.detail.id)
    expect(detail.status).toBe('CANCELLED')
    expect(detail.stepRuns.map((step) => step.status)).toEqual(['CANCELLED'])
    expect(detail.stepRuns[0]?.attempts).toEqual([])
  })
})

/** 只把 `pool.query` 挡在闸门后：`claimQueuedRun` 走它，其余仓储调用走 `handle.db`。 */
function gatedPoolHandle(handle: DbHandle, gate: Promise<void>, onClaim: () => void): DbHandle {
  return {
    ...handle,
    pool: new Proxy(handle.pool, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async (...args: unknown[]) => {
            onClaim()
            await gate
            return (target.query as (...rest: unknown[]) => unknown)(...args)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    }),
  } as DbHandle
}
