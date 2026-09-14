import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  createAccountBodySchema,
  createTargetBodySchema,
  serviceCallerBodySchema,
  type Step,
} from '@cairn/shared'
import { listOperationAuditEvents } from '../audit/list.js'
import * as api from '../index.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { openContractDb, DRIVERS } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
const handles: DbHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.close()
})
const echo: Step = {
  id: api.newId(),
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}
async function fixture(driver: (typeof DRIVERS)[number], timeout = 600, steps: Step[] = [echo]) {
  const h = await openContractDb(driver)
  handles.push(h)
  const db = expose(h)
  const rbac = new api.RbacStore(db, {
    hash: async (s: string) => s,
    verify: async (s: string, hash: string) => s === hash,
  })
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: 'services-admin',
      displayName: '管理员',
      password: 'test-password',
    }),
    null,
  )
  const targets = new api.TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: 'service-test',
      name: '目标',
      entryUrl: 'https://example.com',
      account: { username: 'tester', displayName: '测试账号', password: 'hidden' },
    }),
    actor,
  )
  const account = (await targets.listAccounts(target.id)).items[0]!
  const scenario = await api.createScenarioWithVersion(db, {
    targetId: target.id,
    name: '场景',
    steps,
    actor,
  })
  const versions = await api.listScenarioVersions(db, scenario.id)
  const caller = (
    await api.saveServiceCaller(
      db,
      null,
      serviceCallerBodySchema.parse({
        name: '外部应用',
        owner: '业务方',
        runTimeoutSeconds: timeout,
      }),
      actor,
    )
  ).caller
  const policy = {
    name: '主 Key',
    scopes: ['run:execute', 'run:read', 'run:cancel', 'evidence:read'] as const,
    grants: [{ targetId: target.id, allowAnonymous: true, accountIds: [account.id] }],
  }
  const key = await api.issueServiceCredential(
    db,
    caller.id,
    { ...policy, scopes: [...policy.scopes], expiresInDays: 90 },
    actor,
  )
  const principal = await api.authenticateService(db, `Bearer ${key.token}`)
  const body = {
    scenarioId: scenario.id,
    scenarioVersionId: versions.items[0]!.id,
    targetAccountId: account.id,
    input: {},
    idempotencyKey: 'first-key',
  }
  return { h, db, actor, targets, target, account, scenario, caller, policy, key, principal, body }
}
describe.each(DRIVERS)('%s controlled service execution', (driver) => {
  it.each(['deadline-after-yield', 'deadline-before-yield', 'deadline-lease-loss', 'deadline-owner-cancel', 'manual-cancel'])(
    '%s preserves unknown side effects and closes safe orphan attempts',
    async (mode) => {
      for (const sideEffect of [true, false]) {
        const step: Step = sideEffect
          ? { id: api.newId(), name: '提交', type: 'click', effectType: 'SIDE_EFFECT',
              input: { target: { framePath: [], candidates: [{ by: 'css', value: '#submit' }] } } }
          : { ...echo, id: api.newId() }
        const f = await fixture(driver, mode === 'manual-cancel' ? 600 : 1,
          [step, { ...echo, id: api.newId() }])
        const run = await api.createServiceRun(f.db, f.principal, f.body, 'orphan-review')
        const worker = { workerId: api.newId(), instanceId: api.newId() }
        await api.registerWorker(f.db, { ...worker, capacity: 2, lostAfterSeconds: 60 })
        const grant = (await api.claimRun(f.db, { ...worker, leaseTtlSeconds: 60 }))!
        const started = (await api.startAttempt(f.db, {
          runId: grant.runId, stepRunId: run.detail.stepRuns[0]!.id, inputPayload: {}, grant,
        }))!
        if (mode === 'deadline-after-yield' || mode === 'manual-cancel')
          await api.yieldUnfinishedRun(f.db, grant)
        if (mode === 'manual-cancel') await api.getServiceRun(f.db, f.principal, grant.runId, true)
        else {
          await new Promise((resolve) => setTimeout(resolve, 1100))
          await api.expireRunDeadlines(f.db)
          if (mode !== 'deadline-after-yield') {
            expect((await api.getServiceRun(f.db, f.principal, grant.runId)).status).toBe('RUNNING')
            if (mode === 'deadline-before-yield') await api.yieldUnfinishedRun(f.db, grant)
            else if (mode === 'deadline-owner-cancel') await api.markRunCancelled(f.db, grant.runId, { grant })
            else {
              const { runLeases } = schemaFor(f.h.db)
              await f.h.db.update(runLeases).set({ expiresAt: new Date(0) }).where(eq(runLeases.id, grant.leaseId))
              await api.expireStaleRunLeases(f.db, { limit: 10, maxRecoveries: 3 })
            }
          }
        }
        const expected = sideEffect ? 'NEEDS_REVIEW' : 'CANCELLED'
        const detail = await api.getServiceRun(f.db, f.principal, grant.runId)
        expect(detail.status).toBe(expected)
        expect(detail.finishedAt === null).toBe(sideEffect)
        expect(detail.stepRuns[0]!.status).toBe(sideEffect ? 'FAILED' : 'CANCELLED')
        expect(detail.stepRuns[0]!.attempts[0]!.status).toBe(sideEffect ? 'FAILED' : 'CANCELLED')
        if (sideEffect) expect(detail.stepRuns[0]!.attempts[0]!.errorCode).toBe('UNKNOWN')
        else expect(detail.stepRuns.every(s => s.status === 'CANCELLED')).toBe(true)
        expect((await api.getServiceCaller(f.db, f.caller.id)).caller.outstandingRuns).toBe(sideEffect ? 1 : 0)
        if (mode !== 'manual-cancel') expect(detail.cancelReason).toBe('RUN_DEADLINE_EXCEEDED')
        await api.expireRunDeadlines(f.db)
        await api.reconcileOrphanAttempts(f.db, { recoverRunId: grant.runId })
        await api.getServiceRun(f.db, f.principal, grant.runId, true)
        expect(await api.finishAttempt(f.db, {
          runId: grant.runId, attemptId: started.attemptId, grant,
          attemptStatus: 'SUCCEEDED', stepRunStatus: 'SUCCEEDED', runStatus: 'SUCCEEDED',
        })).toMatchObject({ updated: false })
        expect((await api.getServiceRun(f.db, f.principal, grant.runId)).status).toBe(expected)
      }
    },
  )
  it('keys are hashed, scopes are closed, rotation preserves idempotency and policy revocation is immediate', async () => {
    const f = await fixture(driver),
      s = schemaFor(f.h.db)
    const rows = await f.h.db.select().from(s.serviceCredentials)
    expect(JSON.stringify(rows)).not.toContain(f.key.token.split('.')[1])
    expect(rows[0]!.secretDigest).toMatch(/^[a-f0-9]{64}$/)
    await expect(api.authenticateService(f.db, `Bearer ${f.key.token}x`)).rejects.toMatchObject({
      kind: 'unauthorized',
    })
    await expect(
      api.issueServiceCredential(
        f.db,
        f.caller.id,
        { ...f.policy, scopes: ['role:write'] as never, expiresInDays: 90 },
        f.actor,
      ),
    ).rejects.toThrow()
    const first = await api.createServiceRun(f.db, f.principal, f.body, 'request-1')
    expect(first.created).toBe(true)
    const raw = await api.loadRunRow(f.db, first.detail.id)
    expect(raw).toMatchObject({
      createdByConsoleAccountId: null,
      serviceCallerId: f.caller.id,
      serviceCredentialId: f.key.credential.id,
      serviceAdmission: { requestId: 'request-1', credentialRevision: 1 },
    })
    expect(raw!.snapshot.deadlineAt).toBe(raw!.deadlineAt!.toISOString())
    expect(first.detail).not.toHaveProperty('snapshot')
    expect(first.detail.stepRuns[0]).not.toHaveProperty('input')
    const rotated = await api.issueServiceCredential(
      f.db,
      f.caller.id,
      { ...f.policy, scopes: [...f.policy.scopes], expiresInDays: 90 },
      f.actor,
    )
    const p2 = await api.authenticateService(f.db, `Bearer ${rotated.token}`)
    await f.targets.updateTarget(
      f.target.id,
      { status: 'disabled', loginFields: undefined },
      f.actor,
    )
    const replay = await api.createServiceRun(f.db, p2, f.body, 'request-2')
    expect(replay.created).toBe(false)
    expect(replay.detail.id).toBe(first.detail.id)
    await expect(
      api.createServiceRun(f.db, p2, { ...f.body, input: { different: true } }, 'request-3'),
    ).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_CONFLICT' })
    await api.updateServiceCredential(
      f.db,
      f.caller.id,
      rotated.credential.id,
      { ...f.policy, scopes: [...f.policy.scopes], grants: [] },
      f.actor,
    )
    await expect(api.getServiceRun(f.db, p2, first.detail.id)).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
    await api.updateServiceCredential(f.db, f.caller.id, f.key.credential.id, null, f.actor)
    await expect(api.authenticateService(f.db, `Bearer ${f.key.token}`)).rejects.toMatchObject({
      kind: 'unauthorized',
    })
    const audit = await listOperationAuditEvents(f.h.db, { limit: 100 })
    expect(audit.items.find((a) => a.action === 'run.create')?.actor).toMatchObject({
      id: f.caller.id,
      kind: 'service',
      credentialId: f.key.credential.id,
    })
  })
  it('concurrent requests deduplicate, share caller capacity and cannot cross caller/target/account boundaries', async () => {
    const f = await fixture(driver)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api.createServiceRun(f.db, f.principal, f.body, 'parallel')),
    )
    expect(new Set(results.map((r) => r.detail.id)).size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    const second = await api.createServiceRun(
      f.db,
      f.principal,
      { ...f.body, idempotencyKey: 'second-key' },
      'parallel',
    )
    await expect(
      api.createServiceRun(
        f.db,
        f.principal,
        { ...f.body, idempotencyKey: 'third-key' },
        'parallel',
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_RUN_CAPACITY' })
    expect((await api.createServiceRun(f.db, f.principal, f.body, 'replay-full')).created).toBe(
      false,
    )
    expect((await api.listServiceRuns(f.db, f.principal, { limit: 1 })).nextCursor).toBeTruthy()
    const outsider = (
      await api.saveServiceCaller(
        f.db,
        null,
        serviceCallerBodySchema.parse({ name: '另一个调用方', owner: '其他方' }),
        f.actor,
      )
    ).caller
    const key = await api.issueServiceCredential(
      f.db,
      outsider.id,
      { ...f.policy, scopes: [...f.policy.scopes], expiresInDays: 1 },
      f.actor,
    )
    const p2 = await api.authenticateService(f.db, `Bearer ${key.token}`)
    await expect(api.getServiceRun(f.db, p2, second.detail.id, true)).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
    expect((await api.listServiceRuns(f.db, p2, { limit: 20 })).items).toEqual([])
    await expect(
      api.createServiceRun(f.db, p2, { ...f.body, targetAccountId: api.newId() }, 'scope'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SCOPE_DENIED' })
    await api.updateServiceCredential(
      f.db,
      outsider.id,
      key.credential.id,
      { name: '无授权', scopes: ['run:execute'], grants: [] },
      f.actor,
    )
    await expect(api.createServiceRun(f.db, p2, f.body, 'scope')).rejects.toMatchObject({
      code: 'TARGET_SCOPE_DENIED',
    })
    await api.getServiceRun(f.db, f.principal, second.detail.id, true)
    expect(
      (
        await api.createServiceRun(
          f.db,
          f.principal,
          { ...f.body, idempotencyKey: 'third-key' },
          'released',
        )
      ).created,
    ).toBe(true)
  })
  it('database rate windows survive business failures; screenshots require explicit release and current authority', async () => {
    const f = await fixture(driver),
      s = schemaFor(f.h.db)
    const run = await api.createServiceRun(f.db, f.principal, f.body, 'evidence')
    const evidenceId = api.newId()
    const object = await api.reserveStoredObject(f.db, {
      runId: run.detail.id,
      retainUntil: new Date(Date.now() + 3600000),
    })
    await api.commitStoredObject(f.db, {
      id: object.id,
      contentType: 'image/png',
      byteSize: 1,
      digest: 'sha256:' + 'a'.repeat(64),
    })
    await f.h.db.insert(s.evidences).values({
      id: evidenceId,
      runId: run.detail.id,
      type: 'screenshot',
      contentType: 'image/png',
      objectKey: object.objectKey,
      objectId: object.id,
    })
    expect(
      (await api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 20 })).items,
    ).toEqual([])
    await api.releaseServiceEvidence(f.db, run.detail.id, evidenceId, true, f.actor)
    const listing = await api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 20 })
    expect(listing.items).toHaveLength(1)
    expect(JSON.stringify(listing)).not.toContain(object.objectKey)
    await api.releaseServiceEvidence(f.db, run.detail.id, evidenceId, false, f.actor)
    await expect(
      api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 20 }, evidenceId),
    ).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' })
    // Strict governance bodies do not accept response-only fields.
    await api.saveServiceCaller(
      f.db,
      f.caller.id,
      serviceCallerBodySchema.parse({
        name: f.caller.name,
        owner: f.caller.owner,
        requestsPerMinute: 2,
      }),
      f.actor,
    )
    await api.authenticateService(f.db, `Bearer ${f.key.token}`)
    await expect(api.authenticateService(f.db, `Bearer ${f.key.token}`)).rejects.toMatchObject({
      code: 'SERVICE_RATE_LIMIT',
    })
  })
  it('expiry, malformed grants, AI privilege and revocation/admission races fail closed', async () => {
    const f = await fixture(driver),
      s = schemaFor(f.h.db)
    await expect(
      api.issueServiceCredential(
        f.db,
        f.caller.id,
        {
          ...f.policy,
          scopes: [...f.policy.scopes],
          grants: [{ targetId: f.target.id, accountIds: [api.newId()], allowAnonymous: false }],
          expiresInDays: 1,
        },
        f.actor,
      ),
    ).rejects.toMatchObject({ code: 'GRANT_ACCOUNT_MISMATCH' })
    expect((await api.getServiceCaller(f.db, f.caller.id)).credentials).toHaveLength(1)
    const aiScenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: 'AI 权限验收',
      actor: f.actor,
      steps: [
        {
          id: api.newId(),
          name: '判断',
          type: 'ai_assert',
          effectType: 'READ_ONLY',
          input: { instruction: '页面正确' },
        },
      ],
    })
    const version = (await api.listScenarioVersions(f.db, aiScenario.id)).items[0]!
    await expect(
      api.createServiceRun(
        f.db,
        f.principal,
        { ...f.body, scenarioId: aiScenario.id, scenarioVersionId: version.id },
        'ai-scope',
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_SCOPE_DENIED' })
    const race = await Promise.allSettled([
      api.createServiceRun(f.db, f.principal, f.body, 'revoke-race'),
      api.updateServiceCredential(f.db, f.caller.id, f.key.credential.id, null, f.actor),
    ])
    expect(race[1]!.status).toBe('fulfilled')
    if (race[0]!.status === 'rejected')
      expect(race[0]!.reason).toMatchObject({ kind: 'unauthorized' })
    await expect(
      api.createServiceRun(
        f.db,
        f.principal,
        { ...f.body, idempotencyKey: 'after-revoke' },
        'revoked',
      ),
    ).rejects.toMatchObject({ kind: 'unauthorized' })
    const expiring = await api.issueServiceCredential(
      f.db,
      f.caller.id,
      { ...f.policy, scopes: [...f.policy.scopes], expiresInDays: 1 },
      f.actor,
    )
    await f.h.db
      .update(s.serviceCredentials)
      .set({ expiresAt: new Date('2000-01-01') })
      .where(eq(s.serviceCredentials.id, expiring.credential.id))
    await expect(api.authenticateService(f.db, `Bearer ${expiring.token}`)).rejects.toMatchObject({
      kind: 'unauthorized',
    })
  })
  it('service identity, grants, cancellation, deadline and audit survive database transfer', async () => {
    const f = await fixture(driver)
    const run = await api.createServiceRun(f.db, f.principal, f.body, 'transfer-run')
    await api.getServiceRun(f.db, f.principal, run.detail.id, true)
    const { exportDatabase, importDatabase } = await import('../transfer.js')
    const options = { writersStopped: true as const, allowMillisecondPrecisionLoss: true }
    const bundle = await exportDatabase(f.db, f.h.env, options)
    const target = await openContractDb(DRIVERS[(DRIVERS.indexOf(driver) + 1) % DRIVERS.length]!)
    handles.push(target)
    const targetDb = expose(target)
    await importDatabase(targetDb, target.env, bundle, options)
    const actor = await api.authenticateService(targetDb, `Bearer ${f.key.token}`)
    expect((await api.getServiceRun(targetDb, actor, run.detail.id)).status).toBe('CANCELLED')
    expect((await api.getServiceCaller(targetDb, f.caller.id)).credentials[0]!.grants).toEqual(
      f.key.credential.grants,
    )
    expect((await api.createServiceRun(targetDb, actor, f.body, 'after-transfer')).created).toBe(
      false,
    )
    expect((await api.loadRunRow(targetDb, run.detail.id))!.serviceAdmission).toMatchObject({
      requestId: 'transfer-run',
    })
  })
  it('deadlines cover queued and active runs; DB enforces actor pairs and immutable admission', async () => {
    const f = await fixture(driver, 1),
      s = schemaFor(f.h.db)
    const first = await api.createServiceRun(f.db, f.principal, f.body, 'deadline')
    const worker = { workerId: api.newId(), instanceId: api.newId() }
    await api.registerWorker(f.db, { ...worker, capacity: 2, lostAfterSeconds: 60 })
    const grant = (await api.claimRun(f.db, { ...worker, leaseTtlSeconds: 60 }))!
    const started = (await api.startAttempt(f.db, {
      runId: grant.runId,
      stepRunId: first.detail.stepRuns[0]!.id,
      inputPayload: {},
      grant,
    }))!
    const queued = await api.createServiceRun(
      f.db,
      f.principal,
      { ...f.body, idempotencyKey: 'queued-key' },
      'deadline',
    )
    const [row] = await f.h.db.select().from(s.runs).where(eq(s.runs.id, first.detail.id))
    await expect(
      f.h.db
        .update(s.runs)
        .set({ createdByConsoleAccountId: f.actor.id })
        .where(eq(s.runs.id, row!.id)),
    ).rejects.toThrow()
    await expect(
      f.h.db
        .update(s.runs)
        .set({ serviceAdmission: { ...row!.serviceAdmission!, credentialRevision: 2 } })
        .where(eq(s.runs.id, row!.id)),
    ).rejects.toThrow()
    await expect(
      f.h.db.insert(s.runs).values({
        ...row!,
        id: api.newId(),
        createdByConsoleAccountId: f.actor.id,
        idempotencyKey: 'invalid-key',
      }),
    ).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 1100))
    await api.expireRunDeadlines(f.db)
    expect(await api.getServiceRun(f.db, f.principal, queued.detail.id)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'RUN_DEADLINE_EXCEEDED',
    })
    const result = await api.finishAttempt(f.db, {
      runId: grant.runId,
      attemptId: started.attemptId,
      attemptStatus: 'SUCCEEDED',
      stepRunStatus: 'SUCCEEDED',
      runStatus: 'SUCCEEDED',
      grant,
    })
    expect(result.cancelled).toBe(true)
    expect((await api.getServiceRun(f.db, f.principal, first.detail.id)).status).toBe('CANCELLED')
    expect(await api.claimRun(f.db, { ...worker, leaseTtlSeconds: 60 })).toBeNull()
  })
})

