import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  ACTIVE_RUN_STATUSES,
  RECORDER_SOURCE_VERSION,
  RECORDING_NORMALIZER_VERSION,
  createTargetBodySchema,
  type CreateRecordingBody,
  type Step,
} from '@cairn/shared'
import * as api from '../index.js'
import { expose } from '../database.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { newId } from '../id.js'

const echo: Step = {
  id: '00000000-0000-4000-8000-000000000061',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

function recordingBody(targetId: string, key: string): CreateRecordingBody {
  return {
    targetId,
    recordingId: newId(),
    sourceVersion: RECORDER_SOURCE_VERSION,
    idempotencyKey: key,
    events: [
      {
        name: 'navigate',
        url: 'https://shop.example.com/orders',
        signals: [],
        pageAlias: 'page',
        framePath: [],
      },
    ],
  }
}

const handles: Awaited<ReturnType<typeof openContractDb>>[] = []
afterEach(async () => {
  for (const handle of handles.splice(0).reverse()) await handle.close()
})

async function fixture(driver: (typeof DRIVERS)[number]) {
  const handle = await openContractDb(driver)
  handles.push(handle)
  const db = expose(handle)
  const { consoleAccounts } = schemaFor(handle.db)
  const actorId = newId()
  await handle.db.insert(consoleAccounts).values({
    id: actorId,
    displayName: '生命周期',
    email: `life-${actorId}@example.com`,
    status: 'active',
  })
  const actor = {
    id: actorId,
    displayName: '生命周期',
    email: `life-${actorId}@example.com`,
    status: 'active' as const,
    roles: [],
    permissions: [],
  }
  const targets = new api.TargetsStore(db, () => Buffer.from('secret'))
  const target = await targets.createTarget(
    createTargetBodySchema.parse({
      code: `life-${actorId.slice(0, 8)}`,
      name: '生命周期目标',
      entryUrl: 'https://life.example',
    }),
    actor,
  )
  return { handle, db, actor, targets, target }
}

describe.each(DRIVERS)('%s 资源生命周期', { timeout: 30_000 }, (driver) => {
  it('LM01 删除快照成对、重复删除不改审计', async () => {
    const f = await fixture(driver)
    const { scenarios } = schemaFor(f.handle.db)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '可删场景',
      steps: [echo],
      actor: f.actor,
    })
    const first = await api.deleteScenario(f.db, scenario.id, f.actor)
    expect(first.deletedBy).toMatchObject({ id: f.actor.id, displayName: '生命周期', kind: 'console' })
    const repeat = await api.deleteScenario(f.db, scenario.id, { id: f.actor.id })
    expect(repeat.deletedAt).toBe(first.deletedAt)
    expect(repeat.deletedBy).toEqual(first.deletedBy)
    const [row] = await f.handle.db.select().from(scenarios).where(eq(scenarios.id, scenario.id))
    expect(row?.deletedAt).toBeTruthy()
    expect(row?.deletedBy).toEqual(first.deletedBy)
    await f.handle.db
      .update(schemaFor(f.handle.db).consoleAccounts)
      .set({ displayName: '已改名' })
      .where(eq(schemaFor(f.handle.db).consoleAccounts.id, f.actor.id))
    const again = await api.deleteScenario(f.db, scenario.id, f.actor)
    expect(again.deletedBy.displayName).toBe('生命周期')
  })

  it('LM02 Target 级联覆盖目录资源，预览扩大不得静默多删', async () => {
    const f = await fixture(driver)
    await f.targets.createAccount(
      f.target.id,
      { displayName: '账号', username: 'ops', status: 'active' },
      f.actor,
    )
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '级联场景',
      steps: [echo],
      actor: f.actor,
    })
    await expect(
      f.targets.deleteTarget(f.target.id, f.actor, { expectedCounts: { targetAccounts: 0 } }),
    ).rejects.toMatchObject({ code: 'DELETE_SCOPE_EXPANDED' })
    const preview = await f.targets.previewDeleteTarget(f.target.id)
    expect(preview.counts.targetAccounts).toBe(1)
    expect(preview.counts.scenarios).toBe(1)
    await f.targets.deleteTarget(f.target.id, f.actor, {
      expectedCounts: {
        targetAccounts: preview.counts.targetAccounts,
        scenarios: preview.counts.scenarios,
        recordings: preview.counts.recordings ?? 0,
        runs: preview.counts.runs ?? 0,
      },
    })
    await expect(f.targets.getTarget(f.target.id)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    await expect(api.getScenario(f.db, scenario.id)).rejects.toMatchObject({
      code: 'SCENARIO_NOT_FOUND',
    })
  })

  it('LM03 活跃运行阻止删除；终态后可删场景并保留历史 Run', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '有运行',
      steps: [echo],
      actor: f.actor,
    })
    const created = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
      idempotencyKey: `run-${scenario.id}`,
    })
    await expect(api.deleteScenario(f.db, scenario.id, f.actor)).rejects.toMatchObject({
      code: 'RUN_NOT_TERMINAL',
    })
    await expect(f.targets.deleteTarget(f.target.id, f.actor)).rejects.toMatchObject({
      code: 'RUN_NOT_TERMINAL',
    })
    const { runs } = schemaFor(f.handle.db)
    await f.handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED' })
      .where(eq(runs.id, created.detail.id))
    const deleted = await api.deleteScenario(f.db, scenario.id, f.actor)
    expect(deleted.accepted).toBe(true)
    const historical = await api.getRun(f.db, created.detail.id)
    expect(historical.scenarioId).toBe(scenario.id)
    await expect(
      api.createRunWithSnapshot(f.db, { scenarioId: scenario.id, actor: f.actor }),
    ).rejects.toMatchObject({ code: 'SCENARIO_NOT_FOUND' })
  })

  it('LM04 已删资源不能新建执行；幂等键返回 RESOURCE_DELETED', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '幂等',
      steps: [echo],
      actor: f.actor,
    })
    const created = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
      idempotencyKey: 'same-run',
    })
    const { runs } = schemaFor(f.handle.db)
    await f.handle.db.update(runs).set({ status: 'SUCCEEDED' }).where(eq(runs.id, created.detail.id))
    await api.deleteRun(f.db, created.detail.id, f.actor)
    await expect(
      api.createRunWithSnapshot(f.db, {
        scenarioId: scenario.id,
        actor: f.actor,
        idempotencyKey: 'same-run',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_DELETED' })

    const draft = await api.createRecordingDraft(
      f.db,
      recordingBody(f.target.id, 'same-rec'),
      f.actor,
    )
    await api.deleteRecordingDraft(f.db, draft.detail.id, f.actor)
    await expect(
      api.createRecordingDraft(f.db, recordingBody(f.target.id, 'same-rec'), f.actor),
    ).rejects.toMatchObject({ code: 'RESOURCE_DELETED' })

    await f.targets.deleteTarget(f.target.id, f.actor)
    await expect(
      api.createScenarioWithVersion(f.db, {
        targetId: f.target.id,
        name: '不能再建',
        steps: [echo],
        actor: f.actor,
      }),
    ).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })

  it('LM08 录制删除不改已导入步骤', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '回填',
      steps: [
        {
          id: newId(),
          name: '打开页面',
          type: 'navigate',
          effectType: 'SIDE_EFFECT',
          input: { url: 'https://shop.example.com' },
        },
      ],
      actor: f.actor,
    })
    const draft = await api.createRecordingDraft(
      f.db,
      recordingBody(f.target.id, `imp-${scenario.id}`),
      f.actor,
    )
    const preview = await api.previewRecordingImport(
      f.db,
      scenario.id,
      {
        recordingDraftId: draft.detail.id,
        baseRevision: scenario.draft!.revision,
        insertAnchor: { kind: 'start' },
      },
      f.actor.id,
    )
    const applied = await api.applyRecordingImport(
      f.db,
      scenario.id,
      {
        idempotencyKey: `apply-${scenario.id}`,
        baseRevision: scenario.draft!.revision,
        recordingDraftId: draft.detail.id,
        normalizerVersion: RECORDING_NORMALIZER_VERSION,
        sourceDigest: preview.sourceDigest,
        insertAnchor: preview.insertAnchor,
        dispositions: preview.items.map((item) =>
          item.ready
            ? { sourceIndexes: item.sourceIndexes, disposition: 'accept' as const }
            : {
                sourceIndexes: item.sourceIndexes,
                disposition: 'discard' as const,
                reason: '不能映射',
              },
        ),
      },
      f.actor,
    )
    const before = applied.scenario.draft!.document.steps
    await api.deleteRecordingDraft(f.db, draft.detail.id, f.actor)
    const after = await api.getScenario(f.db, scenario.id)
    expect(after.draft!.document.steps).toEqual(before)
  })

  it('LM09 列表半开日期、试跑筛选与非法游标', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '分页场景',
      steps: [echo],
      actor: f.actor,
    })
    const created = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
    })
    const from = new Date(Date.parse(created.detail.createdAt) - 1000).toISOString()
    const to = new Date(Date.parse(created.detail.createdAt) + 1000).toISOString()
    const inside = await api.listRuns(f.db, { targetId: f.target.id, from, to, limit: 10 })
    expect(inside.items.some((item) => item.id === created.detail.id)).toBe(true)
    const outside = await api.listRuns(f.db, {
      targetId: f.target.id,
      from: to,
      to: new Date(Date.parse(to) + 60_000).toISOString(),
      limit: 10,
    })
    expect(outside.items.some((item) => item.id === created.detail.id)).toBe(false)
    const trials = await api.listRuns(f.db, { isTrial: true, targetId: f.target.id, limit: 10 })
    expect(trials.items).toHaveLength(0)
    await expect(api.listRuns(f.db, { cursor: '%%%', limit: 10 })).rejects.toThrow()

    const listed = await api.listRecordingDrafts(f.db, f.actor.id, {
      imported: false,
      hasPending: false,
      limit: 10,
    })
    expect(listed.items.every((item) => item.imported !== true)).toBe(true)
  })

  it('LM07 删除后证据与服务入口拒绝，对象进入清理候选', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '证据',
      steps: [echo],
      actor: f.actor,
    })
    const created = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
    })
    const reserved = await api.reserveStoredObject(f.db, {
      runId: created.detail.id,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await api.commitStoredObject(f.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 4,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    const evidence = await api.recordObjectEvidence(f.db, {
      runId: created.detail.id,
      type: 'log',
      objectKey: reserved.objectKey,
    })
    const { evidences, runs } = schemaFor(f.handle.db)
    await f.handle.db
      .update(evidences)
      .set({ externalAccess: 1 })
      .where(eq(evidences.id, evidence.id))
    await f.handle.db.update(runs).set({ status: 'SUCCEEDED' }).where(eq(runs.id, created.detail.id))
    const cleanup = await api.deleteRun(f.db, created.detail.id, f.actor)
    expect(cleanup.totalObjects).toBeGreaterThan(0)
    expect(cleanup.status).not.toBe('completed')
    expect(await api.getEvidenceForRun(f.db, { runId: created.detail.id, evidenceId: evidence.id })).toBeNull()
    await expect(api.getRun(f.db, created.detail.id)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    const [revoked] = await f.handle.db.select().from(evidences).where(eq(evidences.id, evidence.id))
    expect(revoked?.externalAccess).toBe(0)
    const candidates = await api.listPurgeCandidates(f.db, {
      now: new Date(),
      pendingTtlSeconds: 3600,
      limit: 100,
    })
    expect(candidates.some((row) => row.id === reserved.id && row.deleteRequestedAt)).toBe(true)
    await expect(
      api.commitStoredObject(f.db, {
        id: reserved.id,
        contentType: 'text/plain',
        byteSize: 4,
        digest: `sha256:${'cd'.repeat(32)}`,
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_AVAILABLE' })
    await expect(
      api.reserveStoredObject(f.db, {
        runId: created.detail.id,
        retainUntil: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_DELETED' })
    await expect(api.getRunCleanupStatus(f.db, api.newId())).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    })
  })

  it('LM09 超过 50 条时游标分页与关键词筛选只回本页', async () => {
    const f = await fixture(driver)
    for (let i = 0; i < 51; i += 1) {
      await api.createScenarioWithVersion(f.db, {
        targetId: f.target.id,
        name: i === 0 ? '独特分页场景' : `分页场景 ${i}`,
        steps: [echo],
        actor: f.actor,
      })
    }
    const first = await api.listScenarios(f.db, { targetId: f.target.id, limit: 50 })
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).toBeTruthy()
    const second = await api.listScenarios(f.db, {
      targetId: f.target.id,
      limit: 50,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    const named = await api.listScenarios(f.db, { targetId: f.target.id, search: '独特分页', limit: 20 })
    expect(named.items).toHaveLength(1)
    expect(named.items[0]?.name).toBe('独特分页场景')

    const accountA = await f.targets.createAccount(
      f.target.id,
      { displayName: '值班甲', username: 'alpha-user', status: 'active' },
      f.actor,
    )
    await f.targets.createAccount(
      f.target.id,
      { displayName: '值班乙', username: 'beta-user', status: 'disabled' },
      f.actor,
    )
    const searched = await f.targets.listAccounts(f.target.id, { search: 'alpha', limit: 20 })
    expect(searched.items.map((item) => item.id)).toEqual([accountA.id])
    const disabled = await f.targets.listAccounts(f.target.id, { status: 'disabled', limit: 20 })
    expect(disabled.items.every((item) => item.status === 'disabled')).toBe(true)
  })

  it('独占 Secret 才物理清理，平台绑定会挡住', async () => {
    const f = await fixture(driver)
    const account = await f.targets.createAccount(
      f.target.id,
      { displayName: '口令账号', username: 'secret-user', password: 'pw', status: 'active' },
      f.actor,
    )
    const { targetAccounts, secrets, platformAiSecretBindings } = schemaFor(f.handle.db)
    const [row] = await f.handle.db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, account.id))
    expect(row?.secretId).toBeTruthy()
    await f.handle.db.insert(platformAiSecretBindings).values({
      secretId: row!.secretId!,
      modelOrigin: 'https://example.invalid',
    })
    await f.targets.deleteAccount(f.target.id, account.id, f.actor)
    const leftover = await f.handle.db.select().from(secrets).where(eq(secrets.id, row!.secretId!))
    expect(leftover).toHaveLength(1)
  })

  it('LM03 各非终态与取消已受理都不可删', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '非终态',
      steps: [echo],
      actor: f.actor,
    })
    const created = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
    })
    const { runs } = schemaFor(f.handle.db)
    for (const status of ACTIVE_RUN_STATUSES) {
      await f.handle.db.update(runs).set({ status }).where(eq(runs.id, created.detail.id))
      await expect(api.deleteRun(f.db, created.detail.id, f.actor)).rejects.toMatchObject({
        code: 'RUN_NOT_TERMINAL',
      })
      await expect(api.deleteScenario(f.db, scenario.id, f.actor)).rejects.toMatchObject({
        code: 'RUN_NOT_TERMINAL',
      })
    }
    await f.handle.db
      .update(runs)
      .set({ status: 'RUNNING', cancelRequestedAt: new Date() })
      .where(eq(runs.id, created.detail.id))
    await expect(api.deleteRun(f.db, created.detail.id, f.actor)).rejects.toMatchObject({
      code: 'RUN_NOT_TERMINAL',
    })
  })

  it('在途证据写入阻止删除；历史 Run 标记已删目录', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '在途',
      steps: [echo],
      actor: f.actor,
    })
    const created = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
    })
    await api.reserveStoredObject(f.db, {
      runId: created.detail.id,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const { runs } = schemaFor(f.handle.db)
    await f.handle.db.update(runs).set({ status: 'SUCCEEDED' }).where(eq(runs.id, created.detail.id))
    await expect(api.deleteRun(f.db, created.detail.id, f.actor)).rejects.toMatchObject({
      code: 'RESOURCE_BUSY',
    })
    await expect(f.targets.deleteTarget(f.target.id, f.actor)).rejects.toMatchObject({
      code: 'RESOURCE_BUSY',
    })

    const finished = await api.createRunWithSnapshot(f.db, {
      scenarioId: scenario.id,
      actor: f.actor,
      idempotencyKey: `done-${scenario.id}`,
    })
    await f.handle.db.update(runs).set({ status: 'SUCCEEDED' }).where(eq(runs.id, finished.detail.id))
    await api.deleteScenario(f.db, scenario.id, f.actor)
    const historical = await api.getRun(f.db, finished.detail.id)
    expect(historical.scenarioDeleted).toBe(true)
    expect(historical.scenarioName).toBe('在途')
  })

  it('删除目标登记会话关闭；重建占用提示已删除记录', async () => {
    const f = await fixture(driver)
    const account = await f.targets.createAccount(
      f.target.id,
      { displayName: '会话账号', username: 'session-user', status: 'active' },
      f.actor,
    )
    const session = await api.createSession(f.db, {
      key: { targetId: f.target.id, targetAccountId: account.id },
      ownerWorkerId: 'worker-life',
      reusePolicy: 'NEW_PAGE',
      idleTtlSeconds: 60,
      maxLifetimeSeconds: 600,
    })
    expect(session.ok).toBe(true)
    await f.targets.deleteTarget(f.target.id, f.actor)
    if (session.ok) {
      const row = await api.getSessionById(f.db, session.session.id)
      expect(row?.status).toBe('CLOSING')
      expect(row?.closeReason).toBe('resource_deleted')
    }
    await expect(
      api.createSession(f.db, {
        key: { targetId: f.target.id, targetAccountId: account.id },
        ownerWorkerId: 'worker-life',
        reusePolicy: 'NEW_PAGE',
        idleTtlSeconds: 60,
        maxLifetimeSeconds: 600,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'SESSION_TARGET_MISSING' })
    await expect(
      f.targets.createTarget(
        createTargetBodySchema.parse({
          code: f.target.code,
          name: '再建',
          entryUrl: 'https://life.example',
        }),
        f.actor,
      ),
    ).rejects.toMatchObject({
      code: 'TARGET_CODE_CONFLICT',
      message: expect.stringContaining('已删除记录占用'),
    })
  })

  it('LM09 运行与录制超过 50 条时只回本页', async () => {
    const f = await fixture(driver)
    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '批量运行',
      steps: [echo],
      actor: f.actor,
    })
    for (let i = 0; i < 51; i += 1) {
      await api.createRunWithSnapshot(f.db, {
        scenarioId: scenario.id,
        actor: f.actor,
        idempotencyKey: `bulk-run-${i}`,
      })
      await api.createRecordingDraft(f.db, recordingBody(f.target.id, `bulk-rec-${i}`), f.actor)
    }
    const firstRuns = await api.listRuns(f.db, { targetId: f.target.id, limit: 50 })
    expect(firstRuns.items).toHaveLength(50)
    expect(firstRuns.nextCursor).toBeTruthy()
    const secondRuns = await api.listRuns(f.db, {
      targetId: f.target.id,
      limit: 50,
      cursor: firstRuns.nextCursor,
    })
    expect(secondRuns.items.length).toBeGreaterThan(0)
    expect(secondRuns.items[0]?.id).not.toBe(firstRuns.items[0]?.id)
    const firstRecs = await api.listRecordingDrafts(f.db, f.actor.id, { limit: 50 })
    expect(firstRecs.items).toHaveLength(50)
    expect(firstRecs.nextCursor).toBeTruthy()
  })

  it('LM09 目标超过 50 条时只回本页；账号与场景重建提示占用', async () => {
    const f = await fixture(driver)
    for (let i = 0; i < 50; i += 1) {
      await f.targets.createTarget(
        createTargetBodySchema.parse({
          code: `page-${f.target.id.slice(0, 8)}-${i}`,
          name: `分页目标 ${i}`,
          entryUrl: 'https://life.example',
        }),
        f.actor,
      )
    }
    const first = await f.targets.listTargets({ limit: 50 })
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).toBeTruthy()
    const second = await f.targets.listTargets({ limit: 50, cursor: first.nextCursor })
    expect(second.items.length).toBeGreaterThan(0)
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)

    const account = await f.targets.createAccount(
      f.target.id,
      { displayName: '占用账号', username: 'taken-user', status: 'active' },
      f.actor,
    )
    await f.targets.deleteAccount(f.target.id, account.id, f.actor)
    await expect(
      f.targets.createAccount(
        f.target.id,
        { displayName: '再建账号', username: 'taken-user', status: 'active' },
        f.actor,
      ),
    ).rejects.toMatchObject({
      code: 'TARGET_ACCOUNT_CONFLICT',
      message: expect.stringContaining('已删除记录占用'),
    })

    const scenario = await api.createScenarioWithVersion(f.db, {
      targetId: f.target.id,
      name: '占用场景',
      steps: [echo],
      actor: f.actor,
    })
    await api.deleteScenario(f.db, scenario.id, f.actor)
    await expect(
      api.createScenarioWithVersion(f.db, {
        targetId: f.target.id,
        name: '占用场景',
        steps: [echo],
        actor: f.actor,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('已删除记录占用'),
    })
  })
})
