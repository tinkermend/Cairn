import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRuntimeInvariant, type Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  createRunWithSnapshot,
  createScenarioWithVersion,
  finishAttempt,
  loadRunDetail,
  publishScenarioDraft,
  saveScenarioDraft,
  startAttempt,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-0000000000e1',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s provenance CHECK 接受 runtime_invariant', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `cairn_test_${Date.now().toString(36)}_occprov`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'occ-check',
      email: `occ-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `occ-${targetId.slice(0, 8)}`,
      name: '运行期约束 CHECK',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('写入 runtime_invariant 成功，未知 provenance 被拒', async () => {
    const { outcomeResults } = schemaFor(handle.db)
    const invariantId = newId()
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `occ-check-${newId()}`,
      steps: [{ ...echoStep, id: newId() }],
      actor: { id: actorId },
    })
    await saveScenarioDraft(handle.db, scenario.id, {
      revision: 1,
      document: {
        authoringSchemaVersion: 2 as const,
        nodes: [{ kind: 'step', step: echoStep }],
        runtimeInvariants: [createRuntimeInvariant('readonly_guarantee', invariantId)],
      },
      actor: { id: actorId },
    })
    await publishScenarioDraft(handle.db, scenario.id, {
      revision: 2,
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle, `occ-check-${driver}-${newId()}`)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const start = await startAttempt(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      grant,
      inputPayload: { value: 'hello' },
    })
    await finishAttempt(handle.db, {
      runId: created.detail.id,
      attemptId: start!.attemptId,
      attemptStatus: 'SUCCEEDED',
      output: { echoed: 'ok' },
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })
    const detail = await loadRunDetail(handle.db, created.detail.id)
    expect(detail?.outcomeResults.some((row) => row.contractId === invariantId && row.provenance === 'runtime_invariant')).toBe(
      true,
    )

    await expect(
      handle.db.insert(outcomeResults).values({
        id: newId(),
        runId: created.detail.id,
        stepRunId: created.detail.stepRuns[0]!.id,
        attemptId: start!.attemptId,
        contractId: newId(),
        scope: 'scenario',
        meaning: '非法来源',
        severity: 'MUST',
        onViolation: 'continue',
        provenance: 'not_a_source' as never,
        verdict: 'PASS',
        evaluatedAt: new Date(),
        createdAt: new Date(),
      }),
    ).rejects.toSatisfy((error: Error) =>
      String(error.cause ?? error).match(/outcome_results_provenance_check|23514|CHECK/i) !== null,
    )
  })
})