it('SQLite upgrade preserves pre-service Run/StepRun/Evidence rows and their foreign keys', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { readFileSync, readdirSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const db = new DatabaseSync(':memory:')
  try {
    const dir = resolve(import.meta.dirname, '../../migrations/sqlite')
    for (const file of readdirSync(dir)
      .sort()
      .filter((f) => f.endsWith('.sql') && f < '0005'))
      db.exec(readFileSync(resolve(dir, file), 'utf8'))
    db.exec(`
      INSERT INTO console_accounts(id,display_name) VALUES('old-actor','历史用户');
      INSERT INTO targets(id,code,name,entry_url) VALUES('old-target','old','历史目标','https://example.com');
      INSERT INTO scenarios(id,target_id,name,created_by_console_account_id) VALUES('old-scenario','old-target','历史场景','old-actor');
      INSERT INTO scenario_versions(id,scenario_id,version_no,definition,created_by_console_account_id,kind,source_digest) VALUES('old-version','old-scenario',1,'{}','old-actor','published','old-source-digest');
      INSERT INTO runs(id,target_id,scenario_id,scenario_version_id,created_by_console_account_id,status,snapshot,snapshot_digest,context) VALUES('old-run','old-target','old-scenario','old-version','old-actor','SUCCEEDED','{"old":true}','historical-digest','{}');
      INSERT INTO step_runs(id,run_id,step_id,ordinal,status) VALUES('old-step','old-run','step',0,'SUCCEEDED');
      INSERT INTO evidences(id,run_id,step_run_id,type,payload) VALUES('old-evidence','old-run','old-step','output','{"result":42}');
    `)
    const before = db.prepare('SELECT * FROM runs').get()!
    db.exec(readFileSync(resolve(dir, '0005_service_access.sql'), 'utf8'))
    expect(db.prepare('SELECT * FROM runs').get()).toMatchObject(before)
    expect(db.prepare('SELECT external_access,run_id FROM evidences').get()).toEqual({
      external_access: 0,
      run_id: 'old-run',
    })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(() => db.exec("DELETE FROM runs WHERE id='old-run'")).toThrow()
    expect(() => db.exec("UPDATE runs SET snapshot='{}' WHERE id='old-run'")).toThrow()
  } finally {
    db.close()
  }
})
