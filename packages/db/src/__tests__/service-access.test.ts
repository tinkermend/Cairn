import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  SESSION_OCCUPANCY_PROTOCOL,
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
async function fixture(
  driver: (typeof DRIVERS)[number],
  timeout = 600,
  steps: Step[] = [echo]
) {
  const h = await openContractDb(driver)
  handles.push(h)
  const db = expose(h)
  const rbac = new api.RbacStore(db, {
    hash: async (s: string) => s,
    verify: async (s: string, hash: string) => s === hash,
  })
  const adminRole = (await rbac.listRoles()).items.find(
    (role) => role.key === 'admin'
  )!
  const actor = await rbac.createAccount(
    createAccountBodySchema.parse({
      email: 'services-admin',
      displayName: '管理员',
      password: 'test-password',
      roleIds: [adminRole.id],
    }),
    null
  )
  const targets = new api.TargetsStore(db, () => Buffer.from('encrypted'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: 'service-test',
      name: '目标',
      entryUrl: 'https://example.com',
      account: {
        username: 'tester',
        displayName: '测试账号',
        password: 'hidden',
        validity: { mode: 'permanent' },
      },
    }),
    actor
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
      actor
    )
  ).caller
  const policy = {
    name: '主 Key',
    scopes: ['run:execute', 'run:read', 'run:cancel', 'evidence:read'] as const,
    grants: [
      { targetId: target.id, allowAnonymous: true, accountIds: [account.id] },
    ],
  }
  const key = await api.issueServiceCredential(
    db,
    caller.id,
    { ...policy, scopes: [...policy.scopes], expiresInDays: 90 },
    actor
  )
  const principal = await api.authenticateService(db, `Bearer ${key.token}`)
  const body = {
    scenarioId: scenario.id,
    scenarioVersionId: versions.items[0]!.id,
    targetAccountId: account.id,
    input: {},
    idempotencyKey: 'first-key',
  }
  return {
    h,
    db,
    actor,
    targets,
    target,
    account,
    scenario,
    caller,
    policy,
    key,
    principal,
    body,
  }
}
describe.each(DRIVERS)('%s controlled service execution', (driver) => {
  it.each([
    'deadline-after-yield',
    'deadline-before-yield',
    'deadline-lease-loss',
    'deadline-owner-cancel',
    'manual-cancel',
  ])(
    '%s preserves unknown side effects and closes safe orphan attempts',
    async (mode) => {
      for (const sideEffect of [true, false]) {
        const step: Step = sideEffect
          ? {
              id: api.newId(),
              name: '提交',
              type: 'click',
              effectType: 'SIDE_EFFECT',
              input: {
                target: {
                  framePath: [],
                  candidates: [{ by: 'css', value: '#submit' }],
                },
              },
            }
          : { ...echo, id: api.newId() }
        const f = await fixture(driver, mode === 'manual-cancel' ? 600 : 1, [
          step,
          { ...echo, id: api.newId() },
        ])
        const run = await api.createServiceRun(
          f.db,
          f.principal,
          f.body,
          'orphan-review'
        )
        const worker = { workerId: api.newId(), instanceId: api.newId() }
        await api.registerWorker(f.db, {
          ...worker,
          capacity: 2,
          lostAfterSeconds: 60,
          protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
        })
        const grant = (await api.claimRun(f.db, {
          ...worker,
          leaseTtlSeconds: 60,
        }))!
        const started = (await api.startAttempt(f.db, {
          runId: grant.runId,
          stepRunId: run.detail.stepRuns[0]!.id,
          inputPayload: {},
          grant,
        }))!
        if (mode === 'deadline-after-yield' || mode === 'manual-cancel')
          await api.yieldUnfinishedRun(f.db, grant)
        if (mode === 'manual-cancel')
          await api.getServiceRun(f.db, f.principal, grant.runId, true)
        else {
          await new Promise((resolve) => setTimeout(resolve, 1100))
          await api.expireRunDeadlines(f.db)
          if (mode !== 'deadline-after-yield') {
            expect(
              (await api.getServiceRun(f.db, f.principal, grant.runId)).status
            ).toBe('RUNNING')
            if (mode === 'deadline-before-yield')
              await api.yieldUnfinishedRun(f.db, grant)
            else if (mode === 'deadline-owner-cancel')
              await api.markRunCancelled(f.db, grant.runId, { grant })
            else {
              const { runLeases } = schemaFor(f.h.db)
              await f.h.db
                .update(runLeases)
                .set({ expiresAt: new Date(0) })
                .where(eq(runLeases.id, grant.leaseId))
              await api.expireStaleRunLeases(f.db, {
                limit: 10,
                maxRecoveries: 3,
              })
            }
          }
        }
        const expected = sideEffect ? 'NEEDS_REVIEW' : 'CANCELLED'
        const detail = await api.getServiceRun(f.db, f.principal, grant.runId)
        expect(detail.status).toBe(expected)
        expect(detail.finishedAt === null).toBe(sideEffect)
        expect(detail.stepRuns[0]!.status).toBe(
          sideEffect ? 'FAILED' : 'CANCELLED'
        )
        expect(detail.stepRuns[0]!.attempts[0]!.status).toBe(
          sideEffect ? 'FAILED' : 'CANCELLED'
        )
        if (sideEffect)
          expect(detail.stepRuns[0]!.attempts[0]!.errorCode).toBe('UNKNOWN')
        else
          expect(detail.stepRuns.every((s) => s.status === 'CANCELLED')).toBe(
            true
          )
        expect(
          (await api.getServiceCaller(f.db, f.caller.id)).caller.outstandingRuns
        ).toBe(sideEffect ? 1 : 0)
        if (mode !== 'manual-cancel')
          expect(detail.cancelReason).toBe('RUN_DEADLINE_EXCEEDED')
        await api.expireRunDeadlines(f.db)
        await api.reconcileOrphanAttempts(f.db, { recoverRunId: grant.runId })
        await api.getServiceRun(f.db, f.principal, grant.runId, true)
        expect(
          await api.finishAttempt(f.db, {
            runId: grant.runId,
            attemptId: started.attemptId,
            grant,
            attemptStatus: 'SUCCEEDED',
            stepRunStatus: 'SUCCEEDED',
            runStatus: 'SUCCEEDED',
          })
        ).toMatchObject({ updated: false })
        expect(
          (await api.getServiceRun(f.db, f.principal, grant.runId)).status
        ).toBe(expected)
      }
    }
  )
  it('keys are hashed, scopes are closed, rotation preserves idempotency and policy revocation is immediate', async () => {
    const f = await fixture(driver),
      s = schemaFor(f.h.db)
    const rows = await f.h.db.select().from(s.serviceCredentials)
    expect(JSON.stringify(rows)).not.toContain(f.key.token.split('.')[1])
    expect(rows[0]!.secretDigest).toMatch(/^[a-f0-9]{64}$/)
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}x`)
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    })
    await expect(
      api.issueServiceCredential(
        f.db,
        f.caller.id,
        { ...f.policy, scopes: ['role:write'] as never, expiresInDays: 90 },
        f.actor
      )
    ).rejects.toThrow()
    const first = await api.createServiceRun(
      f.db,
      f.principal,
      f.body,
      'request-1'
    )
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
      f.actor
    )
    const p2 = await api.authenticateService(f.db, `Bearer ${rotated.token}`)
    await f.targets.updateTarget(
      f.target.id,
      { status: 'disabled', loginFields: undefined },
      f.actor
    )
    const replay = await api.createServiceRun(f.db, p2, f.body, 'request-2')
    expect(replay.created).toBe(false)
    expect(replay.detail.id).toBe(first.detail.id)
    await expect(
      api.createServiceRun(
        f.db,
        p2,
        { ...f.body, input: { different: true } },
        'request-3'
      )
    ).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_CONFLICT' })
    await api.updateServiceCredential(
      f.db,
      f.caller.id,
      rotated.credential.id,
      { ...f.policy, scopes: [...f.policy.scopes], grants: [] },
      f.actor
    )
    await expect(
      api.getServiceRun(f.db, p2, first.detail.id)
    ).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
    await api.updateServiceCredential(
      f.db,
      f.caller.id,
      f.key.credential.id,
      null,
      f.actor
    )
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`)
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    })
    const audit = await listOperationAuditEvents(f.h.db, { limit: 100 })
    expect(
      audit.items.find((a) => a.action === 'run.create')?.actor
    ).toMatchObject({
      id: f.caller.id,
      kind: 'service',
      credentialId: f.key.credential.id,
    })
  })
  it('concurrent requests deduplicate, share caller capacity and cannot cross caller/target/account boundaries', async () => {
    const f = await fixture(driver)
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.createServiceRun(f.db, f.principal, f.body, 'parallel')
      )
    )
    expect(new Set(results.map((r) => r.detail.id)).size).toBe(1)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    const second = await api.createServiceRun(
      f.db,
      f.principal,
      { ...f.body, idempotencyKey: 'second-key' },
      'parallel'
    )
    await expect(
      api.createServiceRun(
        f.db,
        f.principal,
        { ...f.body, idempotencyKey: 'third-key' },
        'parallel'
      )
    ).rejects.toMatchObject({ code: 'SERVICE_RUN_CAPACITY' })
    expect(
      (await api.createServiceRun(f.db, f.principal, f.body, 'replay-full'))
        .created
    ).toBe(false)
    expect(
      (await api.listServiceRuns(f.db, f.principal, { limit: 1 })).nextCursor
    ).toBeTruthy()
    const outsider = (
      await api.saveServiceCaller(
        f.db,
        null,
        serviceCallerBodySchema.parse({
          name: '另一个调用方',
          owner: '其他方',
        }),
        f.actor
      )
    ).caller
    const key = await api.issueServiceCredential(
      f.db,
      outsider.id,
      { ...f.policy, scopes: [...f.policy.scopes], expiresInDays: 1 },
      f.actor
    )
    const p2 = await api.authenticateService(f.db, `Bearer ${key.token}`)
    await expect(
      api.getServiceRun(f.db, p2, second.detail.id, true)
    ).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
    expect((await api.listServiceRuns(f.db, p2, { limit: 20 })).items).toEqual(
      []
    )
    await expect(
      api.createServiceRun(
        f.db,
        p2,
        { ...f.body, targetAccountId: api.newId() },
        'scope'
      )
    ).rejects.toMatchObject({ code: 'ACCOUNT_SCOPE_DENIED' })
    await api.updateServiceCredential(
      f.db,
      outsider.id,
      key.credential.id,
      { name: key.credential.name, scopes: ['run:execute'], grants: [] },
      f.actor
    )
    await expect(
      api.createServiceRun(f.db, p2, f.body, 'scope')
    ).rejects.toMatchObject({
      code: 'TARGET_SCOPE_DENIED',
    })
    await api.getServiceRun(f.db, f.principal, second.detail.id, true)
    expect(
      (
        await api.createServiceRun(
          f.db,
          f.principal,
          { ...f.body, idempotencyKey: 'third-key' },
          'released'
        )
      ).created
    ).toBe(true)
  })
  it('database rate windows survive business failures; screenshots require explicit release and current authority', async () => {
    const f = await fixture(driver),
      s = schemaFor(f.h.db)
    const run = await api.createServiceRun(
      f.db,
      f.principal,
      f.body,
      'evidence'
    )
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
      (
        await api.serviceEvidence(f.db, f.principal, run.detail.id, {
          limit: 20,
        })
      ).items
    ).toEqual([])
    await api.releaseServiceEvidence(
      f.db,
      run.detail.id,
      evidenceId,
      true,
      f.actor
    )
    const listing = await api.serviceEvidence(
      f.db,
      f.principal,
      run.detail.id,
      { limit: 20 }
    )
    expect(listing.items).toHaveLength(1)
    expect(JSON.stringify(listing)).not.toContain(object.objectKey)
    await api.releaseServiceEvidence(
      f.db,
      run.detail.id,
      evidenceId,
      false,
      f.actor
    )
    await expect(
      api.serviceEvidence(
        f.db,
        f.principal,
        run.detail.id,
        { limit: 20 },
        evidenceId
      )
    ).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' })
    await api.releaseServiceEvidence(
      f.db,
      run.detail.id,
      evidenceId,
      true,
      f.actor
    )
    const videoId = api.newId()
    const videoObject = await api.reserveStoredObject(f.db, {
      runId: run.detail.id,
      retainUntil: new Date(Date.now() + 3600000),
    })
    await api.commitStoredObject(f.db, {
      id: videoObject.id,
      contentType: 'video/webm',
      byteSize: 8,
      digest: 'sha256:' + 'b'.repeat(64),
    })
    await f.h.db.insert(s.evidences).values({
      id: videoId,
      runId: run.detail.id,
      type: 'video',
      status: 'available',
      contentType: 'video/webm',
      objectKey: videoObject.objectKey,
      objectId: videoObject.id,
    })
    await expect(
      api.releaseServiceEvidence(f.db, run.detail.id, videoId, true, f.actor)
    ).rejects.toMatchObject({
      code: 'EVIDENCE_RELEASE_DENIED',
    })
    expect(
      (
        await api.serviceEvidence(f.db, f.principal, run.detail.id, {
          limit: 20,
        })
      ).items.some((item) => item.id === videoId)
    ).toBe(false)
    await f.h.db
      .update(s.runs)
      .set({ status: 'SUCCEEDED' })
      .where(eq(s.runs.id, run.detail.id))
    await api.deleteRun(f.db, run.detail.id, f.actor)
    await expect(
      api.serviceEvidence(f.db, f.principal, run.detail.id, { limit: 20 })
    ).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
    // Strict governance bodies do not accept response-only fields.
    await api.saveServiceCaller(
      f.db,
      f.caller.id,
      serviceCallerBodySchema.parse({
        name: f.caller.name,
        owner: f.caller.owner,
        requestsPerMinute: 2,
      }),
      f.actor
    )
    await api.authenticateService(f.db, `Bearer ${f.key.token}`)
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`)
    ).rejects.toMatchObject({
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
          grants: [
            {
              targetId: f.target.id,
              accountIds: [api.newId()],
              allowAnonymous: false,
            },
          ],
          expiresInDays: 1,
        },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'GRANT_ACCOUNT_MISMATCH' })
    expect(
      (await api.getServiceCaller(f.db, f.caller.id)).credentials
    ).toHaveLength(1)
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
    const version = (await api.listScenarioVersions(f.db, aiScenario.id))
      .items[0]!
    await expect(
      api.createServiceRun(
        f.db,
        f.principal,
        { ...f.body, scenarioId: aiScenario.id, scenarioVersionId: version.id },
        'ai-scope'
      )
    ).rejects.toMatchObject({ code: 'SERVICE_SCOPE_DENIED' })
    const race = await Promise.allSettled([
      api.createServiceRun(f.db, f.principal, f.body, 'revoke-race'),
      api.updateServiceCredential(
        f.db,
        f.caller.id,
        f.key.credential.id,
        null,
        f.actor
      ),
    ])
    expect(race[1]!.status).toBe('fulfilled')
    if (race[0]!.status === 'rejected')
      expect(race[0]!.reason).toMatchObject({ kind: 'unauthorized' })
    await expect(
      api.createServiceRun(
        f.db,
        f.principal,
        { ...f.body, idempotencyKey: 'after-revoke' },
        'revoked'
      )
    ).rejects.toMatchObject({ kind: 'unauthorized' })
    const expiring = await api.issueServiceCredential(
      f.db,
      f.caller.id,
      { ...f.policy, scopes: [...f.policy.scopes], expiresInDays: 1 },
      f.actor
    )
    await f.h.db
      .update(s.serviceCredentials)
      .set({ expiresAt: new Date('2000-01-01') })
      .where(eq(s.serviceCredentials.id, expiring.credential.id))
    await expect(
      api.authenticateService(f.db, `Bearer ${expiring.token}`)
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    })
  })
  it('filters callers, keeps metadata out of authorization revisions, and gates archive on active capacity', async () => {
    const f = await fixture(driver)
    const s = schemaFor(f.h.db)
    await expect(
      api.saveServiceCaller(
        f.db,
        null,
        serviceCallerBodySchema.parse({
          name: '越权调用方',
          owner: '不应写入',
        }),
        { id: api.newId() }
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const other = await api.saveServiceCaller(
      f.db,
      null,
      serviceCallerBodySchema.parse({
        name: '另一个集成方',
        owner: '其他负责人',
      }),
      f.actor
    )
    const literal = await api.saveServiceCaller(
      f.db,
      null,
      serviceCallerBodySchema.parse({
        name: 'Order_API%\\North',
        owner: 'Q_A\\B',
      }),
      f.actor
    )
    const tiedTime = new Date('2026-09-19T00:00:00.123Z')
    await f.h.db
      .update(s.serviceCallers)
      .set({ createdAt: tiedTime, updatedAt: tiedTime })
      .where(eq(s.serviceCallers.id, f.caller.id))
    await f.h.db
      .update(s.serviceCallers)
      .set({ createdAt: tiedTime, updatedAt: tiedTime })
      .where(eq(s.serviceCallers.id, other.caller.id))
    const firstPage = await api.listServiceCallers(f.db, {
      limit: 1,
      includeArchived: false,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).toBeTruthy()
    const secondPage = await api.listServiceCallers(f.db, {
      limit: 20,
      includeArchived: false,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items.map((item) => item.id)).not.toContain(
      firstPage.items[0]!.id
    )
    expect(
      (
        await api.listServiceCallers(f.db, {
          limit: 20,
          includeArchived: false,
          search: '集成方',
        })
      ).items.map((item) => item.id)
    ).toContain(other.caller.id)
    expect(
      (
        await api.listServiceCallers(f.db, {
          limit: 20,
          includeArchived: false,
          search: ' order_api%\\north ',
          sortBy: 'createdAt',
          sortOrder: 'asc',
        })
      ).items.map((item) => item.id)
    ).toContain(literal.caller.id)
    expect(
      (
        await api.listServiceCallers(f.db, {
          limit: 20,
          includeArchived: false,
          search: 'q_a\\b',
          sortBy: 'createdAt',
          sortOrder: 'asc',
        })
      ).items.map((item) => item.id)
    ).toContain(literal.caller.id)
    const ordered = await api.listServiceCallers(f.db, {
      limit: 1,
      includeArchived: false,
      sortBy: 'createdAt',
      sortOrder: 'asc',
    })
    expect(ordered.nextCursor).toBeTruthy()
    expect(ordered.nextCursor).not.toMatch(/^[0-9a-f-]{36}$/)
    const orderedNext = await api.listServiceCallers(f.db, {
      limit: 1,
      includeArchived: false,
      sortBy: 'createdAt',
      sortOrder: 'asc',
      cursor: ordered.nextCursor,
    })
    expect(orderedNext.items[0]!.id).not.toBe(ordered.items[0]!.id)
    await expect(
      api.listServiceCallers(f.db, {
        limit: 1,
        includeArchived: false,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        cursor: ordered.nextCursor,
      })
    ).rejects.toMatchObject({ code: 'SERVICE_CURSOR_INVALID' })
    await expect(
      api.listServiceCallers(f.db, {
        limit: 20,
        includeArchived: false,
        cursor: 'not-a-cursor',
      })
    ).rejects.toMatchObject({ code: 'SERVICE_CURSOR_INVALID' })
    await expect(
      api.listServiceCallers(f.db, {
        limit: 20,
        includeArchived: false,
        sortBy: 'createdAt',
        sortOrder: 'asc',
        cursor: firstPage.nextCursor,
      })
    ).rejects.toMatchObject({ code: 'SERVICE_CURSOR_INVALID' })

    const metadata = await api.updateServiceCredentialMetadata(
      f.db,
      f.caller.id,
      f.key.credential.id,
      {
        name: '生产接入 Key',
        notes: '轮换窗口：周三',
        expectedMetadataRevision: 1,
      },
      f.actor
    )
    expect(metadata).toMatchObject({
      name: '生产接入 Key',
      notes: '轮换窗口：周三',
      revision: 1,
      metadataRevision: 2,
    })
    await expect(
      api.updateServiceCredential(
        f.db,
        f.caller.id,
        f.key.credential.id,
        {
          ...f.policy,
          name: '不能走授权接口改名',
          scopes: [...f.policy.scopes],
        },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'CREDENTIAL_METADATA_UPDATE_REQUIRED' })
    await expect(
      api.updateServiceCredentialMetadata(
        f.db,
        f.caller.id,
        f.key.credential.id,
        { name: '过期写入', notes: null, expectedMetadataRevision: 1 },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'CREDENTIAL_METADATA_CONFLICT' })
    const [projection] = await f.h.db
      .select()
      .from(s.credentials)
      .where(eq(s.credentials.id, f.key.credential.id))
    expect(projection).toMatchObject({
      name: '生产接入 Key',
      notes: '轮换窗口：周三',
    })
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`)
    ).resolves.toMatchObject({
      credentialId: f.key.credential.id,
    })

    const holding = await api.createServiceRun(
      f.db,
      f.principal,
      f.body,
      'holding-run'
    )
    await f.h.db
      .update(s.runs)
      .set({ status: 'HOLDING' })
      .where(eq(s.runs.id, holding.detail.id))
    expect(
      (await api.getServiceCaller(f.db, f.caller.id)).caller.outstandingRuns
    ).toBe(1)
    const outstanding = await api.listServiceOutstandingRuns(
      f.db,
      f.caller.id,
      { limit: 20 },
      f.actor
    )
    expect(outstanding).toMatchObject({
      outstandingRuns: 1,
      visibleOutstandingRuns: 1,
      observedAt: expect.any(String),
    })
    expect(outstanding.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: holding.detail.id,
          status: 'HOLDING',
          scenarioName: f.scenario.name,
          currentStepIndex: null,
          currentStepName: null,
          durationSeconds: expect.any(Number),
          idempotencyKey: f.body.idempotencyKey,
          credentialId: f.key.credential.id,
          credentialName: metadata.name,
          canCancel: true,
          canReview: false,
        }),
      ])
    )
    const capacitySorted = await api.listServiceCallers(f.db, {
      limit: 20,
      includeArchived: false,
      sortBy: 'outstandingRuns',
      sortOrder: 'desc',
    })
    expect(capacitySorted.items[0]!.id).toBe(f.caller.id)
    await expect(
      api.archiveServiceCaller(f.db, f.caller.id, f.actor)
    ).rejects.toMatchObject({
      code: 'SERVICE_HAS_OUTSTANDING_RUNS',
    })

    const active = await api.createServiceRun(
      f.db,
      f.principal,
      { ...f.body, idempotencyKey: 'active-cancel-key' },
      'active-cancel'
    )
    const worker = { workerId: api.newId(), instanceId: api.newId() }
    await api.registerWorker(f.db, {
      ...worker,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const grant = (await api.claimRun(f.db, {
      ...worker,
      leaseTtlSeconds: 60,
    }))!
    expect(grant.runId).toBe(active.detail.id)
    await api.startAttempt(f.db, {
      runId: grant.runId,
      stepRunId: active.detail.stepRuns[0]!.id,
      inputPayload: {},
      grant,
    })
    const cancellation = await api.cancelServiceOutstandingRun(
      f.db,
      f.caller.id,
      active.detail.id,
      f.actor
    )
    expect(cancellation).toMatchObject({
      runId: active.detail.id,
      cancelRequested: true,
      occupiesServiceCapacity: true,
    })
    await api.yieldUnfinishedRun(f.db, grant)
    expect((await api.getRun(f.db, active.detail.id)).status).toBe('CANCELLED')
    await f.h.db
      .update(s.runs)
      .set({ status: 'SUCCEEDED', finishedAt: new Date() })
      .where(eq(s.runs.id, holding.detail.id))

    await api.setServiceCallerStatus(
      f.db,
      f.caller.id,
      { status: 'disabled' },
      f.actor
    )
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`)
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    })
    await api.setServiceCallerStatus(
      f.db,
      f.caller.id,
      { status: 'active' },
      f.actor
    )
    const archived = await api.archiveServiceCaller(f.db, f.caller.id, f.actor)
    expect(archived).toMatchObject({
      status: 'disabled',
      archivedAt: expect.any(String),
    })
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`)
    ).rejects.toMatchObject({
      kind: 'unauthorized',
    })
    await expect(
      api.issueServiceCredential(
        f.db,
        f.caller.id,
        { ...f.policy, scopes: [...f.policy.scopes], expiresInDays: 1 },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'SERVICE_ARCHIVED' })
    await expect(
      api.setServiceCallerStatus(
        f.db,
        f.caller.id,
        { status: 'active' },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'SERVICE_ARCHIVED' })
    await expect(
      api.saveServiceCaller(
        f.db,
        f.caller.id,
        serviceCallerBodySchema.parse({
          name: f.caller.name,
          owner: f.caller.owner,
        }),
        f.actor
      )
    ).rejects.toMatchObject({ code: 'SERVICE_ARCHIVED' })
    await expect(
      api.updateServiceCredential(
        f.db,
        f.caller.id,
        f.key.credential.id,
        { ...f.policy, name: metadata.name, scopes: [...f.policy.scopes] },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'SERVICE_ARCHIVED' })
    await expect(
      api.updateServiceCredentialMetadata(
        f.db,
        f.caller.id,
        f.key.credential.id,
        {
          name: metadata.name,
          notes: metadata.notes,
          expectedMetadataRevision: metadata.metadataRevision,
        },
        f.actor
      )
    ).rejects.toMatchObject({ code: 'SERVICE_ARCHIVED' })
    await expect(
      api.updateServiceCredential(
        f.db,
        f.caller.id,
        f.key.credential.id,
        null,
        f.actor
      )
    ).resolves.toMatchObject({ status: 'revoked' })
    expect(
      (
        await api.listServiceCallers(f.db, {
          limit: 20,
          includeArchived: false,
        })
      ).items.some((item) => item.id === f.caller.id)
    ).toBe(false)
    expect(
      (
        await api.listServiceCallers(f.db, { limit: 20, includeArchived: true })
      ).items.find((item) => item.id === f.caller.id)?.archivedAt
    ).toEqual(expect.any(String))
    const audit = await listOperationAuditEvents(f.h.db, { limit: 100 })
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'credential.metadata',
        'service.status',
        'service.archive',
        'run.cancel',
      ])
    )
  })
  it('service identity, grants, cancellation, deadline and audit survive database transfer', async () => {
    const f = await fixture(driver)
    const run = await api.createServiceRun(
      f.db,
      f.principal,
      f.body,
      'transfer-run'
    )
    await api.getServiceRun(f.db, f.principal, run.detail.id, true)
    await api.setServiceCallerIpWhitelist(
      f.db,
      f.caller.id,
      { entries: ['203.0.113.27/24'] },
      f.actor
    )
    await api.recordServiceRequestLog(f.db, {
      callerId: f.caller.id,
      credentialId: f.key.credential.id,
      requestId: 'transfer-request-log',
      method: 'POST',
      path: '/api/open/v1/runs',
      statusCode: 403,
      latencyMs: 7,
      clientIp: '203.0.113.9',
      errorCode: 'TARGET_SCOPE_DENIED',
      errorMessage: '凭据未获授权访问该目标系统',
      diagnostic: { category: 'authorization' },
      requestSummary: {
        scenarioId: f.scenario.id,
        scenarioVersionId: f.body.scenarioVersionId,
        targetAccountId: f.account.id,
        idempotencyKey: f.body.idempotencyKey,
        inputKeys: ['orderId'],
      },
    })
    await api.setServiceCredentialSuspended(
      f.db,
      f.caller.id,
      f.key.credential.id,
      true,
      f.actor
    )
    const { exportDatabase, importDatabase } = await import('../transfer.js')
    const options = {
      writersStopped: true as const,
      allowMillisecondPrecisionLoss: true,
    }
    const bundle = await exportDatabase(f.db, f.h.env, options)
    const target = await openContractDb(
      DRIVERS[(DRIVERS.indexOf(driver) + 1) % DRIVERS.length]!
    )
    handles.push(target)
    const targetDb = expose(target)
    await importDatabase(targetDb, target.env, bundle, options)
    const transferredCaller = await api.getServiceCaller(targetDb, f.caller.id)
    expect(transferredCaller.caller).toMatchObject({
      ipWhitelist: ['203.0.113.0/24'],
    })
    expect(transferredCaller.credentials).toEqual([
      expect.objectContaining({
        id: f.key.credential.id,
        status: 'suspended',
        suspendedAt: expect.any(String),
      }),
    ])
    const logs = await api.listServiceRequestLogs(
      targetDb,
      f.caller.id,
      { limit: 20, requestId: 'transfer-request-log' },
      f.actor
    )
    expect(logs.items).toEqual([
      expect.objectContaining({
        credentialId: f.key.credential.id,
        clientIp: '203.0.113.9',
        errorCode: 'TARGET_SCOPE_DENIED',
        diagnostic: { category: 'authorization' },
        requestSummary: expect.objectContaining({ inputKeys: ['orderId'] }),
      }),
    ])
    await api.setServiceCredentialSuspended(
      targetDb,
      f.caller.id,
      f.key.credential.id,
      false,
      f.actor
    )
    const actor = await api.authenticateService(
      targetDb,
      `Bearer ${f.key.token}`,
      {
        clientIp: '203.0.113.9',
      }
    )
    expect(
      (await api.getServiceRun(targetDb, actor, run.detail.id)).status
    ).toBe('CANCELLED')
    expect(
      (await api.getServiceCaller(targetDb, f.caller.id)).credentials[0]!.grants
    ).toEqual(f.key.credential.grants)
    expect(
      (await api.createServiceRun(targetDb, actor, f.body, 'after-transfer'))
        .created
    ).toBe(false)
    expect(
      (await api.loadRunRow(targetDb, run.detail.id))!.serviceAdmission
    ).toMatchObject({
      requestId: 'transfer-run',
    })
  })
  it('deadlines cover queued and active runs; DB enforces actor pairs and immutable admission', async () => {
    const f = await fixture(driver, 1),
      s = schemaFor(f.h.db)
    const first = await api.createServiceRun(
      f.db,
      f.principal,
      f.body,
      'deadline'
    )
    const worker = { workerId: api.newId(), instanceId: api.newId() }
    await api.registerWorker(f.db, {
      ...worker,
      capacity: 2,
      lostAfterSeconds: 60,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const grant = (await api.claimRun(f.db, {
      ...worker,
      leaseTtlSeconds: 60,
    }))!
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
      'deadline'
    )
    const [row] = await f.h.db
      .select()
      .from(s.runs)
      .where(eq(s.runs.id, first.detail.id))
    await expect(
      f.h.db
        .update(s.runs)
        .set({ createdByConsoleAccountId: f.actor.id })
        .where(eq(s.runs.id, row!.id))
    ).rejects.toThrow()
    await expect(
      f.h.db
        .update(s.runs)
        .set({
          serviceAdmission: {
            ...row!.serviceAdmission!,
            credentialRevision: 2,
          },
        })
        .where(eq(s.runs.id, row!.id))
    ).rejects.toThrow()
    await expect(
      f.h.db.insert(s.runs).values({
        ...row!,
        id: api.newId(),
        createdByConsoleAccountId: f.actor.id,
        idempotencyKey: 'invalid-key',
      })
    ).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 1100))
    await api.expireRunDeadlines(f.db)
    expect(
      await api.getServiceRun(f.db, f.principal, queued.detail.id)
    ).toMatchObject({
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
    expect(
      (await api.getServiceRun(f.db, f.principal, first.detail.id)).status
    ).toBe('CANCELLED')
    expect(
      await api.claimRun(f.db, { ...worker, leaseTtlSeconds: 60 })
    ).toBeNull()
  })
  it('enforces canonical source allowlists, reversible suspension, catalog projection, and retained request facts', async () => {
    const f = await fixture(driver)
    const whitelist = await api.setServiceCallerIpWhitelist(
      f.db,
      f.caller.id,
      { entries: ['203.0.113.199/24', '2001:0db8::/32'] },
      f.actor
    )
    expect(whitelist.ipWhitelist).toEqual(['203.0.113.0/24', '2001:db8::/32'])
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`, {
        clientIp: '198.51.100.8',
      })
    ).rejects.toMatchObject({ code: 'IP_FORBIDDEN', kind: 'forbidden' })
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`, {
        clientIp: '203.0.113.8',
      })
    ).resolves.toMatchObject({ credentialId: f.key.credential.id })
    await expect(
      api.setServiceCallerIpWhitelist(
        f.db,
        f.caller.id,
        { entries: ['203.0.113.1', '203.0.113.1'] },
        f.actor
      )
    ).rejects.toThrow()

    const suspended = await api.setServiceCredentialSuspended(
      f.db,
      f.caller.id,
      f.key.credential.id,
      true,
      f.actor
    )
    expect(suspended).toMatchObject({
      status: 'suspended',
      suspendedAt: expect.any(String),
    })
    await expect(
      api.authenticateService(f.db, `Bearer ${f.key.token}`, {
        clientIp: '203.0.113.8',
      })
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_SUSPENDED',
      kind: 'unauthorized',
    })
    const reactivated = await api.setServiceCredentialSuspended(
      f.db,
      f.caller.id,
      f.key.credential.id,
      false,
      f.actor
    )
    expect(reactivated).toMatchObject({ status: 'active', suspendedAt: null })

    const catalog = await api.getServiceCredentialCatalog(
      f.db,
      f.caller.id,
      f.key.credential.id,
      f.actor
    )
    expect(catalog).toMatchObject({
      credentialId: f.key.credential.id,
      items: [
        expect.objectContaining({
          targetId: f.target.id,
          scenarios: [
            expect.objectContaining({
              scenarioId: f.scenario.id,
              versionNo: 1,
            }),
          ],
        }),
      ],
    })

    const first = await api.recordServiceRequestLog(f.db, {
      callerId: f.caller.id,
      credentialId: f.key.credential.id,
      requestId: 'service-log-success',
      method: 'POST',
      path: '/api/open/v1/runs',
      statusCode: 201,
      latencyMs: 12,
      clientIp: '::ffff:203.0.113.8',
      errorCode: null,
      errorMessage: null,
      diagnostic: null,
      requestSummary: {
        scenarioId: f.scenario.id,
        scenarioVersionId: f.body.scenarioVersionId,
        targetAccountId: f.account.id,
        idempotencyKey: f.body.idempotencyKey,
        inputKeys: ['orderId'],
      },
    })
    expect(first.recorded).toBe(true)
    await api.recordServiceRequestLog(f.db, {
      callerId: f.caller.id,
      credentialId: f.key.credential.id,
      requestId: 'service-log-denied',
      method: 'POST',
      path: '/api/open/v1/runs',
      statusCode: 403,
      latencyMs: 3,
      clientIp: '203.0.113.8',
      errorCode: 'TARGET_SCOPE_DENIED',
      errorMessage: '凭据未获授权访问该目标系统',
      diagnostic: { category: 'authorization' },
      requestSummary: { inputKeys: ['orderId'] },
    })
    const denied = await api.listServiceRequestLogs(
      f.db,
      f.caller.id,
      { limit: 20, statusCategory: '4xx' },
      f.actor
    )
    expect(denied.items).toEqual([
      expect.objectContaining({
        errorCode: 'TARGET_SCOPE_DENIED',
        clientIp: '203.0.113.8',
        requestSummary: { inputKeys: ['orderId'] },
      }),
    ])
    const success = await api.listServiceRequestLogs(
      f.db,
      f.caller.id,
      { limit: 20, requestId: 'service-log-success' },
      f.actor
    )
    expect(success.items[0]).toMatchObject({
      statusCode: 201,
      credentialName: f.key.credential.name,
    })
    const detail = await api.getServiceRequestLog(
      f.db,
      f.caller.id,
      success.items[0]!.id,
      f.actor
    )
    expect(JSON.stringify(detail)).not.toContain(f.key.token)
    expect(JSON.stringify(detail)).not.toContain(f.key.token.split('.')[1])

    const { serviceRequestLogs } = schemaFor(f.h.db)
    await f.h.db
      .update(serviceRequestLogs)
      .set({ createdAt: new Date('2026-01-01T00:00:00.000Z') })
      .where(eq(serviceRequestLogs.requestId, 'service-log-success'))
    await f.h.db
      .update(serviceRequestLogs)
      .set({ createdAt: new Date('2026-01-05T00:00:00.000Z') })
      .where(eq(serviceRequestLogs.requestId, 'service-log-denied'))
    const reaped = await api.reapServiceRequestLogs(f.db, {
      now: new Date('2026-01-09T00:00:00.000Z'),
      limit: 1000,
    })
    expect(reaped).toMatchObject({ scanned: 1, deleted: 1 })
    expect(
      (
        await api.listServiceRequestLogs(
          f.db,
          f.caller.id,
          { limit: 20 },
          f.actor
        )
      ).items.map((item) => item.requestId)
    ).toEqual(['service-log-denied'])
    const audit = await listOperationAuditEvents(f.h.db, { limit: 100 })
    expect(audit.items.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        'service.ip_whitelist',
        'credential.suspend',
        'credential.reactivate',
      ])
    )
  })
})
