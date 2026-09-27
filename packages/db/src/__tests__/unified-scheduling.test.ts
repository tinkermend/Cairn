import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import { appendRunEvents } from '../observe/events.js'
import { expireRunDeadlines } from '../runs/deadline.js'
import {
  admitScheduleOccurrence,
  claimAnalysisJob,
  createAnalysisJob,
  heartbeatAnalysisJob,
  cancelAnalysisJob,
  getAnalysisJob,
  listAnalysisJobs,
  createScenarioWithVersion,
  createSuite,
  prepareAnalysisJob,
  getSchedule,
  indexRunForAnalysis,
  listPendingScheduleAdmits,
  listScheduleEvents,
  listScheduleOccurrences,
  materializeDueSchedules,
  previewScheduleQuery,
  publishSuite,
  setScheduleEnabled,
  submitAnalysisJob,
  triggerScheduleOnce,
  writeRunWithSnapshot,
  writeSchedule,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 统一定时调度', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `unif_${Date.now().toString(36)}`)
    const { consoleAccounts, consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'unif',
      email: `unif-${actorId}@example.com`,
      status: 'active',
    })
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({
      consoleAccountId: actorId,
      consoleRoleId: admin!.id,
      targetScopeMode: 'all',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function executeAnalysisJob(db: typeof handle.db, job: Parameters<typeof prepareAnalysisJob>[1], owner: string) {
    const { records: _records, ai: _ai, ...prepared } = await prepareAnalysisJob(db, job, owner)
    return submitAnalysisJob(db, { ...prepared, jobId: job.analysisJobId, owner, fencingToken: job.fencingToken, expectedCursor: job.checkpointSeq, modelUsage: { model: null, invoked: false } })
  }

  async function freshTarget() {
    const { targets, targetAccounts } = schemaFor(handle.db)
    const targetId = newId()
    const accountId = newId()
    await handle.db.insert(targets).values({
      id: targetId,
      code: `unif-${targetId}`,
      name: '统一调度夹具',
      entryUrl: 'https://shop.example/home',
      loginUrl: 'https://idp.example/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: accountId,
      targetId,
      displayName: '值班账号',
      username: `ops-${accountId}`,
      status: 'active',
      usage: 'both',
      mapUsageGuard: 'Y',
    })
    return { targetId, accountId }
  }

  async function setFactories(flags: {
    scenario?: boolean
    suite?: boolean
    map?: boolean
    analysis?: boolean
  }) {
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '夹具工厂开关',
      document: {
        ...current.document,
        scenarioScheduledRunEnabled: flags.scenario ?? current.document.scenarioScheduledRunEnabled,
        suiteScheduledRunEnabled: flags.suite ?? current.document.suiteScheduledRunEnabled,
        mapScheduledRefreshEnabled: flags.map ?? current.document.mapScheduledRefreshEnabled,
        knowledgeAnalysisEnabled: flags.analysis ?? current.document.knowledgeAnalysisEnabled,
      },
      actor: { id: actorId },
    })
  }

  function echoSteps() {
    return [
      {
        id: newId(),
        name: '回声',
        type: 'echo' as const,
        effectType: 'READ_ONLY' as const,
        input: { value: 'ok' },
      },
    ]
  }

  async function publishedScenario(targetId: string, name = `场景 ${newId()}`) {
    return createScenarioWithVersion(handle.db, {
      targetId,
      name,
      actor: actor(),
      steps: echoSteps(),
    })
  }

  it('GET 预览间隔与日历窗口，不要求业务输入', async () => {
    const calendar = await previewScheduleQuery(handle.db, {
      kind: 'calendar',
      timezone: 'Asia/Shanghai',
      weekdays: [1, 2, 3, 4, 5],
      windowStart: '02:00',
      windowEnd: '03:00',
      asOf: '2026-06-15T00:00:00.000Z',
    })
    expect(calendar.windows.length).toBeGreaterThan(0)
    const interval = await previewScheduleQuery(handle.db, {
      kind: 'interval',
      intervalMs: 5 * 60 * 1000,
      anchorUtc: '2026-06-15T00:00:00.000Z',
      asOf: '2026-06-15T00:07:00.000Z',
    })
    expect(interval.windows.map((item) => (item.kind === 'ok' ? item.windowStartUtc : ''))).toEqual([
      '2026-06-15T00:10:00.000Z',
      '2026-06-15T00:15:00.000Z',
      '2026-06-15T00:20:00.000Z',
      '2026-06-15T00:25:00.000Z',
      '2026-06-15T00:30:00.000Z',
      '2026-06-15T00:35:00.000Z',
      '2026-06-15T00:40:00.000Z',
      '2026-06-15T00:45:00.000Z',
      '2026-06-15T00:50:00.000Z',
      '2026-06-15T00:55:00.000Z',
    ])
  })

  it('同一时间戳的调度事件按 seq 完整翻页，沿用原有游标', async () => {
    const { targetId } = await freshTarget()
    const created = await writeSchedule(handle.db, {
      expectedRevision: 0,
      idempotencyKey: newId(),
      definition: {
        timeRule: { kind: 'interval', intervalMs: 300_000, anchorUtc: '2026-06-15T00:00:00.000Z', misfire: 'coalesce' },
        consumer: { type: 'knowledge_analysis', targetId, mode: 'map_quality' },
      },
    }, actor())
    const scheduleId = created.schedule.scheduleId
    const { scheduleEvents } = schemaFor(handle.db)
    const at = new Date('2026-09-27T00:00:00.000Z')
    const ids = [
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]
    await handle.db.insert(scheduleEvents).values(ids.map((id, index) => ({
      id,
      scheduleId,
      seq: index + 2,
      eventType: 'test_event',
      payload: {},
      createdAt: at,
    })))

    const seen: number[] = []
    let cursor: string | undefined
    do {
      const page = await listScheduleEvents(handle.db, scheduleId, { cursor, limit: 1 })
      seen.push(...page.items.map((item) => item.seq))
      if (seen.length === 1) {
        expect(Buffer.from(page.nextCursor!, 'base64url').toString('utf8')).toBe(`${at.toISOString()}|${ids[2]}`)
      }
      cursor = page.nextCursor
    } while (cursor)
    expect(seen).toEqual([4, 3, 2, 1])
  })

  it('场景计划固定发布版本，准入创建正式 Run', async () => {
    await setFactories({ scenario: true })
    const { targetId, accountId } = await freshTarget()
    const scenario = await publishedScenario(targetId)
    const created = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: `sc-${newId()}`,
        definition: {
          name: '夜间场景',
          timezone: 'Asia/Shanghai',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          windowStart: '00:00',
          windowEnd: '23:59',
          misfire: 'skip',
          consumer: {
            type: 'scenario_run',
            targetId,
            scenarioId: scenario.id,
            scenarioVersionId: scenario.latestVersionId,
            accountBinding: { targetAccountId: accountId },
            input: {},
          },
        },
      },
      actor(),
    )
    expect(created.schedule.enabled).toBe(false)
    expect(created.schedule.targetAccountId).toBe(accountId)
    const enabled = await setScheduleEnabled(
      handle.db,
      created.schedule.scheduleId,
      { expectedRevision: created.schedule.revision, idempotencyKey: `on-${newId()}`, enabled: true },
      actor(),
    )
    const tick = await materializeDueSchedules(handle.db)
    expect(tick.pending.some((item) => item.occurrence.scheduleId === enabled.scheduleId)).toBe(true)
    const pending = tick.pending.find((item) => item.occurrence.scheduleId === enabled.scheduleId)!
    const admitted = await admitScheduleOccurrence(
      handle.db,
      pending.occurrence.occurrenceId,
      { steps: [], includedCount: 1 },
      actor(),
    )
    expect(admitted.admissionStatus).toBe('ADMITTED')
    expect(admitted.runId).toBeTruthy()
    const { runs } = schemaFor(handle.db)
    const [run] = await handle.db.select().from(runs).where(eq(runs.id, admitted.runId!))
    expect(run?.scenarioVersionId).toBe(scenario.latestVersionId)
    await setScheduleEnabled(handle.db, enabled.scheduleId, { expectedRevision: enabled.revision, idempotencyKey: newId(), enabled: false, cancelAdmittedJobs: true }, actor())
    const [cancelled] = await handle.db.select().from(runs).where(eq(runs.id, admitted.runId!))
    expect(cancelled?.status).toBe('CANCELLED')
  })

  it('场景集计划准入只创建一个 SuiteRun', async () => {
    await setFactories({ suite: true })
    const { targetId } = await freshTarget()
    const scenario = await publishedScenario(targetId, `集合成员 ${newId().slice(0, 6)}`)
    const suite = await createSuite(
      handle.db,
      {
        targetId,
        name: `集合 ${newId().slice(0, 6)}`,
        document: {
          schemaVersion: 1,
          groups: [],
          sharedInput: {},
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
          members: [
            {
              memberId: 'one',
              ordinal: 0,
              scenarioId: scenario.id,
              scenarioVersionId: scenario.published!.versionId,
              input: {},
            },
          ],
        },
      },
      actor(),
    )
    const published = await publishSuite(
      handle.db,
      suite.id,
      { expectedRevision: suite.draft.revision, idempotencyKey: `pub-${newId()}` },
      actor(),
    )
    const created = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: `su-${newId()}`,
        definition: {
          name: '集合巡检',
          timezone: 'Asia/Shanghai',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          windowStart: '00:00',
          windowEnd: '23:59',
          misfire: 'skip',
          consumer: {
            type: 'suite_run',
            targetId,
            suiteId: published.id,
            suiteVersionId: published.published!.id,
            members: published.published!.document.members.map((member) => ({
              memberId: member.memberId,
              scenarioId: member.scenarioId,
              scenarioVersionId: member.scenarioVersionId,
              targetAccountId: member.targetAccountId,
              input: member.input,
            })),
            policy: { failurePolicy: published.published!.document.failurePolicy },
          },
        },
      },
      actor(),
    )
    await setScheduleEnabled(
      handle.db,
      created.schedule.scheduleId,
      { expectedRevision: created.schedule.revision, idempotencyKey: `on-${newId()}`, enabled: true },
      actor(),
    )
    const tick = await materializeDueSchedules(handle.db)
    const pending = tick.pending.find((item) => item.occurrence.scheduleId === created.schedule.scheduleId)!
    const admitted = await admitScheduleOccurrence(
      handle.db,
      pending.occurrence.occurrenceId,
      { steps: [], includedCount: 1 },
      actor(),
    )
    expect(admitted.admissionStatus).toBe('ADMITTED')
    expect(admitted.suiteRunId).toBeTruthy()
  })

  it('地图工厂关闭不阻断场景计划物化', async () => {
    await setFactories({ scenario: true, map: false })
    const { targetId, accountId } = await freshTarget()
    const scenario = await publishedScenario(targetId)
    const created = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: `iso-${newId()}`,
        definition: {
          timezone: 'Asia/Shanghai',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          windowStart: '00:00',
          windowEnd: '23:59',
          misfire: 'skip',
          consumer: {
            type: 'scenario_run',
            targetId,
            scenarioId: scenario.id,
            scenarioVersionId: scenario.latestVersionId,
            accountBinding: { targetAccountId: accountId },
            input: {},
          },
        },
      },
      actor(),
    )
    await setScheduleEnabled(
      handle.db,
      created.schedule.scheduleId,
      { expectedRevision: created.schedule.revision, idempotencyKey: `on-${newId()}`, enabled: true },
      actor(),
    )
    const tick = await materializeDueSchedules(handle.db)
    expect(tick.pending.some((item) => item.definition.consumer.type === 'scenario_run')).toBe(true)
  })

  it('手动触发幂等、不改 nextDueAt，停用计划仍可验证', async () => {
    await setFactories({ analysis: true })
    const { targetId } = await freshTarget()
    const created = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: `an-${newId()}`,
        definition: {
          name: '质量分析',
          timeRule: {
            kind: 'interval',
            intervalMs: 5 * 60 * 1000,
            anchorUtc: '2026-06-15T00:00:00.000Z',
            misfire: 'coalesce',
          },
          consumer: {
            type: 'knowledge_analysis',
            targetId,
            mode: 'map_quality',
            source: { includeFailures: true },
            strategyVersion: 'analysis-strategy@1',
            budget: { maxItems: 20, useAi: false },
          },
        },
      },
      actor(),
    )
    const nextDueAt = created.schedule.nextDueAt
    const first = await triggerScheduleOnce(
      handle.db,
      created.schedule.scheduleId,
      { idempotencyKey: 'manual-once-01' },
      actor(),
    )
    const again = await triggerScheduleOnce(
      handle.db,
      created.schedule.scheduleId,
      { idempotencyKey: 'manual-once-01' },
      actor(),
    )
    expect(again.occurrence.occurrenceId).toBe(first.occurrence.occurrenceId)
    expect(first.occurrence.source).toBe('manual')
    const after = await listScheduleOccurrences(handle.db, created.schedule.scheduleId, { limit: 10 })
    expect(after.items[0]?.source).toBe('manual')
    const dto = await getSchedule(handle.db, created.schedule.scheduleId)
    expect(dto.nextDueAt).toBe(nextDueAt)
    expect(dto.enabled).toBe(false)
    const recovered = await listPendingScheduleAdmits(handle.db)
    expect(recovered.some((item) => item.occurrence.occurrenceId === first.occurrence.occurrenceId)).toBe(true)
  })

  it('同范围知识分析不能同时启用两份；重叠待执行合并', async () => {
    await setFactories({ analysis: true })
    const { targetId } = await freshTarget()
    const definition = {
      name: '增量提炼',
      timeRule: {
        kind: 'interval' as const,
        intervalMs: 5 * 60 * 1000,
        anchorUtc: '2026-06-15T00:00:00.000Z',
        misfire: 'coalesce' as const,
      },
      consumer: {
        type: 'knowledge_analysis' as const,
        targetId,
        mode: 'run_incremental' as const,
        source: { includeFailures: true },
        strategyVersion: 'analysis-strategy@1',
        budget: { maxItems: 20, useAi: false },
      },
    }
    const first = await writeSchedule(
      handle.db,
      { expectedRevision: 0, idempotencyKey: `id1-${newId()}`, definition },
      actor(),
    )
    await setScheduleEnabled(
      handle.db,
      first.schedule.scheduleId,
      { expectedRevision: first.schedule.revision, idempotencyKey: `on1-${newId()}`, enabled: true },
      actor(),
    )
    const second = await writeSchedule(
      handle.db,
      { expectedRevision: 0, idempotencyKey: `id2-${newId()}`, definition: { ...definition, name: '重复增量' } },
      actor(),
    )
    await expect(
      setScheduleEnabled(
        handle.db,
        second.schedule.scheduleId,
        { expectedRevision: second.schedule.revision, idempotencyKey: `on2-${newId()}`, enabled: true },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULE_IDENTITY_CONFLICT' })

    await triggerScheduleOnce(handle.db, first.schedule.scheduleId, { idempotencyKey: 'coal-a-01' }, actor())
    await triggerScheduleOnce(handle.db, first.schedule.scheduleId, { idempotencyKey: 'coal-b-01' }, actor())
    const items = await listScheduleOccurrences(handle.db, first.schedule.scheduleId, { limit: 20 })
    expect(items.items.some((item) => item.reason === 'COALESCED')).toBe(true)
    expect(items.items.filter((item) => item.admissionStatus === 'PENDING')).toHaveLength(1)
  })

  it('分析作业：无新数据不推进水位；有来源则沉淀候选；迟到 fencing 被拒', async () => {
    const { targetId } = await freshTarget()
    const empty = await createAnalysisJob(handle.db, {
      targetId,
      mode: 'run_incremental',
      source: { includeFailures: true },
      strategyVersion: 'analysis-strategy@1',
      budget: { maxItems: 20, useAi: false },
      actor: actor(),
    })
    const claimedEmpty = await claimAnalysisJob(handle.db, 'analyst-a')
    const emptyJob = claimedEmpty.find((item) => item.analysisJobId === empty.analysisJobId)!
    const noData = await executeAnalysisJob(handle.db, emptyJob, 'analyst-a')
    expect(noData.status).toBe('SUCCEEDED')
    expect(noData.result).toMatchObject({ code: 'NO_NEW_DATA' })
    expect(noData.checkpointSeq).toBe(0)

    const scenario = await publishedScenario(targetId)
    const run = await writeRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      scenarioVersionId: scenario.latestVersionId,
      actor: actor(),
      idempotencyKey: `run-${newId()}`,
    })
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(runs.id, run.runId))
    await indexRunForAnalysis(handle.db, { targetId, runId: run.runId })
    await appendRunEvents(handle.db, run.runId, [{ type: 'evidence.recorded', payload: { type: 'error', status: 'available' } }])
    const job = await createAnalysisJob(handle.db, {
      targetId,
      mode: 'run_incremental',
      source: { includeFailures: true },
      strategyVersion: 'analysis-strategy@1',
      budget: { maxItems: 20, useAi: false },
      actor: actor(),
    })
    const claimed = await claimAnalysisJob(handle.db, 'analyst-b')
    const running = claimed.find((item) => item.analysisJobId === job.analysisJobId)!
    await expect(
      submitAnalysisJob(handle.db, {
        jobId: running.analysisJobId,
        owner: 'stale-owner',
        fencingToken: running.fencingToken,
        expectedCursor: running.checkpointSeq,
        throughSeq: 1,
        result: { kind: 'forged' },
        coverageGaps: [],
        modelUsage: { invoked: false },
      }),
    ).rejects.toMatchObject({ code: 'ANALYSIS_LEASE_LOST' })
    const done = await executeAnalysisJob(handle.db, running, 'analyst-b')
    expect(done.status).toBe('SUCCEEDED')
    expect(done.checkpointSeq).toBeGreaterThan(0)
    expect(done.candidates).toHaveLength(1)
    expect(done.result).toMatchObject({ processed: 2, uniqueRunCount: 1 })
    expect(done.modelUsage).toMatchObject({ invoked: false })
  })

  it('工厂关闭时手动触发被拒绝', async () => {
    await setFactories({ analysis: false })
    const { targetId } = await freshTarget()
    const created = await writeSchedule(
      handle.db,
      {
        expectedRevision: 0,
        idempotencyKey: `off-${newId()}`,
        definition: {
          timeRule: {
            kind: 'interval',
            intervalMs: 5 * 60 * 1000,
            anchorUtc: '2026-06-15T00:00:00.000Z',
            misfire: 'coalesce',
          },
          consumer: {
            type: 'knowledge_analysis',
            targetId,
            mode: 'map_quality',
          },
        },
      },
      actor(),
    )
    await expect(
      triggerScheduleOnce(handle.db, created.schedule.scheduleId, { idempotencyKey: 'manual-off-01' }, actor()),
    ).rejects.toMatchObject({ code: 'SCHEDULE_FACTORY_DISABLED' })
  })

  it('已完成运行不阻断下一次手动触发；进行中运行仍阻止重叠', async () => {
    await setFactories({ scenario: true })
    const { targetId, accountId } = await freshTarget()
    const scenario = await publishedScenario(targetId)
    const created = await writeSchedule(handle.db, {
      expectedRevision: 0, idempotencyKey: newId(), definition: {
        timeRule: { kind: 'interval', intervalMs: 300_000, anchorUtc: new Date().toISOString(), misfire: 'skip' },
        consumer: { type: 'scenario_run', targetId, scenarioId: scenario.id, scenarioVersionId: scenario.latestVersionId, accountBinding: { targetAccountId: accountId }, input: {} },
      },
    }, actor())
    const first = await triggerScheduleOnce(handle.db, created.schedule.scheduleId, { idempotencyKey: newId() }, actor())
    const admitted = await admitScheduleOccurrence(handle.db, first.occurrence.occurrenceId, { steps: [], includedCount: 1 }, actor())
    expect(admitted.runId).toBeTruthy()
    const overlap = await triggerScheduleOnce(handle.db, created.schedule.scheduleId, { idempotencyKey: newId() }, actor())
    expect(overlap.occurrence.reason).toBe('OVERLAP_ACTIVE')
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(runs.id, admitted.runId!))
    const next = await triggerScheduleOnce(handle.db, created.schedule.scheduleId, { idempotencyKey: newId() }, actor())
    expect(next.occurrence.admissionStatus).toBe('PENDING')
    const nextAdmitted = await admitScheduleOccurrence(handle.db, next.occurrence.occurrenceId, { steps: [], includedCount: 1 }, actor())
    expect(nextAdmitted.admissionStatus).toBe('ADMITTED')
    expect(nextAdmitted.runId).not.toBe(admitted.runId)
    const { scheduleOccurrences } = schemaFor(handle.db)
    await handle.db.update(scheduleOccurrences).set({ windowEndUtc: new Date(Date.now() - 1000) }).where(eq(scheduleOccurrences.id, nextAdmitted.occurrenceId))
    await expireRunDeadlines(handle.db, nextAdmitted.runId!)
    const [expired] = await handle.db.select().from(runs).where(eq(runs.id, nextAdmitted.runId!))
    expect(expired?.status).toBe('CANCELLED')
    expect(expired?.cancelReason).toBe('SCHEDULE_START_DEADLINE_ELAPSED')
  })

  it('过期租约不能续期或提交；取消立即关闭尝试并拒绝迟到结果', async () => {
    await setFactories({ analysis: true })
    const { targetId } = await freshTarget()
    const created = await createAnalysisJob(handle.db, { targetId, mode: 'run_incremental', source: { includeFailures: true }, strategyVersion: 'analysis-strategy@1', budget: { maxItems: 20, useAi: false }, actor: actor() })
    const running = (await claimAnalysisJob(handle.db, 'expired-owner', 100)).find(job => job.analysisJobId === created.analysisJobId)!
    const { analysisJobs } = schemaFor(handle.db)
    await handle.db.update(analysisJobs).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(analysisJobs.id, running.analysisJobId))
    await expect(heartbeatAnalysisJob(handle.db, running.analysisJobId, 'expired-owner', running.fencingToken)).rejects.toMatchObject({ code: 'ANALYSIS_LEASE_LOST' })
    const result = { jobId: running.analysisJobId, owner: 'expired-owner', fencingToken: running.fencingToken, expectedCursor: running.checkpointSeq, throughSeq: 0, result: {}, coverageGaps: [], modelUsage: { model: null, invoked: false } }
    await expect(submitAnalysisJob(handle.db, result)).rejects.toMatchObject({ code: 'ANALYSIS_LEASE_LOST' })
    const retry = (await claimAnalysisJob(handle.db, 'next-owner', 100)).find(job => job.analysisJobId === created.analysisJobId)!
    expect(retry.attemptCount).toBe(2)
    expect(retry.attempts?.[0]?.status).toBe('FAILED')
    const cancelled = await cancelAnalysisJob(handle.db, retry.analysisJobId, actor(), newId())
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.attempts?.every(attempt => attempt.status !== 'RUNNING')).toBe(true)
    await expect(submitAnalysisJob(handle.db, { ...result, owner: 'next-owner', fencingToken: retry.fencingToken })).rejects.toMatchObject({ code: 'ANALYSIS_LEASE_LOST' })
  })

  it('间隔逐期推进；离线多期分析只保留一个待执行批次', async () => {
    await setFactories({ analysis: true })
    const { targetId } = await freshTarget()
    const anchor = new Date(Date.now() - 300_000 * 10 - 1000)
    const created = await writeSchedule(handle.db, { expectedRevision: 0, idempotencyKey: newId(), definition: {
      timeRule: { kind: 'interval', intervalMs: 300_000, anchorUtc: anchor.toISOString(), misfire: 'coalesce' },
      consumer: { type: 'knowledge_analysis', targetId, mode: 'run_incremental' },
    } }, actor())
    await setScheduleEnabled(handle.db, created.schedule.scheduleId, { expectedRevision: created.schedule.revision, idempotencyKey: newId(), enabled: true }, actor())
    const { schedules } = schemaFor(handle.db)
    await handle.db.update(schedules).set({ nextDueAt: anchor }).where(eq(schedules.id, created.schedule.scheduleId))
    await materializeDueSchedules(handle.db)
    const updated = await getSchedule(handle.db, created.schedule.scheduleId)
    expect(Date.parse(updated.nextDueAt!)).toBe(anchor.getTime() + 4 * 300_000)
    const occurrences = await listScheduleOccurrences(handle.db, created.schedule.scheduleId, { limit: 20 })
    expect(occurrences.items.filter(item => item.admissionStatus === 'PENDING')).toHaveLength(1)
    expect(occurrences.items.filter(item => item.reason === 'COALESCED')).toHaveLength(3)
  })

  it('增量按筛选范围取批次，冻结高水位，迟到证据进入后续批次', async () => {
    await setFactories({ analysis: true })
    const { targetId } = await freshTarget()
    const ignored = await publishedScenario(targetId)
    const selected = await publishedScenario(targetId)
    const { runs, analysisJobs } = schemaFor(handle.db)
    await handle.db.update(analysisJobs).set({ status: 'CANCELLED' })
    const ids: string[] = []
    for (const scenario of [ignored, ignored, selected]) {
      const run = await writeRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: actor(), idempotencyKey: newId() })
      await handle.db.update(runs).set({ status: 'SUCCEEDED', finishedAt: new Date() }).where(eq(runs.id, run.runId))
      await appendRunEvents(handle.db, run.runId, [{ type: 'run.status_changed', payload: { status: 'SUCCEEDED' } }])
      ids.push(run.runId)
    }
    const input = { targetId, mode: 'run_incremental' as const, source: { scenarioIds: [selected.id], includeFailures: true }, strategyVersion: 'analysis-strategy@1', budget: { maxItems: 1, useAi: false }, actor: actor() }
    const first = await createAnalysisJob(handle.db, input)
    const running = (await claimAnalysisJob(handle.db, 'filtered-owner'))[0]!
    const prepared = await prepareAnalysisJob(handle.db, running, 'filtered-owner')
    expect(prepared.candidates[0]?.sources[0]?.runId).toBe(ids[2])
    await appendRunEvents(handle.db, ids[2]!, [{ type: 'evidence.recorded', payload: { type: 'error', status: 'available' } }])
    const frozen = await prepareAnalysisJob(handle.db, running, 'filtered-owner')
    expect(frozen).toEqual(prepared)
    const done = await executeAnalysisJob(handle.db, running, 'filtered-owner')
    expect(done.checkpointSeq).toBe(first.throughSeq)
    const next = await createAnalysisJob(handle.db, input)
    expect(next.afterSeq).toBe(done.checkpointSeq)
    expect(next.throughSeq).toBeGreaterThan(done.checkpointSeq)
    const nextRunning = (await claimAnalysisJob(handle.db, 'filtered-next'))[0]!
    const nextDone = await executeAnalysisJob(handle.db, nextRunning, 'filtered-next')
    expect(nextDone.candidates?.[0]?.sources[0]?.sourceRevision).toBe(Number(prepared.candidates[0]?.sources[0]?.sourceRevision) + 1)
  })

  it('分析详情、列表与取消均遵守目标范围', async () => {
    const { targetId } = await freshTarget()
    const other = await freshTarget()
    const { consoleAccounts, consoleAccountRoles, consoleRoles } = schemaFor(handle.db)
    const scoped = newId()
    await handle.db.insert(consoleAccounts).values({ id: scoped, displayName: 'scoped', status: 'active' })
    const [role] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: scoped, consoleRoleId: role!.id, targetScopeMode: 'selected', targetScopeIds: [other.targetId] })
    const job = await createAnalysisJob(handle.db, { targetId, mode: 'map_quality', source: { includeFailures: true }, strategyVersion: 'analysis-strategy@1', budget: { maxItems: 1, useAi: false }, actor: actor() })
    await expect(getAnalysisJob(handle.db, job.analysisJobId, scoped)).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
    expect((await listAnalysisJobs(handle.db, { limit: 100 }, scoped)).items).toEqual([])
    await expect(cancelAnalysisJob(handle.db, job.analysisJobId, { kind: 'console', id: scoped }, newId())).rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' })
  })

  it('旧格式分析计划与规范化范围不能重复启用；停用目标不能领取分析', async () => {
    await setFactories({ analysis: true })
    const { targetId } = await freshTarget()
    const { schedules, targets, analysisJobs } = schemaFor(handle.db)
    const definition = { timeRule: { kind: 'interval' as const, intervalMs: 300_000, anchorUtc: new Date().toISOString(), misfire: 'coalesce' as const }, consumer: { type: 'knowledge_analysis' as const, targetId, mode: 'run_incremental' as const, source: { includeFailures: true } } }
    const first = await writeSchedule(handle.db, { expectedRevision: 0, idempotencyKey: newId(), definition }, actor())
    await setScheduleEnabled(handle.db, first.schedule.scheduleId, { expectedRevision: 1, idempotencyKey: newId(), enabled: true }, actor())
    await handle.db.update(schedules).set({ identityGuard: `legacy:${targetId}` }).where(eq(schedules.id, first.schedule.scheduleId))
    const second = await writeSchedule(handle.db, { expectedRevision: 0, idempotencyKey: newId(), definition: { ...definition, consumer: { ...definition.consumer, source: { includeFailures: true, scenarioIds: [], suiteIds: [] } } } }, actor())
    await expect(setScheduleEnabled(handle.db, second.schedule.scheduleId, { expectedRevision: 1, idempotencyKey: newId(), enabled: true }, actor())).rejects.toMatchObject({ code: 'SCHEDULE_IDENTITY_CONFLICT' })
    await handle.db.update(analysisJobs).set({ status: 'CANCELLED' })
    const job = await createAnalysisJob(handle.db, { targetId, mode: 'map_quality', source: { includeFailures: true }, strategyVersion: 'analysis-strategy@1', budget: { maxItems: 1, useAi: false }, actor: actor() })
    await handle.db.update(targets).set({ status: 'disabled' }).where(eq(targets.id, targetId))
    expect(await claimAnalysisJob(handle.db, 'disabled-target-owner')).toEqual([])
    expect((await getAnalysisJob(handle.db, job.analysisJobId)).result?.error).toBe('TARGET_DISABLED')
  })

  it('他人编辑计划保留原执行身份，不隐式接管', async () => {
    const { targetId } = await freshTarget()
    const { consoleAccounts, consoleAccountRoles, consoleRoles, scheduleVersions } = schemaFor(handle.db)
    const editor = newId()
    await handle.db.insert(consoleAccounts).values({ id: editor, displayName: 'editor', status: 'active' })
    const [role] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: editor, consoleRoleId: role!.id, targetScopeMode: 'all' })
    const created = await writeSchedule(handle.db, { expectedRevision: 0, idempotencyKey: newId(), definition: { timeRule: { kind: 'interval', intervalMs: 300_000, anchorUtc: new Date().toISOString(), misfire: 'coalesce' }, consumer: { type: 'knowledge_analysis', targetId, mode: 'map_quality' } } }, actor())
    const updated = await writeSchedule(handle.db, { expectedRevision: 1, idempotencyKey: newId(), definition: { ...created.schedule.definition, name: '只改名称' } }, { kind: 'console', id: editor }, created.schedule.scheduleId)
    const [version] = await handle.db.select().from(scheduleVersions).where(eq(scheduleVersions.id, updated.schedule.currentVersionId))
    expect(version?.authorizedActorId).toBe(actorId)
  })
})
