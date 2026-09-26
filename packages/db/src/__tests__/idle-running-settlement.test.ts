import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Step } from '@cairn/shared'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  failRunValidation,
  getRun,
  markRunCancelled,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_idle`

const steps: Step[] = [
  { id: '00000000-0000-4000-8000-0000000000d1', name: '循环头替身', type: 'echo', effectType: 'READ_ONLY', input: { value: 1 } },
  { id: '00000000-0000-4000-8000-0000000000d2', name: '后续', type: 'echo', effectType: 'READ_ONLY', input: { value: 2 } },
]

/**
 * 复查修复：Run 停下时，停在 RUNNING 却没有在途尝试的记录（典型是正在逐项的循环头）
 * 要随之收尾，不能在终态 Run 里挂着「运行中」的步骤。
 */
describe.each(DRIVERS)('%s Run 停下时收尾空转的 RUNNING 步骤', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'idle-tester',
      email: `idle-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({ id: targetId, code: `idle-${SCHEMA.slice(-6)}`, name: '空转收尾', entryUrl: 'https://example.com' })
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function runWithIdleHeader(name: string) {
    const scenario = await createScenarioWithVersion(handle.db, { targetId, name, steps, actor: { id: actorId } })
    const created = await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const { stepRuns } = schemaFor(handle.db)
    await handle.db.update(stepRuns).set({ status: 'RUNNING' }).where(eq(stepRuns.id, created.detail.stepRuns[0]!.id))
    return { runId: created.detail.id, grant }
  }

  it('取消时空转的 RUNNING 记录记为 CANCELLED', async () => {
    const { runId, grant } = await runWithIdleHeader('idle-cancel')
    await markRunCancelled(handle.db, runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('CANCELLED')
    expect(detail.stepRuns.map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED'])
  })

  it('失败停下时空转的 RUNNING 记录记为 FAILED，其余未执行的记为跳过', async () => {
    const { runId, grant } = await runWithIdleHeader('idle-fail')
    await failRunValidation(handle.db, runId, { grant })
    const detail = await getRun(handle.db, runId)
    expect(detail.status).toBe('FAILED')
    expect(detail.stepRuns.map((s) => s.status)).toEqual(['FAILED', 'SKIPPED'])
  })
})
