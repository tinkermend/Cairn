import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  claimRun,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getRun,
  newId,
  openIsolatedDb,
  registerWorker,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import type { Step } from '@cairn/shared'
import { WORKER_TEST_PROTOCOLS } from '../__tests__/worker-protocols.js'
import { ExecutionEngine } from '../engine/engine.js'
import { LifecycleService } from './lifecycle.service'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_lc`

describe('LifecycleService（集成）', { timeout: 60_000 }, () => {
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
    // 第三/四个构造参数是 ObjectService / BrowserSessionManager，与本用例无关：给同形占位。
    const noObjects = {
      purgeExpiredObjects: async () => ({ purged: 0 }),
      probeStore: async () => ({ ok: true, latencyMs: 1, errorClass: null }),
    }
    const noEvidence = { settleExpired: async () => ({ marked: 0 }), settleRun: async () => {} }
    const noSessions = {
      reconcileOwn: async () => ({ leasesRevoked: 0, sessionsClosed: 0 }),
      setWorkerInstance: () => {},
      startHeartbeat: () => {},
      stopHeartbeat: () => {},
      shutdown: async () => {},
      reap: async () => ({ leasesExpired: 0, sessionsClosed: 0 }),
      stopAllLocal: async () => [],
      liveHandleCount: () => 0,
    }
    const restoreConnect = gatePoolConnect(handle, gate.promise, () => claimEntered.resolve())
    const lifecycle = new LifecycleService(
      handle,
      new ExecutionEngine(handle),
      noObjects as never,
      noEvidence as never,
      noSessions as never,
    )

    try {
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

      // 停机不是取消（S4）：Run 原样交回 RECOVERING，用户没取消的 Run 不得因为一次
      // 滚动发布变成 CANCELLED。租约按 worker_shutdown 正常释放，不算一次恢复失败。
      const detail = await getRun(handle.db, created.detail.id)
      expect(detail.status).toBe('RECOVERING')
      expect(detail.stepRuns.map((step) => step.status)).toEqual(['PENDING'])
      expect(detail.stepRuns[0]?.attempts).toEqual([])

      const { rows } = await handle.pool.query<{ status: string; release_reason: string }>(
        `SELECT status, release_reason FROM run_leases WHERE run_id = $1`,
        [created.detail.id],
      )
      expect(rows.map((row) => row.status)).toEqual(['RELEASED'])
      expect(rows[0]?.release_reason).toBe('worker_shutdown')

      // 交回之后必须真的能被别人领走，否则"不写终态"只是把 Run 悬在半空
      const peerId = `${SCHEMA.slice(-8)}-peer`
      const peerInstance = newId()
      await registerWorker(handle.db, {
        workerId: peerId,
        instanceId: peerInstance,
        capacity: 1,
        lostAfterSeconds: 60,
        protocolCapabilities: [...WORKER_TEST_PROTOCOLS],
      })
      const taken = await claimRun(handle, {
        workerId: peerId,
        instanceId: peerInstance,
        leaseTtlSeconds: 30,
      })
      expect(taken?.runId).toBe(created.detail.id)
      expect(taken?.fencingToken).toBe(2)
    } finally {
      restoreConnect()
      await lifecycle.onApplicationShutdown('SIGTERM').catch(() => undefined)
    }
  })
})

function sqlText(text: unknown): string {
  if (typeof text === 'string') return text
  if (text && typeof text === 'object' && 'text' in text) return String((text as { text: unknown }).text)
  return String(text)
}

/** 改写真实连接池的 connect：只把 SKIP LOCKED 领取查询挡在闸门后。 */
function gatePoolConnect(handle: DbHandle, gate: Promise<void>, onClaim: () => void): () => void {
  const origConnect = handle.pool.connect.bind(handle.pool)
  handle.pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      return origConnect(...(args as []))
    }
    return origConnect().then((client) => {
      const query = client.query.bind(client)
      ;(client as { query: typeof query }).query = ((text: unknown, values?: unknown, cb?: unknown) => {
        if (/skip locked/i.test(sqlText(text))) {
          onClaim()
          return gate.then(() => query(text as never, values as never, cb as never))
        }
        return query(text as never, values as never, cb as never)
      }) as typeof query
      return client
    })
  }) as typeof handle.pool.connect
  return () => {
    handle.pool.connect = origConnect
  }
}
