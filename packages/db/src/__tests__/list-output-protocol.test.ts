import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LIST_OUTPUT_PROTOCOL,
  OUTCOME_MANIFEST_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  type Step,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { createRunWithSnapshot } from '../runs/runs.js'
import { claimRun, markWorkerStopped, registerWorker } from '../leases/leases.js'
import { createScenarioWithVersion } from '../runs/scenarios.js'

describe.each(DRIVERS)('CFA-14: listOutputProtocol Worker 领取门控 (%s)', (driverName) => {
  let handle: DbHandle
  let targetId: string
  const actorId = newId()
  const actor = { id: actorId, email: 'test@example.com' }

  beforeAll(async () => {
    handle = await openContractDb(driverName)
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'test_author',
      email: `test-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      name: 'test_target',
      code: `test_${targetId.slice(0, 8)}`,
      entryUrl: 'https://example.com',
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle.close?.()
  })

  it('使用列表提取的快照带 listOutputProtocol，未声明该能力的 Worker 不领取', async () => {
    const extractStep: Step = {
      id: newId(),
      name: '批量提取',
      type: 'extract',
      effectType: 'READ_ONLY',
      outputKey: 'items',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '.item' }] },
        as: 'text',
        many: { maxItems: 10 },
      },
    }

    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `list-out-${newId().slice(0, 8)}`,
      actor,
      steps: [extractStep],
    })

    const run = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      actor: { kind: 'console', id: actorId },
    })

    // 快照必须包含 listOutputProtocol 声明
    expect(run.detail.snapshot.listOutputProtocol).toBe(LIST_OUTPUT_PROTOCOL)

    // 旧 Worker：未声明 output.list@1 协议
    const oldWorker = {
      workerId: `old-w-${newId()}`,
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, OUTCOME_MANIFEST_PROTOCOL],
    }
    await registerWorker(handle.db, oldWorker)

    // 旧 Worker 无法领取此 Run
    const oldGrant = await claimRun(handle, { ...oldWorker, leaseTtlSeconds: 60 })
    expect(oldGrant).toBeNull()

    await markWorkerStopped(handle.db, oldWorker.workerId, oldWorker.instanceId)

    // 新 Worker：声明了 output.list@1 协议
    const newWorker = {
      workerId: `new-w-${newId()}`,
      instanceId: newId(),
      capacity: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, OUTCOME_MANIFEST_PROTOCOL, LIST_OUTPUT_PROTOCOL],
    }
    await registerWorker(handle.db, newWorker)

    // 新 Worker 成功领取
    const newGrant = await claimRun(handle, { ...newWorker, leaseTtlSeconds: 60 })
    expect(newGrant).not.toBeNull()
    expect(newGrant?.runId).toBe(run.detail.id)
  })
})
