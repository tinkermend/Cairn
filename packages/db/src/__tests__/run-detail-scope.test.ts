import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, grantAdminScope, openContractDb } from './contract-fixture.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import { createRunWithSnapshot, createScenarioWithVersion, getRun, listRunEvidence, listRuns } from '../runs/index.js'
import { getEvidenceForRun } from '../objects/evidence.js'
import { loadRunObservation } from '../observe/observation.js'
import { createRepairCandidate } from '../repair/index.js'
import { eq } from 'drizzle-orm'
import { expose, markConsoleDatabase } from '../database.js'
import {
  getRun as publicGetRun,
  getEvidenceForRun as publicGetEvidenceForRun,
  listRunEvidence as publicListRunEvidence,
  listRuns as publicListRuns,
  loadRunObservation as publicLoadRunObservation,
} from '../index.js'

describe.each(DRIVERS)('%s run detail target scope', { timeout: 60_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let readerId: string
  let reportReaderId: string
  let runLimitedReaderId: string
  let runA: string
  let runB: string
  let evidenceA: string
  let evidenceB: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const { consoleAccounts, consoleRoles, consoleRolePermissions, consoleAccountRoles, targets, evidences } = schemaFor(handle.db)
    const adminId = newId()
    readerId = newId()
    reportReaderId = newId()
    runLimitedReaderId = newId()
    const targetA = newId()
    const targetB = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: adminId, displayName: 'admin', email: `${adminId}@test.invalid`, status: 'active' },
      { id: readerId, displayName: 'reader', email: `${readerId}@test.invalid`, status: 'active' },
      { id: reportReaderId, displayName: 'report-reader', email: `${reportReaderId}@test.invalid`, status: 'active' },
      { id: runLimitedReaderId, displayName: 'run-limited-reader', email: `${runLimitedReaderId}@test.invalid`, status: 'active' },
    ])
    await grantAdminScope(handle.db, adminId)
    await handle.db.insert(targets).values([
      { id: targetA, code: `run-scope-a-${targetA.slice(0, 8)}`, name: 'A', entryUrl: 'https://a.example' },
      { id: targetB, code: `run-scope-b-${targetB.slice(0, 8)}`, name: 'B', entryUrl: 'https://b.example' },
    ])
    for (const permission of ['target:read', 'run:read']) {
      const roleId = newId()
      await handle.db.insert(consoleRoles).values({ id: roleId, key: `run-scope-${roleId}`, name: permission, kind: 'custom' })
      await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: roleId, permission })
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: readerId,
        consoleRoleId: roleId,
        targetScopeMode: 'selected',
        targetScopeIds: permission === 'target:read' ? [targetA] : [targetA, targetB],
      })
    }
    for (const permission of ['target:read', 'run:read', 'report:read']) {
      const roleId = newId()
      await handle.db.insert(consoleRoles).values({ id: roleId, key: `report-scope-${roleId}`, name: permission, kind: 'custom' })
      await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: roleId, permission })
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: reportReaderId,
        consoleRoleId: roleId,
        targetScopeMode: 'selected',
        targetScopeIds: permission === 'report:read' ? [targetA] : [targetA, targetB],
      })
    }
    for (const permission of ['target:read', 'run:read']) {
      const roleId = newId()
      await handle.db.insert(consoleRoles).values({ id: roleId, key: `observation-scope-${roleId}`, name: permission, kind: 'custom' })
      await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: roleId, permission })
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: runLimitedReaderId,
        consoleRoleId: roleId,
        targetScopeMode: 'selected',
        targetScopeIds: permission === 'run:read' ? [targetA] : [targetA, targetB],
      })
    }
    const steps = [{ id: newId(), name: 'echo', type: 'echo' as const, effectType: 'READ_ONLY' as const, input: { value: 'ok' } }]
    const scenarioA = await createScenarioWithVersion(handle.db, { targetId: targetA, name: 'A', steps, actor: { id: adminId } })
    const scenarioB = await createScenarioWithVersion(handle.db, { targetId: targetB, name: 'B', steps, actor: { id: adminId } })
    runA = (await createRunWithSnapshot(handle.db, { scenarioId: scenarioA.id, actor: { id: adminId } })).detail.id
    runB = (await createRunWithSnapshot(handle.db, { scenarioId: scenarioB.id, actor: { id: adminId } })).detail.id
    evidenceA = newId()
    evidenceB = newId()
    await handle.db.insert(evidences).values([
      { id: evidenceA, runId: runA, type: 'log', status: 'available', payload: { target: 'A' } },
      { id: evidenceB, runId: runB, type: 'log', status: 'available', payload: { target: 'B' } },
    ])
  })

  afterAll(async () => { await handle?.close() })

  it('hides a run and its evidence when target:read excludes the target', async () => {
    await expect(getRun(handle.db, runB, readerId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(listRunEvidence(handle.db, runB, readerId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    expect(await getEvidenceForRun(handle.db, { runId: runB, evidenceId: evidenceB }, readerId)).toBeNull()
    expect(await getEvidenceForRun(handle.db, { runId: runA, evidenceId: evidenceB }, readerId)).toBeNull()
  })

  it('allows the same target and preserves internal calls without actorId', async () => {
    expect((await getRun(handle.db, runA, readerId)).id).toBe(runA)
    expect((await listRunEvidence(handle.db, runA, readerId)).items.map((item) => item.id)).toContain(evidenceA)
    expect((await getEvidenceForRun(handle.db, { runId: runA, evidenceId: evidenceA }, readerId))?.id).toBe(evidenceA)
    expect((await getRun(handle.db, runB)).id).toBe(runB)
    expect((await getEvidenceForRun(handle.db, { runId: runB, evidenceId: evidenceB }))?.id).toBe(evidenceB)
  })

  it('fails closed at the public DB facade when a console caller omits actorId', async () => {
    const consoleDb = expose(handle)
    markConsoleDatabase(consoleDb)
    expect(() => publicGetRun(consoleDb, runA)).toThrow('requires actorId')
    expect(() => publicListRunEvidence(consoleDb, runA)).toThrow('requires actorId')
    expect(() => publicGetEvidenceForRun(consoleDb, { runId: runA, evidenceId: evidenceA })).toThrow('requires actorId')
    expect(() => publicListRuns(consoleDb, {})).toThrow('requires actorId')
    expect(() => publicLoadRunObservation(consoleDb, runA)).toThrow('requires actorId')
    expect((await publicGetRun(consoleDb, runA, readerId)).id).toBe(runA)
    await expect(publicGetRun(consoleDb, runB, readerId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    expect((await publicGetRun(handle, runB)).id).toBe(runB)
  })

  it('scopes observation and its evidence to the actor run:read target set', async () => {
    expect((await loadRunObservation(handle.db, runA, runLimitedReaderId))?.run.id).toBe(runA)
    expect(await loadRunObservation(handle.db, runB, runLimitedReaderId)).toBeNull()
    expect((await loadRunObservation(handle.db, runB))?.run.id).toBe(runB)
  })

  it('does not disclose report existence through hasReport filters outside report:read scope', async () => {
    expect((await listRuns(handle.db, { hasReport: false }, reportReaderId)).items.map((item) => item.id)).toContain(runA)
    expect((await listRuns(handle.db, { hasReport: false }, reportReaderId)).items.map((item) => item.id)).not.toContain(runB)
    expect((await listRuns(handle.db, { hasReport: true }, reportReaderId)).items.map((item) => item.id)).not.toContain(runB)
  })

  it('rechecks repair creation scope inside its write transaction', async () => {
    const run = await getRun(handle.db, runA)
    const candidateId = `rep_${newId().replaceAll('-', '')}`
    await expect(createRepairCandidate(handle.db, {
      candidateId,
      scenarioId: run.scenarioId,
      runId: runA,
      sourceAttemptId: newId(),
      patchTargetRef: { kind: 'scenario', scenarioId: run.scenarioId, stepId: newId(), sourceDefinitionDigest: 'a'.repeat(64) },
      patch: { kind: 'REPLACE_LOCATOR', suggestedCandidate: { by: 'css', value: '#submit' } },
      hypothesis: 'Changed selector',
      digestManifest: {
        sourceDefinitionDigest: 'a'.repeat(64),
        postPatchExecutionDigest: 'b'.repeat(64),
        originalContractDigest: 'c'.repeat(64),
        algorithmVersion: 'v1',
      },
      guardResults: {
        allowedFields: { name: 'allowedFields', status: 'passed', reason: 'ok' },
        unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'passed', reason: 'ok' },
        sideEffectSafety: { name: 'sideEffectSafety', status: 'passed', reason: 'ok' },
        contextIntegrity: { name: 'contextIntegrity', status: 'passed', reason: 'ok' },
        overallPassed: true,
      },
      scopeActorId: readerId,
    })).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    const { repairCandidates } = schemaFor(handle.db)
    expect(await handle.db.select({ id: repairCandidates.id }).from(repairCandidates)
      .where(eq(repairCandidates.candidateId, candidateId))).toEqual([])
  })
})
