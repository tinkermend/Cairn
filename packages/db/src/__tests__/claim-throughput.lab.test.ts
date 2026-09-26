import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { protocolCapabilitiesForRoles, type Step } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import {
  claimRunWithCursor,
  createRunWithSnapshot,
  createScenarioWithVersion,
  registerWorker,
  takeLastClaimDiagnostics,
  type ClaimScanCursor,
} from '../test-entry.js'
import { openContractDb } from './contract-fixture.js'

const benchmark = process.env.CAIRN_CLAIM_BENCH === '1' ? it : it.skip
const echo: Step = {
  id: '00000000-0000-4000-8000-000000000062',
  name: '领取压测', type: 'echo', effectType: 'READ_ONLY', input: { value: 'ok' },
}

describe('PG Run 领取积压基准', { timeout: 120_000 }, () => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let seedId: string
  const capabilities = protocolCapabilitiesForRoles({
    executor: true, scheduler: false, maintenance: false, analyst: false,
  })

  beforeAll(async () => {
    if (process.env.CAIRN_CLAIM_BENCH !== '1') return
    handle = await openContractDb('postgres')
    const { consoleAccounts, targets } = schemaFor(handle.db)
    const actorId = newId()
    const targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId, displayName: 'claim bench', email: `claim-bench-${actorId}@example.com`, status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId, code: `claim-bench-${targetId}`, name: 'claim bench', entryUrl: 'https://example.com',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId, name: '领取基准', steps: [echo], actor: { id: actorId },
    })
    const seed = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id, actor: { id: actorId },
    })
    seedId = seed.detail.id
  })

  afterAll(async () => { await handle?.close() })

  async function addRuns(from: number, to: number) {
    await handle.raw(`
      INSERT INTO cairn.runs (
        id, target_id, scenario_id, scenario_version_id, target_account_id,
        created_by_console_account_id, status, snapshot, snapshot_digest,
        context, created_at, updated_at
      )
      SELECT (
        substr(md5(g::text || seed.id::text), 1, 8) || '-' ||
        substr(md5(g::text || seed.id::text), 9, 4) || '-' ||
        '4' || substr(md5(g::text || seed.id::text), 14, 3) || '-' ||
        'a' || substr(md5(g::text || seed.id::text), 18, 3) || '-' ||
        substr(md5(g::text || seed.id::text), 21, 12)
      )::uuid, seed.target_id, seed.scenario_id, seed.scenario_version_id,
      seed.target_account_id, seed.created_by_console_account_id,
      seed.status, seed.snapshot, seed.snapshot_digest, seed.context,
      seed.created_at + g * interval '1 microsecond', seed.updated_at
      FROM cairn.runs seed CROSS JOIN generate_series($2::integer, $3::integer) g
      WHERE seed.id = $1
    `, [seedId, from, to])
  }

  async function readyWorker(name: string, capacity: number) {
    const workerId = `claim-bench-${name}-${newId()}`
    const instanceId = newId()
    await registerWorker(handle.db, {
      workerId, instanceId, capacity, lostAfterSeconds: 120,
      protocolCapabilities: capabilities,
    })
    return { workerId, instanceId }
  }

  function p95(samples: number[]) {
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.ceil(sorted.length * 0.95) - 1]!
  }

  benchmark('1k/10k 快照队列 SQL 耗时与 4 Worker 容量填充', async () => {
    await addRuns(1, 999)
    const solo = await readyWorker('solo', 256)
    let cursor: ClaimScanCursor | undefined
    const sample = async () => {
      const sqlMs: number[] = []
      const startedAt = performance.now()
      for (let i = 0; i < 100; i += 1) {
        const claim = await claimRunWithCursor(handle, {
          ...solo, leaseTtlSeconds: 120, cursor,
        })
        expect(claim.grant).toBeTruthy()
        cursor = claim.cursor
        sqlMs.push(takeLastClaimDiagnostics().candidateSqlMs)
      }
      return { p95SqlMs: p95(sqlMs), totalMs: performance.now() - startedAt, samples: sqlMs }
    }
    const oneK = await sample()
    await addRuns(1000, 9999)
    const tenK = await sample()
    const workers = await Promise.all(Array.from({ length: 4 }, (_, i) => readyWorker(`parallel-${i}`, 8)))
    const parallelStartedAt = performance.now()
    const ids = await Promise.all(workers.map(async (worker) => {
      let workerCursor: ClaimScanCursor | undefined
      const claimed: string[] = []
      for (let i = 0; i < 8; i += 1) {
        const claim = await claimRunWithCursor(handle, {
          ...worker, leaseTtlSeconds: 120, cursor: workerCursor,
        })
        expect(claim.grant).toBeTruthy()
        workerCursor = claim.cursor
        claimed.push(claim.grant!.runId)
      }
      return claimed
    }))
    expect(new Set(ids.flat()).size).toBe(32)
    const parallelMs = performance.now() - parallelStartedAt
    writeFileSync('../../tmp/claim-bench-result.json', JSON.stringify({ oneK, tenK, parallelMs, parallelClaims: 32 }))
    expect(tenK.p95SqlMs).toBeLessThanOrEqual(oneK.p95SqlMs * 2)
  })
})
