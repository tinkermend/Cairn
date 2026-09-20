import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as native from '../native.js'
import { isAiCallEvidence, type Step } from '@cairn/shared'
import {
  completeAiModelCall,
  createRunWithSnapshot,
  createScenarioWithVersion,
  listRunEvidence,
  reserveAiModelCall,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { targets as pg_targets } from '../schema/targets.js'
let targets = pg_targets
import { forceGrantForRun, seedWorker } from './lease-harness.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_aibudget`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000081',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s AI 调用预算', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'tester',
      email: `ai-budget-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `aib-${SCHEMA.slice(-6)}`,
      name: '预算夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('按 stepRun 计数，预扣独立于 Attempt，超限不再外呼', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '预算',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const stepRunId = created.detail.stepRuns[0]!.id
    const first = await reserveAiModelCall(handle.db, {
      runId: created.detail.id,
      stepRunId,
      maxCalls: 1,
      grant,
      model: 'cairn-fake',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = await reserveAiModelCall(handle.db, {
      runId: created.detail.id,
      stepRunId,
      maxCalls: 1,
      grant,
    })
    expect(second).toEqual({ ok: false, code: 'AI_BUDGET_EXCEEDED' })
    await completeAiModelCall(handle.db, {
      evidenceId: first.evidenceId,
      phase: 'failed',
      errorCode: 'AI_CALL_FAILED',
    })
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    const calls = evidence.items.filter((item) => isAiCallEvidence(item.payload))
    expect(calls).toHaveLength(1)
    expect(isAiCallEvidence(calls[0]!.payload) && calls[0]!.payload.phase).toBe('failed')
    const { scenarioAiCalls } = schemaFor(handle.db)
    const ledger = await handle.db.select().from(scenarioAiCalls)
    expect(ledger.some((row) => row.evidenceId === first.evidenceId && row.phase === 'failed')).toBe(true)
    await completeAiModelCall(handle.db, {
      evidenceId: first.evidenceId,
      phase: 'failed',
      errorCode: 'AI_CALL_FAILED',
    })
    const again = await handle.db.select().from(scenarioAiCalls)
    expect(again.filter((row) => row.evidenceId === first.evidenceId)).toHaveLength(1)
  })

  it('RMC09 账本写入失败不影响已提交 evidence', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '账本失败',
      steps: [echoStep],
      actor: { id: actorId },
    })
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
    const worker = await seedWorker(handle)
    const grant = await forceGrantForRun(handle, created.detail.id, worker.workerId)
    const reserved = await reserveAiModelCall(handle.db, {
      runId: created.detail.id,
      stepRunId: created.detail.stepRuns[0]!.id,
      maxCalls: 1,
      grant,
      model: 'cairn-fake',
    })
    expect(reserved.ok).toBe(true)
    if (!reserved.ok) return
    const spy = vi.spyOn(native, 'insertIgnoreRows').mockRejectedValueOnce(new Error('ledger down'))
    await expect(
      completeAiModelCall(handle.db, {
        evidenceId: reserved.evidenceId,
        phase: 'failed',
        errorCode: 'AI_CALL_FAILED',
      }),
    ).resolves.toBeUndefined()
    spy.mockRestore()
    const evidence = await listRunEvidence(handle.db, created.detail.id)
    const calls = evidence.items.filter((item) => isAiCallEvidence(item.payload))
    expect(calls).toHaveLength(1)
    expect(isAiCallEvidence(calls[0]!.payload) && calls[0]!.payload.phase).toBe('failed')
    const { scenarioAiCalls } = schemaFor(handle.db)
    const ledger = await handle.db.select().from(scenarioAiCalls)
    expect(ledger.some((row) => row.evidenceId === reserved.evidenceId)).toBe(false)
  })

  it('含 AI 步骤但没有冻结配置时拒绝创建', async () => {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '缺配置',
      steps: [
        {
          id: newId(),
          name: '操作',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          input: { instruction: '点查询' },
        },
      ],
      actor: { id: actorId },
    })
    await expect(
      createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        actor: { id: actorId },
      }),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' })
  })
})
