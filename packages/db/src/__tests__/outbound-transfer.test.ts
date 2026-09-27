import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  DEFAULT_OUTBOUND_POLICY,
  LOCAL_SECRET_PROVIDER,
  OUTBOUND_WORKER_PROTOCOL,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { expose } from '../database.js'
import { newId } from '../id.js'
import { insertIgnoreRows, schemaFor } from '../native.js'
import { exportDatabase, importDatabase } from '../transfer.js'
import { getOrCreatePlatformConfig } from '../platform-config/store.js'
import { writeOutboundConfig, writeOutboundPolicy } from '../outbound/config.js'
import { createOutboundTest, getOutboundEvent } from '../outbound/query.js'
import {
  claimOutboundDeliveries,
  beginOutboundSubmission,
  finishOutboundDelivery,
} from '../outbound/delivery.js'
import { repairOutboundIntents } from '../outbound/core.js'
import { createScenarioWithVersion } from '../runs/scenarios.js'
import { createRunWithSnapshot, requestRunCancel } from '../runs/runs.js'
import { registerWorker } from '../leases/index.js'
import { loadSecretCiphertext } from '../secrets/store.js'

describe.skipIf(!DRIVERS.includes('mysql'))('消息推送跨库转储与恢复', () => {
  it.each([
    ['postgres', 'mysql'],
    ['mysql', 'postgres'],
  ] as const)(
    '%s → %s 保留等待意图、未知回执、控制代次和密文引用',
    { timeout: 90_000 },
    async (from, to) => {
      const source = await openContractDb(from),
        destination = await openContractDb(to, undefined, { pristine: true })
      try {
        const t = schemaFor(source.db),
          actor = newId(),
          target = newId(),
          secretId = newId(),
          channelId = newId()
        const ciphertext = Buffer.from([0, 255, 127, 128, 1, 2])
        await source.db
          .insert(t.consoleAccounts)
          .values({
            id: actor,
            displayName: '转储管理员',
            email: `${actor}@example.test`,
            status: 'active',
          })
        const [admin] = await source.db
          .select()
          .from(t.consoleRoles)
          .where(eq(t.consoleRoles.key, 'admin'))
        for (const permission of ['outbound:read', 'outbound:operate'])
          await insertIgnoreRows(source.db, t.consoleRolePermissions, {
            consoleRoleId: admin!.id,
            permission,
          })
        await source.db
          .insert(t.consoleAccountRoles)
          .values({ consoleAccountId: actor, consoleRoleId: admin!.id, targetScopeMode: 'all' })
        await source.db
          .insert(t.targets)
          .values({
            id: target,
            code: 'transfer-outbound',
            name: '推送转储目标',
            entryUrl: 'https://example.test',
          })
        const c = await getOrCreatePlatformConfig(source.db)
        await writeOutboundConfig(source.db, {
          actorId: actor,
          expectedRevision: c.revision,
          reason: '转储测试',
          settings: { enabled: true, consoleBaseUrl: 'https://console.example.test' },
          channel: {
            id: channelId,
            name: '固定接收器',
            kind: 'webhook',
            enabled: true,
            allowAlerts: true,
            targetIds: [target],
            version: 1,
            secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId },
            host: 'hook.example.test',
            recipients: [],
            format: 'cairn.outbound@1',
            replay: 'manual_on_unknown',
          },
          secrets: [{ id: secretId, ciphertext }],
        })
        const scenario = await createScenarioWithVersion(source.db, {
          targetId: target,
          name: '转储场景',
          steps: [
            {
              id: newId(),
              name: '回显',
              type: 'echo',
              effectType: 'READ_ONLY',
              input: { value: 'fixture' },
            },
          ],
          actor: { id: actor },
        })
        await writeOutboundPolicy(source.db, scenario.id, actor, {
          expectedRevision: 0,
          reason: '转储测试',
          policy: { ...DEFAULT_OUTBOUND_POLICY, enabled: true, channelIds: [channelId] },
        })
        const run = await createRunWithSnapshot(source.db, {
          scenarioId: scenario.id,
          actor: { id: actor },
        })
        await requestRunCancel(source.db, run.detail.id, { id: actor })
        const receipt = await createOutboundTest(source.db, actor, channelId, {
          idempotencyKey: newId(),
          reason: '转储测试',
        })
        const worker = { workerId: newId(), instanceId: newId() }
        await registerWorker(source.db, {
          ...worker,
          capacity: 1,
          lostAfterSeconds: 3600,
          protocolCapabilities: [OUTBOUND_WORKER_PROTOCOL],
        })
        const [job] = await claimOutboundDeliveries(source.db, worker)
        await beginOutboundSubmission(source.db, job!)
        const options = { writersStopped: true as const, allowMillisecondPrecisionLoss: true }
        await expect(exportDatabase(expose(source), source.env, options)).rejects.toThrow(
          'Outbound submissions must settle',
        )
        await finishOutboundDelivery(source.db, job!, {
          outcome: 'unknown',
          errorCode: 'webhook_receipt_unknown',
        })
        await source.db
          .update(t.workers)
          .set({ status: 'STOPPED' })
          .where(eq(t.workers.id, worker.workerId))
        const archive = await exportDatabase(expose(source), source.env, options)
        await importDatabase(expose(destination), destination.env, archive, options)
        const restored = await getOutboundEvent(destination.db, actor, receipt.eventId)
        expect(restored.deliveries[0]).toMatchObject({
          id: job!.deliveryId,
          status: 'unknown',
          automaticAttemptCount: 1,
        })
        expect(restored.deliveries[0]?.attempts).toHaveLength(1)
        expect((await loadSecretCiphertext(destination.db, secretId))?.ciphertext).toEqual(
          ciphertext,
        )
        const dst = schemaFor(destination.db)
        const [savedRun] = await destination.db
          .select()
          .from(dst.runs)
          .where(eq(dst.runs.id, run.detail.id))
        const savedPolicy = savedRun!.snapshot.outboundPolicy ?? savedRun!.snapshot.notificationPolicy
        expect(savedPolicy?.bindings[0]?.channel.secretRef.secretId).toBe(
          secretId,
        )
        await repairOutboundIntents(destination.db)
        expect(
          await destination.db
            .select()
            .from(dst.outboundEvents)
            .where(eq(dst.outboundEvents.runId, run.detail.id)),
        ).toHaveLength(1)
        const again = await exportDatabase(expose(destination), destination.env, options)
        for (const name of [
          'outboundEvents',
          'outboundDeliveries',
          'outboundDeliveryAttempts',
          'outboundCommands',
          'outboundControls',
          'scenarioOutboundPolicies',
        ] as const)
          expect(again.tables[name]).toEqual(archive.tables[name])
      } finally {
        await destination.close()
        await source.close()
      }
    },
  )
})
