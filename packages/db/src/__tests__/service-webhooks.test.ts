import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  createAccountBodySchema,
  createTargetBodySchema,
  serviceCallerBodySchema,
  type Step,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'

const handles: DbHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.close()
})

const echo: Step = {
  id: api.newId(),
  name: '读取订单状态',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'ok' },
}

async function fixture(driver: (typeof DRIVERS)[number]) {
  const handle = await openContractDb(driver)
  handles.push(handle)
  const db = expose(handle)
  const rbac = new api.RbacStore(db, {
    hash: async (value) => value,
    verify: async (value, hash) => value === hash,
  })
  const adminRole = (await rbac.listRoles()).items.find(
    (role) => role.key === 'admin',
  )!
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: `wh-${api.newId().slice(0, 8)}@x.test`,
      displayName: 'Webhook 管理员',
      password: 'test-password',
      roleIds: [adminRole.id],
    }),
    null,
  )
  const targets = new api.TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: `webhook-${api.newId().slice(0, 8)}`,
      name: 'Webhook 测试目标',
      entryUrl: 'https://example.com',
      account: {
        username: 'tester',
        displayName: '测试账号',
        password: 'hidden',
        validity: { mode: 'permanent' },
      },
    }),
    actor,
  )
  const account = (await targets.listAccounts(target.id)).items[0]!
  const scenario = await api.createScenarioWithVersion(db, {
    targetId: target.id,
    name: '订单状态同步',
    actor,
    steps: [echo],
  })
  const version = (await api.listScenarioVersions(db, scenario.id)).items[0]!
  const caller = (
    await api.saveServiceCaller(
      db,
      null,
      serviceCallerBodySchema.parse({
        name: 'Webhook 外部应用',
        owner: '业务方',
        runTimeoutSeconds: 600,
      }),
      actor,
    )
  ).caller
  const issued = await api.issueServiceCredential(
    db,
    caller.id,
    {
      name: 'Webhook Key',
      scopes: ['run:execute', 'run:read', 'evidence:read'],
      grants: [
        {
          targetId: target.id,
          allowAnonymous: true,
          accountIds: [account.id],
        },
      ],
      expiresInDays: 30,
    },
    actor,
  )
  const principal = await api.authenticateService(db, `Bearer ${issued.token}`)
  return {
    handle,
    db,
    actor,
    target,
    account,
    scenario,
    version,
    caller,
    principal,
  }
}

