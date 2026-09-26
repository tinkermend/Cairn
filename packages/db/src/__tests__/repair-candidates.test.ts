import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  type DigestManifest,
  type GuardResults,
  type HealingPatch,
  type ScenarioDocument,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { newId } from '../id.js'
import {
  adoptRepairCandidate,
  createOrUpdateRepairCandidateTx,
  createRepairCandidate,
  expireRepairCandidatesOnPublishTx,
  getRepairCandidate,
  listRepairCandidatesByRun,
  listRepairCandidatesByScenario,
  rejectRepairCandidate,
  reopenRepairCandidate,
  updateRepairCandidateStatus,
  updateRepairCandidateValidation,
  validateRepairCandidate,
  settleCandidateValidationTx,
} from '../repair/index.js'
import { computeTargetDigest } from '@cairn/authoring'
import { insertRows, schemaFor } from '../native.js'

describe.each(DRIVERS)('%s Repair Candidates Repository (Integration)', (driver) => {
  let handle: DbHandle
  const accountId = newId()
  const targetId = newId()
  const scenarioId = newId()
  const versionId = newId()
  const runId = newId()
  const sourceAttemptId = newId()
  const stepId = newId()

  const sampleDoc: ScenarioDocument = {
    schemaVersion: 1,
    title: 'Repair Scenario Doc',
    steps: [
      {
        id: stepId,
        name: 'Click Submit',
        type: 'click',
        effectType: 'IDEMPOTENT',
        input: {
          target: {
            kind: 'locator',
            candidates: [{ by: 'css', value: '#submit-btn' }],
          },
        },
      } as any,
    ],
  }

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const { consoleAccounts, targets, scenarios, scenarioVersions, scenarioDrafts, runs } = schemaFor(handle.db)
    const now = new Date()

    await insertRows(handle.db, consoleAccounts, {
      id: accountId,
      displayName: 'Repair Tester',
      email: `repair_${Date.now()}@example.com`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    await insertRows(handle.db, targets, {
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: 'Target Repair',
      entryUrl: 'https://example.com',
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })

    await insertRows(handle.db, scenarios, {
      id: scenarioId,
      targetId,
      name: 'Repair Scenario',
      status: 'active',
      purpose: 'user',
      createdByConsoleAccountId: accountId,
      createdAt: now,
      updatedAt: now,
    })

    await insertRows(handle.db, scenarioVersions, {
      id: versionId,
      scenarioId,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'dummy_digest',
      definition: sampleDoc,
      createdByConsoleAccountId: accountId,
      createdAt: now,
    })

    await insertRows(handle.db, scenarioDrafts, {
      scenarioId,
      revision: 1,
      document: sampleDoc,
      updatedByConsoleAccountId: accountId,
      updatedAt: now,
    })

    await insertRows(handle.db, runs, {
      id: runId,
      scenarioId,
      scenarioVersionId: versionId,
      targetId,
      createdByConsoleAccountId: accountId,
      status: 'FAILED',
      outcomeStatus: 'NOT_EVALUATED',
      evidenceStatus: 'PENDING',
      debugMode: 'runThrough',
      snapshot: { scenario: sampleDoc } as any,
      snapshotDigest: 'dummy_snapshot_digest',
      context: {},
      createdAt: now,
      updatedAt: now,
    })
  })

  afterAll(async () => {
    if (handle) await handle.close()
  })

  const dummyDigestManifest: DigestManifest = {
    sourceDefinitionDigest: 'a'.repeat(64),
    postPatchExecutionDigest: 'b'.repeat(64),
    originalContractDigest: 'c'.repeat(64),
    algorithmVersion: 'v1',
  }

  const dummyGuardResults: GuardResults = {
    allowedFields: { name: 'allowedFields', status: 'passed', reason: 'ok' },
    unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'passed', reason: 'ok' },
    sideEffectSafety: { name: 'sideEffectSafety', status: 'passed', reason: 'ok' },
    contextIntegrity: { name: 'contextIntegrity', status: 'passed', reason: 'ok' },
    overallPassed: true,
  }

  const dummyPatch: HealingPatch = {
    kind: 'REPLACE_LOCATOR',
    suggestedCandidate: {
      by: 'css',
      value: 'button.submit-primary',
    },
  }

  it('creates and retrieves a repair candidate', async () => {
    const candidateId = `rep_${newId().slice(0, 8)}`
    const created = await createRepairCandidate(handle.db, {
      candidateId,
      runId,
      sourceAttemptId,
      patchTargetRef: {
        kind: 'scenario',
        scenarioId,
        stepId,
        sourceDefinitionDigest: 'a'.repeat(64),
      },
      patch: dummyPatch,
      hypothesis: 'Selector was changed',
      digestManifest: dummyDigestManifest,
      guardResults: dummyGuardResults,
    })

    expect(created.candidateId).toBe(candidateId)
    expect(created.status).toBe('proposed')
    expect(created.patch.kind).toBe('REPLACE_LOCATOR')

    const fetched = await getRepairCandidate(handle.db, candidateId)
    expect(fetched).not.toBeNull()
    expect(fetched?.id).toBe(created.id)
    expect(fetched?.candidateId).toBe(candidateId)

    const list = await listRepairCandidatesByRun(handle.db, runId)
    expect(list.some((c) => c.candidateId === candidateId)).toBe(true)
  })

  it('updates validation scope and transitions status', async () => {
    const candidateId = `rep_val_${newId().slice(0, 8)}`
    const created = await createRepairCandidate(handle.db, {
      candidateId,
      runId,
      sourceAttemptId,
      patchTargetRef: {
        kind: 'scenario',
        scenarioId,
        stepId,
        sourceDefinitionDigest: 'a'.repeat(64),
      },
      patch: dummyPatch,
      hypothesis: 'Validation test',
      digestManifest: dummyDigestManifest,
      guardResults: dummyGuardResults,
    })

    const validated = await updateRepairCandidateValidation(handle.db, created.id, {
      locatorValid: true,
      stepPassed: true,
      outcomePassed: true,
      crossSampleStable: true,
    })

    expect(validated.status).toBe('validated')
    expect(validated.validationScope.outcomePassed).toBe(true)
  })

  it('enforces OCC when adopting repair candidate', async () => {
    const candidateId = `rep_adopt_${newId().slice(0, 8)}`
    const created = await createRepairCandidate(handle.db, {
      candidateId,
      runId,
      sourceAttemptId,
      patchTargetRef: {
        kind: 'scenario',
        scenarioId,
        stepId,
        sourceDefinitionDigest: 'a'.repeat(64),
      },
      patch: dummyPatch,
      hypothesis: 'Adoption test',
      digestManifest: dummyDigestManifest,
      guardResults: dummyGuardResults,
    })

    // 1. Wrong revision throws conflict
    await expect(
      adoptRepairCandidate(handle.db, {
        idOrCandidateId: created.id,
        expectedRevision: 999,
        adoptedBy: accountId,
      }),
    ).rejects.toThrow()

    // 2. Correct revision (1) succeeds and bumps draft to revision 2
    const result = await adoptRepairCandidate(handle.db, {
      idOrCandidateId: created.id,
      expectedRevision: 1,
      adoptedBy: accountId,
    })

    expect(result.draftRevision).toBe(2)
    expect(result.candidate.status).toBe('adopted')
    expect(result.candidate.adoption?.expectedRevision).toBe(1)
    expect(result.candidate.adoption?.resultingRevision).toBe(2)
  })

  it('deduplicates across runs and tracks rejectedObservationCount on re-observation', async () => {
    const dedupeKey = `dedupe_${newId().slice(0, 8)}`
    const run1Id = runId
    const run2Id = runId
    const run3Id = runId

    // 1. First observation -> creates candidate
    const cand1 = await (handle.db as any).transaction(async (tx: any) => {
      return createOrUpdateRepairCandidateTx(tx, {
        candidateId: `rep_d1_${newId().slice(0, 8)}`,
        scenarioId,
        runId: run1Id,
        sourceAttemptId,
        dedupeKey,
        patchTargetRef: {
          kind: 'scenario',
          scenarioId,
          stepId,
          sourceDefinitionDigest: 'a'.repeat(64),
        },
        patch: dummyPatch,
        hypothesis: 'Dedupe test 1',
        digestManifest: dummyDigestManifest,
        guardResults: dummyGuardResults,
      })
    })

    expect(cand1.observationCount).toBe(1)
    expect(cand1.rejectedObservationCount).toBe(0)
    expect(cand1.status).toBe('proposed')

    // 2. Second observation with same dedupeKey -> increments observationCount
    const cand2 = await (handle.db as any).transaction(async (tx: any) => {
      return createOrUpdateRepairCandidateTx(tx, {
        candidateId: `rep_d2_${newId().slice(0, 8)}`,
        scenarioId,
        runId: run2Id,
        sourceAttemptId,
        dedupeKey,
        patchTargetRef: {
          kind: 'scenario',
          scenarioId,
          stepId,
          sourceDefinitionDigest: 'a'.repeat(64),
        },
        patch: dummyPatch,
        hypothesis: 'Dedupe test 2',
        digestManifest: dummyDigestManifest,
        guardResults: dummyGuardResults,
      })
    })

    expect(cand2.id).toBe(cand1.id)
    expect(cand2.observationCount).toBe(2)
    expect(cand2.rejectedObservationCount).toBe(0)
    expect(cand2.lastSeenRunId).toBe(run2Id)

    // 3. Reject candidate
    const rejected = await rejectRepairCandidate(handle.db, cand1.id, {
      actor: accountId,
      reason: '定位选择器不符预期',
    })
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejection?.rejectedBy).toBe(accountId)
    expect(rejected.rejection?.reason).toBe('定位选择器不符预期')

    // 4. Third observation after rejection -> increments rejectedObservationCount
    const cand3 = await (handle.db as any).transaction(async (tx: any) => {
      return createOrUpdateRepairCandidateTx(tx, {
        candidateId: `rep_d3_${newId().slice(0, 8)}`,
        scenarioId,
        runId: run3Id,
        sourceAttemptId,
        dedupeKey,
        patchTargetRef: {
          kind: 'scenario',
          scenarioId,
          stepId,
          sourceDefinitionDigest: 'a'.repeat(64),
        },
        patch: dummyPatch,
        hypothesis: 'Dedupe test 3',
        digestManifest: dummyDigestManifest,
        guardResults: dummyGuardResults,
      })
    })

    expect(cand3.id).toBe(cand1.id)
    expect(cand3.observationCount).toBe(3)
    expect(cand3.rejectedObservationCount).toBe(1)
    expect(cand3.status).toBe('rejected')

    // 5. Reopen candidate -> resets rejectedObservationCount and transitions to proposed
    const reopened = await reopenRepairCandidate(handle.db, cand1.id, {
      actor: accountId,
      comment: '重新评估后放行',
    })
    expect(reopened.status).toBe('proposed')
    expect(reopened.rejectedObservationCount).toBe(0)
    expect(reopened.reopenHistory).toHaveLength(1)
    expect(reopened.reopenHistory?.[0]?.reopenedBy).toBe(accountId)
  })

  it('lists candidates by scenario and expires them on publish', async () => {
    const listBefore = await listRepairCandidatesByScenario(handle.db, scenarioId)
    expect(listBefore.length).toBeGreaterThan(0)

    // Expire on publish
    await (handle.db as any).transaction(async (tx: any) => {
      await expireRepairCandidatesOnPublishTx(tx, scenarioId)
    })

    const listAfter = await listRepairCandidatesByScenario(handle.db, scenarioId, {
      status: 'expired',
    })
    expect(listAfter.length).toBeGreaterThan(0)
    expect(listAfter.every((c) => c.status === 'expired')).toBe(true)
  })

  it('detects step target drift and rejects adoption with REPAIR_CANDIDATE_STALE', async () => {
    const candidateId = `rep_stale_${newId().slice(0, 8)}`
    const originalTarget = {
      kind: 'locator',
      candidates: [{ by: 'css', value: '#submit-btn' }],
    }
    const originalDigest = computeTargetDigest(originalTarget)

    const created = await createRepairCandidate(handle.db, {
      candidateId,
      scenarioId,
      runId,
      sourceAttemptId,
      sourceTargetDigest: originalDigest,
      patchTargetRef: {
        kind: 'scenario',
        scenarioId,
        stepId,
        sourceDefinitionDigest: 'a'.repeat(64),
        sourceTargetDigest: originalDigest,
      },
      patch: dummyPatch,
      hypothesis: 'Stale drift test',
      digestManifest: dummyDigestManifest,
      guardResults: dummyGuardResults,
    })

    // Modify draft step target to something different
    const { scenarioDrafts } = schemaFor((handle.db as any))
    const modifiedDoc: ScenarioDocument = {
      ...sampleDoc,
      steps: [
        {
          id: stepId,
          name: 'Click Changed Submit',
          type: 'click',
          input: {
            target: {
              kind: 'locator',
              candidates: [{ by: 'xpath', value: '//button[@name="other"]' }],
            },
          },
        } as any,
      ],
    }

    const [draft] = await (handle.db as any)
      .select()
      .from(scenarioDrafts)
      .where(schemaFor((handle.db as any)).scenarioDrafts.scenarioId === scenarioId)
      .limit(1)

    // Update draft document with modified target
    await (handle.db as any)
      .update(scenarioDrafts)
      .set({
        document: modifiedDoc,
      })

    // Attempting to adopt should throw REPAIR_CANDIDATE_STALE
    await expect(
      adoptRepairCandidate(handle.db, {
        idOrCandidateId: created.id,
        expectedRevision: 2,
        adoptedBy: accountId,
      }),
    ).rejects.toThrow('草稿中这一步已被修改')
  })

  it('rejects adoption with STEP_NOT_FOUND when target step is deleted from draft', async () => {
    const candidateId = `rep_del_${newId().slice(0, 8)}`
    const created = await createRepairCandidate(handle.db, {
      candidateId,
      scenarioId,
      runId,
      sourceAttemptId,
      patchTargetRef: {
        kind: 'scenario',
        scenarioId,
        stepId: 'deleted_step_id',
        sourceDefinitionDigest: 'a'.repeat(64),
      },
      patch: dummyPatch,
      hypothesis: 'Missing step test',
      digestManifest: dummyDigestManifest,
      guardResults: dummyGuardResults,
    })

    await expect(
      adoptRepairCandidate(handle.db, {
        idOrCandidateId: created.id,
        expectedRevision: 2,
        adoptedBy: accountId,
      }),
    ).rejects.toThrow('草稿中未找到目标步骤')
  })

  it('launches validation run and settles candidate validation result upon execution finish', async () => {
    const candidateId = `rep_${newId().replace(/-/g, '').slice(0, 12)}`
    const { scenarioDrafts } = schemaFor(handle.db as any)

    // Reset draft to sampleDoc with revision 1
    await (handle.db as any)
      .update(scenarioDrafts)
      .set({
        document: sampleDoc,
        revision: 1,
      })

    const originalTarget = (sampleDoc.steps[0] as any).input.target
    const originalDigest = computeTargetDigest(originalTarget)

    const created = await createRepairCandidate(handle.db, {
      candidateId,
      scenarioId,
      runId,
      sourceAttemptId,
      sourceTargetDigest: originalDigest,
      patchTargetRef: {
        kind: 'scenario',
        scenarioId,
        stepId,
        sourceDefinitionDigest: 'a'.repeat(64),
        sourceTargetDigest: originalDigest,
      },
      patch: dummyPatch,
      hypothesis: 'Validation test hypothesis',
      digestManifest: dummyDigestManifest,
      guardResults: dummyGuardResults,
    })

    expect(created.status).toBe('proposed')

    // 1. Launch validation trial run
    const validationResult = await validateRepairCandidate(handle.db, created.id, {
      actor: { id: accountId },
    })

    expect(validationResult.runId).toBeTruthy()
    expect(validationResult.candidate.status).toBe('validating')
    expect(validationResult.candidate.validationRefs?.validationRunId).toBe(validationResult.runId)

    // 2. While in validating, user can adopt if desired
    // But let's test Worker settling validation result:
    // Case A: When step fails or locator is invalid -> returns to proposed
    await (handle.db as any).transaction(async (tx: any) => {
      await settleCandidateValidationTx(tx, {
        runId: validationResult.runId,
        validationSubject: { candidateId: created.candidateId, stepId },
        runStatus: 'FAILED',
        outcomeStatus: 'FAIL',
        now: new Date(),
      })
    })

    const afterFailedValidation = await getRepairCandidate(handle.db, created.id)
    expect(afterFailedValidation?.status).toBe('proposed')
    expect(afterFailedValidation?.validationScope.stepPassed).toBe(false)

    // 3. Launch validation again
    const run2 = await validateRepairCandidate(handle.db, created.id, {
      actor: { id: accountId },
    })
    expect(run2.candidate.status).toBe('validating')

    // Simulate stepRun succeeded with first candidate matching uniquely
    const { stepRuns, attempts, evidences } = schemaFor(handle.db as any)
    await (handle.db as any)
      .update(stepRuns)
      .set({
        status: 'SUCCEEDED',
        finishedAt: new Date(),
      })
      .where(and(eq(stepRuns.runId, run2.runId), eq(stepRuns.stepId, stepId)))

    const [stepRun] = await (handle.db as any)
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, run2.runId), eq(stepRuns.stepId, stepId)))

    const attemptId = newId()
    await insertRows(handle.db as any, attempts, {
      id: attemptId,
      stepRunId: stepRun.id,
      attemptNo: 1,
      status: 'SUCCEEDED',
      startedAt: new Date(),
      finishedAt: new Date(),
    })

    await insertRows(handle.db as any, evidences, {
      id: newId(),
      runId: run2.runId,
      stepRunId: stepRun.id,
      attemptId,
      type: 'log',
      status: 'available',
      schemaVersion: 1,
      payload: {
        candidatesTried: [{ index: 0, by: 'role', value: 'button[name="Submit"]', matches: 1 }],
        resolvedVia: 'rule',
      },
      createdAt: new Date(),
    })

    // Settle validation with SUCCEEDED and PASS
    await (handle.db as any).transaction(async (tx: any) => {
      await settleCandidateValidationTx(tx, {
        runId: run2.runId,
        validationSubject: { candidateId: created.candidateId, stepId },
        runStatus: 'SUCCEEDED',
        outcomeStatus: 'PASS',
        now: new Date(),
      })
    })

    const validatedCand = await getRepairCandidate(handle.db, created.id)
    expect(validatedCand?.status).toBe('validated')
    expect(validatedCand?.validationScope.locatorValid).toBe(true)
    expect(validatedCand?.validationScope.stepPassed).toBe(true)
    expect(validatedCand?.validationScope.outcomePassed).toBe(true)
  })
})
