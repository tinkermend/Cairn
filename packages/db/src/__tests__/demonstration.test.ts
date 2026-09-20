import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseDemonstrationFile } from '@cairn/authoring'
import {
  AI_ATOMIC_ACTIONS_PROTOCOL,
  IMPORTED_OUTCOME_PROTOCOL,
  OUTCOME_MANIFEST_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  DEMONSTRATION_PROTOCOL,
  normalizeAuthoringDocument,
  syncSha256Bytes,
  type AiExecutionConfig,
  type ApplyDemonstrationBody,
  type DemonstrationSource,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  createScenarioWithVersion,
  prepareTrialVersion,
  publishScenarioDraft,
} from '../runs/scenarios.js'
import {
  createDemonstration,
  getDemonstration,
  previewDemonstrationImport,
  applyDemonstrationImport,
} from '../recordings/demonstrations.js'
import {
  claimRecordingArtifactCleanup,
  commitRecordingArtifactUpload,
  reserveRecordingArtifactUpload,
  settleRecordingArtifactCleanup,
  readRecordingArtifact,
} from '../recordings/artifacts.js'
import { assertDemonstrationExecutorRolloutTx, getScenarioValidation } from '../runs/validation.js'
import {
  createRunWithSnapshot,
  finishAttempt,
  markRunCancelled,
  requestRunCancel,
  startAttempt,
} from '../runs/runs.js'
import { claimRun, markWorkerStopped, registerWorker } from '../leases/leases.js'
import { exportDatabase, importDatabase } from '../transfer.js'
import { expose } from '../database.js'

