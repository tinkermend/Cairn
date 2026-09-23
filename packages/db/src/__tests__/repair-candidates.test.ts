import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  createRepairCandidate,
  getRepairCandidate,
  listRepairCandidatesByRun,
  updateRepairCandidateStatus,
  updateRepairCandidateValidation,
} from '../repair/index.js'
import { insertRows, schemaFor } from '../native.js'

describe.each(DRIVERS)('%s Repair Candidates Repository (Integration)', (driver) => {
  let handle: DbHandle
  const accountId = newId()
  const targetId = newId()
  const scenarioId = newId()
  const versionId = newId()
  const runId = newId()
  const sourceAttemptId = newId()
  const stepId = 's_target_btn'

  const sampleDoc: ScenarioDocument = {
    schemaVersion: 1,
    title: 'Repair Scenario Doc',
    steps: [
      {
        id: stepId,
        name: 'Click Submit',
        type: 'click',
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
})