describe.each(DRIVERS)('%s service webhook facts', (driver) => {
  it('creates immutable delivery facts, exposes only released outputs, retries with a durable id and supports manual replay', async () => {
    const f = await fixture(driver)
    const secret = { id: api.newId(), ciphertext: Buffer.from('sealed-secret') }
    const config = await api.saveServiceWebhook(
      f.db,
      f.caller.id,
      {
        url: 'https://hooks.example.test/cairn',
        events: ['run.started', 'run.completed'],
        enabled: true,
        secret: 'never persisted in this DTO',
      },
      f.actor,
      secret,
    )
    expect(config).toMatchObject({
      callerId: f.caller.id,
      host: 'hooks.example.test',
      secretConfigured: true,
      status: 'active',
    })
    expect(JSON.stringify(config)).not.toContain('never persisted')
    expect(JSON.stringify(await api.getServiceWebhook(f.db, f.caller.id, f.actor))).not.toContain(
      'sealed-secret',
    )

    const run = await api.createServiceRun(
      f.db,
      f.principal,
      {
        scenarioId: f.scenario.id,
        scenarioVersionId: f.version.id,
        targetAccountId: f.account.id,
        input: { internalOrderToken: 'do-not-publish' },
        idempotencyKey: 'webhook-order-001',
      },
      'webhook-test',
    )
    const schema = schemaFor(f.handle.db)
    // The callback was enabled before this Run transition. Use the persisted
    // configuration time rather than the host clock so PostgreSQL transaction
    // timestamps and MySQL wall-clock timestamps are both ordered correctly.
    const startedAt = new Date(new Date(config.createdAt).getTime() + 1_000)
    const finishedAt = new Date(startedAt.getTime() + 15_000)
    await f.handle.db
      .update(schema.runs)
      .set({
        status: 'SUCCEEDED',
        startedAt,
        finishedAt,
        evidenceStatus: 'COMPLETE',
      })
      .where(eq(schema.runs.id, run.detail.id))
    await f.handle.db.insert(schema.evidences).values([
      {
        id: api.newId(),
        runId: run.detail.id,
        stepRunId: run.detail.stepRuns[0]!.id,
        type: 'output',
        status: 'available',
        payload: { orderStatus: 'SHIPPED', trackingNo: 'SF12345678' },
        externalAccess: 1,
      },
      {
        id: api.newId(),
        runId: run.detail.id,
        stepRunId: run.detail.stepRuns[0]!.id,
        type: 'output',
        status: 'available',
        payload: { internal: 'not released' },
        externalAccess: 0,
      },
    ])

    const firstEnqueue = await api.enqueueServiceWebhookDeliveries(f.db)
    expect(firstEnqueue).toEqual({ inserted: 2 })
    expect(await api.enqueueServiceWebhookDeliveries(f.db)).toEqual({ inserted: 0 })
    const listed = await api.listServiceWebhookDeliveries(
      f.db,
      f.caller.id,
      { limit: 20 },
      f.actor,
    )
    expect(listed.items).toHaveLength(2)
    const started = listed.items.find((item) => item.eventType === 'run.started')!
    const completed = listed.items.find((item) => item.eventType === 'run.completed')!
    expect(started.payload.data).toMatchObject({
      status: 'RUNNING',
      finishedAt: null,
      durationSeconds: null,
      outputs: [],
      evidenceSummary: { status: 'PENDING', availableCount: 0 },
    })
    expect(completed.payload.data).toMatchObject({
      status: 'COMPLETED',
      idempotencyKey: 'webhook-order-001',
      outputs: [
        {
          stepName: '读取订单状态',
          payload: { orderStatus: 'SHIPPED', trackingNo: 'SF12345678' },
        },
      ],
      evidenceSummary: { status: 'COMPLETE', availableCount: 2 },
    })
    expect(JSON.stringify(completed.payload)).not.toContain('do-not-publish')
    expect(JSON.stringify(completed.payload)).not.toContain('not released')

    const worker = { workerId: `webhook-${api.newId()}`, instanceId: api.newId() }
    await api.registerWorker(f.db, {
      ...worker,
      capacity: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [SERVICE_WEBHOOK_DELIVERY_PROTOCOL],
    })
    let last: Awaited<ReturnType<typeof api.finishServiceWebhookDelivery>> | null = null
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const [job] = (await api.claimServiceWebhookDeliveries(f.db, {
        ...worker,
        limit: 20,
        now: new Date(Date.now() + 1_000),
      })).filter((item) => item.delivery.id === completed.id)
      expect(job).toBeDefined()
      expect(await api.beginServiceWebhookSubmission(f.db, job!)).toEqual({ attempt })
      last = await api.finishServiceWebhookDelivery(f.db, job!, {
        ok: false,
        retryable: true,
        responseCode: 503,
        errorCode: 'webhook_rejected',
      })
      if (attempt < 5) {
        expect(last).toMatchObject({ status: 'retrying', attempts: attempt })
        await f.handle.db
          .update(schema.serviceWebhookDeliveries)
          .set({ nextRetryAt: new Date(0) })
          .where(eq(schema.serviceWebhookDeliveries.id, completed.id))
      }
    }
    expect(last).toMatchObject({
      status: 'dead_letter',
      attempts: 5,
      nextRetryAt: null,
      lastResponseCode: 503,
    })
    const replayed = await api.retryServiceWebhookDelivery(
      f.db,
      f.caller.id,
      completed.id,
      f.actor,
    )
    expect(replayed).toMatchObject({
      status: 'pending',
      attempts: 0,
      replayCount: 1,
      lastResponseCode: null,
    })
  })

  it('fences a changed destination, permits disabled configuration during staged rollout, and blocks an enabled write while a legacy worker is live', async () => {
    const f = await fixture(driver)
    const legacy = { workerId: `legacy-${api.newId()}`, instanceId: api.newId() }
    await api.registerWorker(f.db, {
      ...legacy,
      capacity: 1,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    await expect(
      api.saveServiceWebhook(
        f.db,
        f.caller.id,
        {
          url: 'https://hooks.example.test/active',
          events: ['run.completed'],
          enabled: true,
          secret: 'secret',
        },
        f.actor,
        { id: api.newId(), ciphertext: Buffer.from('sealed') },
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_WEBHOOK_ROLLOUT_REQUIRED' })
    await expect(
      api.saveServiceWebhook(
        f.db,
        f.caller.id,
        {
          url: 'https://hooks.example.test/disabled',
          events: ['run.completed'],
          enabled: false,
          secret: 'secret',
        },
        f.actor,
        { id: api.newId(), ciphertext: Buffer.from('sealed') },
      ),
    ).resolves.toMatchObject({ status: 'disabled' })
  })
})