describe.each(DRIVERS)(
  '%s demonstration transactions and generations',
  { timeout: 30_000 },
  (driver) => {
    let handle: DbHandle
    let actorId: string
    let otherId: string
    let targetId: string
    beforeAll(async () => {
      handle = await openContractDb(driver)
      const t = schemaFor(handle.db)
      actorId = newId()
      otherId = newId()
      targetId = newId()
      for (const id of [actorId, otherId])
        await handle.db
          .insert(t.consoleAccounts)
          .values({ id, displayName: '示教测试', email: `${id}@example.test`, status: 'active' })
      const [admin] = await handle.db
        .select()
        .from(t.consoleRoles)
        .where(eq(t.consoleRoles.key, 'admin'))
        .limit(1)
      for (const id of [actorId, otherId])
        await handle.db
          .insert(t.consoleAccountRoles)
          .values({
            consoleAccountId: id,
            consoleRoleId: admin!.id,
            targetScopeMode: 'all',
            targetScopeIds: [],
          })
      await handle.db
        .insert(t.targets)
        .values({
          id: targetId,
          code: `di-${newId()}`,
          name: '示教测试目标',
          entryUrl: 'https://example.test',
        })
    })
    afterAll(async () => {
      await handle?.close()
    })
    const actor = () => ({ id: actorId })
    const source = (
      flow = '      - aiInput: 订单号\n        value: 123\n      - aiTap: 查询\n      - aiAssert: 出现结果',
    ) =>
      parseDemonstrationFile({
        targetId,
        captureId: newId(),
        profile: 'midscene-yaml-flow@1',
        text: `web:\n  url: https://example.test\ntasks:\n  - name: 查询\n    flow:\n${flow}`,
      })
    const scenario = () =>
      createScenarioWithVersion(handle.db, {
        targetId,
        name: `示教 ${newId()}`,
        actor: actor(),
        steps: [
          {
            id: newId(),
            name: '初始',
            type: 'echo',
            effectType: 'READ_ONLY',
            input: { value: 'start' },
          },
        ],
      })
    const upload = (value: DemonstrationSource) =>
      createDemonstration(
        handle.db,
        {
          source: value,
          name: '订单查询',
          acknowledgedOmittedConfig: true,
          idempotencyKey: newId(),
        },
        actor(),
      )

    it('stores immutable sanitized facts without creating a Run; owner remains private', async () => {
      const t = schemaFor(handle.db)
      const before = await handle.db.select({ id: t.runs.id }).from(t.runs)
      const created = await upload(
        source('      - aiInput: 密码\n        value: secret-do-not-store'),
      )
      expect(JSON.stringify(created)).not.toContain('secret-do-not-store')
      expect(await handle.db.select({ id: t.runs.id }).from(t.runs)).toHaveLength(before.length)
      await expect(
        getDemonstration(handle.db, created.recordingDraftId, otherId),
      ).rejects.toMatchObject({ code: 'RECORDING_NOT_FOUND' })
    })

    it('atomically applies parameters and ordered outcomes, detects stale previews and cross-scenario replays', async () => {
      const current = await scenario()
      const other = await scenario()
      const recording = await upload(source())
      const request = {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        recordingDraftId: recording.recordingDraftId,
        baseRevision: current.draft!.revision,
        placement: { kind: 'start' as const },
      }
      const preview = await previewDemonstrationImport(handle.db, current.id, request, actorId)
      const body: ApplyDemonstrationBody = {
        ...request,
        idempotencyKey: newId(),
        factDigest: preview.factDigest,
        suggestionDigest: preview.suggestionDigest,
        adapterVersion: preview.adapterVersion,
        ruleVersion: preview.ruleVersion,
        decisions: preview.suggestions.map((s) => ({
          id: s.id,
          disposition: 'accept',
          ...(s.parameter ? { parameter: { key: 'orderNo', label: '订单号' } } : {}),
        })),
      }
      const applied = await applyDemonstrationImport(handle.db, current.id, body, actor())
      const doc = normalizeAuthoringDocument(applied.scenario.draft!.document)
      expect(doc.inputs).toContainEqual({ key: 'orderNo', label: '订单号' })
      expect(doc.nodes[1]).toMatchObject({
        kind: 'step',
        step: { type: 'ai_action', input: { from: 'orderNo' } },
      })
      expect(doc.nodes[2]).toMatchObject({
        outcomes: [{ provenance: 'imported', severity: 'MUST', onViolation: 'halt' }],
      })
      expect(applied.receipt.demonstration?.sourceMap.at(-1)?.contractId).toBeTruthy()
      expect(
        (await applyDemonstrationImport(handle.db, current.id, body, actor())).receipt.id,
      ).toBe(applied.receipt.id)
      await expect(
        applyDemonstrationImport(handle.db, other.id, body, actor()),
      ).rejects.toMatchObject({ code: 'RECORDING_IMPORT_CONFLICT' })
      await expect(
        previewDemonstrationImport(handle.db, current.id, request, actorId),
      ).rejects.toMatchObject({ code: 'SCENARIO_DRAFT_CONFLICT' })
      expect(
        (await getDemonstration(handle.db, recording.recordingDraftId, actorId)).factDigest,
      ).toBe(recording.factDigest)
    })

    it('rolls back every fact on an unprocessed decision', async () => {
      const current = await scenario()
      const recording = await upload(source())
      const request = {
        protocolVersion: DEMONSTRATION_PROTOCOL,
        recordingDraftId: recording.recordingDraftId,
        baseRevision: current.draft!.revision,
        placement: { kind: 'start' as const },
      }
      const preview = await previewDemonstrationImport(handle.db, current.id, request, actorId)
      await expect(
        applyDemonstrationImport(
          handle.db,
          current.id,
          {
            ...request,
            idempotencyKey: newId(),
            factDigest: preview.factDigest,
            suggestionDigest: preview.suggestionDigest,
            adapterVersion: preview.adapterVersion,
            ruleVersion: preview.ruleVersion,
            decisions: [{ id: preview.suggestions[0]!.id, disposition: 'accept' }],
          },
          actor(),
        ),
      ).rejects.toMatchObject({ code: 'DEMONSTRATION_APPLY_INVALID' })
      const t = schemaFor(handle.db)
      expect(
        await handle.db
          .select()
          .from(t.recordingImportReceipts)
          .where(eq(t.recordingImportReceipts.scenarioId, current.id)),
      ).toHaveLength(0)
      const [draft] = await handle.db
        .select()
        .from(t.scenarioDrafts)
        .where(eq(t.scenarioDrafts.scenarioId, current.id))
      expect(draft!.revision).toBe(current.draft!.revision)
    })

    it('keeps deletion tombstones and rejects late commits; re-sweeps delayed puts', async () => {
      const value = source('      - aiTap: 查询')
      const bytes = Uint8Array.from([1, 2, 3])
      value.assetManifest.push({
        clientAssetId: 'image-1',
        kind: 'screenshot',
        digest: syncSha256Bytes(bytes),
        byteSize: bytes.length,
        width: 1,
        height: 1,
        contentType: 'image/png',
        redaction: 'locally_reviewed',
      })
      const created = await upload(value)
      const artifact = created.artifacts[0]!
      const generationId = newId()
      const reservation = await reserveRecordingArtifactUpload(
        handle.db,
        { recordingId: created.recordingDraftId, artifactId: artifact.id, generationId },
        actorId,
      )
      const objects = new Map<string, Uint8Array>()
      const later = new Date(Date.now() + 120_000)
      const candidates = await claimRecordingArtifactCleanup(handle.db, { now: later })
      expect(candidates.some((c) => c.id === generationId)).toBe(true)
      objects.delete(reservation.objectKey)
      await settleRecordingArtifactCleanup(handle.db, generationId, later)
      // A put started before the cleanup returns afterwards.
      objects.set(reservation.objectKey, bytes)
      expect(
        await commitRecordingArtifactUpload(
          handle.db,
          {
            recordingId: created.recordingDraftId,
            artifactId: artifact.id,
            generationId,
            digest: value.assetManifest[0]!.digest,
            byteSize: bytes.length,
          },
          actorId,
        ),
      ).toBe(false)
      for (const candidate of await claimRecordingArtifactCleanup(handle.db, {
        now: new Date(later.getTime() + 61_000),
      })) {
        objects.delete(candidate.objectKey)
        await settleRecordingArtifactCleanup(handle.db, candidate.id)
      }
      expect(objects.has(reservation.objectKey)).toBe(false)
      await expect(
        readRecordingArtifact(handle.db, created.recordingDraftId, artifact.id, actorId),
      ).rejects.toMatchObject({ code: 'RECORDING_ARTIFACT_NOT_AVAILABLE' })
      expect(
        (await getDemonstration(handle.db, created.recordingDraftId, actorId)).factDigest,
      ).toBe(created.factDigest)
    })

    it('uses equal trial/published subjects without rewriting existing digests or implying verification', async () => {
      const current = await scenario()
      const trial = await prepareTrialVersion(handle.db, current.id, {
        revision: current.draft!.revision,
        runInput: {},
        actor: actor(),
      })
      const published = await publishScenarioDraft(handle.db, current.id, {
        revision: current.draft!.revision,
        actor: actor(),
      })
      const t = schemaFor(handle.db)
      const [a] = await handle.db
        .select()
        .from(t.scenarioValidationSubjects)
        .where(eq(t.scenarioValidationSubjects.scenarioVersionId, trial.versionId))
      const [b] = await handle.db
        .select()
        .from(t.scenarioValidationSubjects)
        .where(eq(t.scenarioValidationSubjects.scenarioVersionId, published.published!.versionId))
      expect(a!.subjectDigest).toBe(b!.subjectDigest)
      expect((await getScenarioValidation(handle.db, current.id, actorId)).state).toBe('not_run')
    })

    it('checks AI permission against the current V2 draft instead of the old deterministic publication', async () => {
      const current = await scenario()
      const tables = schemaFor(handle.db)
      const writerId = newId()
      const roleId = newId()
      await handle.db
        .insert(tables.consoleAccounts)
        .values({ id: writerId, displayName: 'non-AI author', status: 'active' })
      await handle.db
        .insert(tables.consoleRoles)
        .values({ id: roleId, key: `di-${roleId}`, name: 'non-AI author' })
      await handle.db
        .insert(tables.consoleRolePermissions)
        .values(
          ['workflow:write', 'workflow:read', 'run:execute', 'target:read'].map((permission) => ({
            consoleRoleId: roleId,
            permission,
          })),
        )
      await handle.db
        .insert(tables.consoleAccountRoles)
        .values({
          consoleAccountId: writerId,
          consoleRoleId: roleId,
          targetScopeMode: 'all',
          targetScopeIds: [],
        })
      const document = normalizeAuthoringDocument(current.draft!.document)
      document.nodes.push({
        kind: 'step',
        step: {
          id: newId(),
          name: '查询',
          type: 'ai_action',
          effectType: 'SIDE_EFFECT',
          input: { operation: 'tap', targetDescription: '查询' },
        },
      })
      await handle.db
        .update(tables.scenarioDrafts)
        .set({ document, revision: 2 })
        .where(eq(tables.scenarioDrafts.scenarioId, current.id))
      await expect(
        prepareTrialVersion(handle.db, current.id, {
          revision: 2,
          runInput: {},
          actor: { id: writerId },
          executableTypes: ['echo', 'ai_action'],
        }),
      ).rejects.toMatchObject({ code: 'AI_EXECUTE_FORBIDDEN' })
      expect(
        await handle.db
          .select()
          .from(tables.scenarioVersions)
          .where(eq(tables.scenarioVersions.scenarioId, current.id)),
      ).toHaveLength(1)
    })

    it.each(['aiAtomicActionsProtocol', 'importedOutcomeProtocol'] as const)(
      'rejects an old live executor and filters missing capability: %s',
      async (field) => {
        const current = await scenario()
        const recording = await upload(source())
        const request = {
          protocolVersion: DEMONSTRATION_PROTOCOL,
          recordingDraftId: recording.recordingDraftId,
          baseRevision: current.draft!.revision,
          placement: { kind: 'start' as const },
        }
        const preview = await previewDemonstrationImport(handle.db, current.id, request, actorId)
        const applied = await applyDemonstrationImport(
          handle.db,
          current.id,
          {
            ...request,
            idempotencyKey: newId(),
            factDigest: preview.factDigest,
            suggestionDigest: preview.suggestionDigest,
            adapterVersion: preview.adapterVersion,
            ruleVersion: preview.ruleVersion,
            decisions: preview.suggestions.map((s) => ({ id: s.id, disposition: 'accept' })),
          },
          actor(),
        )
        await publishScenarioDraft(handle.db, current.id, {
          revision: applied.scenario.draft!.revision,
          actor: actor(),
        })
        const aiExecution: AiExecutionConfig = {
          adapter: 'midscene',
          adapterVersion: '1',
          sdkVersion: '1.12.6',
          routeId: 'browser-default',
          configVersion: '1',
          modelBaseUrl: 'https://example.test/v1',
          modelName: 'offline-fixture',
          modelFamily: 'qwen3-vl',
          promptVersion: '1',
          policyVersion: '1',
          maxCalls: 5,
          maxOutputTokens: 256,
          requestTimeoutMs: 5000,
          hangWaitMs: 50,
        }
        const created = await createRunWithSnapshot(handle.db, {
          scenarioId: current.id,
          actor: actor(),
          aiExecution,
        })
        const capability =
          field === 'aiAtomicActionsProtocol'
            ? AI_ATOMIC_ACTIONS_PROTOCOL
            : IMPORTED_OUTCOME_PROTOCOL
        const snapshot = created.detail.snapshot
        expect(snapshot.aiAtomicActionsProtocol).toBe(AI_ATOMIC_ACTIONS_PROTOCOL)
        expect(snapshot.importedOutcomeProtocol).toBe(IMPORTED_OUTCOME_PROTOCOL)
        const protocols = [
          SESSION_OCCUPANCY_PROTOCOL,
          OUTCOME_MANIFEST_PROTOCOL,
          AI_ATOMIC_ACTIONS_PROTOCOL,
          IMPORTED_OUTCOME_PROTOCOL,
        ]
        const old = {
          workerId: `di-old-${newId()}`,
          instanceId: newId(),
          capacity: 1,
          lostAfterSeconds: 60,
          protocolCapabilities: protocols.filter((p) => p !== capability),
        }
        await registerWorker(handle.db, old)
        await expect(
          assertDemonstrationExecutorRolloutTx(handle.db, snapshot),
        ).rejects.toMatchObject({ code: 'DEMONSTRATION_EXECUTOR_UPGRADE_REQUIRED' })
        await expect(
          createRunWithSnapshot(handle.db, { scenarioId: current.id, actor: actor(), aiExecution }),
        ).rejects.toMatchObject({ code: 'DEMONSTRATION_EXECUTOR_UPGRADE_REQUIRED' })
        expect(await claimRun(handle, { ...old, leaseTtlSeconds: 60 })).toBeNull()
        await markWorkerStopped(handle.db, old.workerId, old.instanceId)
        const upgraded = {
          ...old,
          workerId: `di-new-${newId()}`,
          instanceId: newId(),
          protocolCapabilities: protocols,
        }
        await registerWorker(handle.db, upgraded)
        await assertDemonstrationExecutorRolloutTx(handle.db, snapshot)
        const grant = await claimRun(handle, { ...upgraded, leaseTtlSeconds: 60 })
        expect(grant?.runId).toBe(created.detail.id)
        const contract = snapshot.outcomeManifest!.entries.find(
          (entry) => entry.provenance === 'imported',
        )!
        const stepRun = created.detail.stepRuns.find((step) => step.stepId === contract.stepId)!
        const attempt = await startAttempt(handle.db, {
          runId: created.detail.id,
          stepRunId: stepRun.id,
          grant: grant!,
          inputPayload: {},
        })
        const { rule: _rule, stepId: _stepId, ...result } = contract
        await finishAttempt(handle.db, {
          runId: created.detail.id,
          attemptId: attempt!.attemptId,
          attemptStatus: 'SUCCEEDED',
          stepRunStatus: 'SUCCEEDED',
          output: { passed: true },
          grant: grant!,
          outcomeResults: [
            { ...result, verdict: 'PASS', expected: true, actual: true, evaluatedAt: new Date() },
          ],
        })
        const tables = schemaFor(handle.db)
        expect(
          await handle.db
            .select()
            .from(tables.outcomeResults)
            .where(eq(tables.outcomeResults.attemptId, attempt!.attemptId)),
        ).toEqual([expect.objectContaining({ provenance: 'imported', verdict: 'PASS' })])
        await markRunCancelled(handle.db, created.detail.id, { grant: grant! })
        await markWorkerStopped(handle.db, upgraded.workerId, upgraded.instanceId)
      },
    )

    it('transfers immutable facts, available artifacts, receipts and trial validation associations', async () => {
      const original = handle as Awaited<ReturnType<typeof openContractDb>>
      const current = await scenario()
      const prepared = await prepareTrialVersion(handle.db, current.id, {
        revision: 1,
        runInput: {},
        actor: actor(),
      })
      const run = await createRunWithSnapshot(handle.db, {
        scenarioId: current.id,
        scenarioVersionId: prepared.versionId,
        allowTrialVersion: true,
        actor: actor(),
      })
      await requestRunCancel(handle.db, run.detail.id, actor())
      const value = source('      - aiTap: 查询')
      const bytes = Uint8Array.from([4, 5, 6])
      const digest = syncSha256Bytes(bytes)
      value.assetManifest.push({
        clientAssetId: 'retained',
        kind: 'screenshot',
        digest,
        byteSize: bytes.length,
        width: 1,
        height: 1,
        contentType: 'image/png',
        redaction: 'locally_reviewed',
      })
      const created = await upload(value)
      const generationId = newId()
      const artifactId = created.artifacts[0]!.id
      const reservation = await reserveRecordingArtifactUpload(
        handle.db,
        { recordingId: created.recordingDraftId, artifactId, generationId },
        actorId,
      )
      await commitRecordingArtifactUpload(
        handle.db,
        {
          recordingId: created.recordingDraftId,
          artifactId,
          generationId,
          digest,
          byteSize: bytes.length,
        },
        actorId,
      )
      const options = {
        writersStopped: true as const,
        allowMillisecondPrecisionLoss: true,
        verifyObject: async (object: { objectKey: string; digest: string; byteSize: number }) => {
          expect(object).toEqual({
            objectKey: reservation.objectKey,
            digest: `sha256:${digest}`,
            byteSize: bytes.length,
          })
        },
      }
      const bundle = await exportDatabase(expose(original), original.env, options)
      expect(bundle.tables.runValidationContexts).toHaveLength(1)
      const targetDriver = DRIVERS.find((candidate) => candidate !== driver) ?? driver
      const restored = await openContractDb(targetDriver)
      try {
        await importDatabase(expose(restored), restored.env, bundle, options)
        expect(await getDemonstration(restored.db, created.recordingDraftId, actorId)).toEqual(
          await getDemonstration(handle.db, created.recordingDraftId, actorId),
        )
        expect(await getScenarioValidation(restored.db, current.id, actorId)).toEqual(
          await getScenarioValidation(handle.db, current.id, actorId),
        )
        expect(
          await restored.db.select().from(schemaFor(restored.db).recordingImportReceipts),
        ).toHaveLength(bundle.tables.recordingImportReceipts!.length)
      } finally {
        await restored.close()
      }
    })
  },
)
