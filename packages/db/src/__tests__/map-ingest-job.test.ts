import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FACTORY_MAP_JOB_POLICY, MAP_JOBS_PROTOCOL, SESSION_OCCUPANCY_PROTOCOL, arrivalTargetForName,
  targetStateRuleSchema } from '@cairn/shared'
import { eq } from 'drizzle-orm'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { openContractDb } from './contract-fixture.js'
import { forceGrantForRun } from './lease-harness.js'
import {
  commitMapIngestProgress, completeMapJobSlice, createMapIngestJob, createMapMenuEntry, ensureMapProjection,
  getMapJob, getMapJobPolicy, getTargetKnowledgeContext, getTargetStateRuleConfig,
  registerWorker, recordMapIngestSliceResult,
  sealCompletedMapIngestJobs,
  updateMapJobPolicy, updateTargetStateRuleQueryParams, upsertTargetStateRule, type NativeHandle,
} from '../test-entry.js'

describe('统一地图采集作业', { timeout: 60_000 }, () => {
  let handle: NativeHandle
  let actorId: string
  let targetId: string
  let accountId: string
  let workerId: string
  let instanceId: string

  beforeAll(async () => {
    handle = await openContractDb('postgres', `map_ingest_${Date.now().toString(36)}`)
    const { consoleAccounts, targets, targetAccounts, browserSessions } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()
    accountId = newId()
    workerId = `ingest-${Date.now().toString(36)}`
    instanceId = newId()
    await handle.db.insert(consoleAccounts).values({ id: actorId, displayName: '采集测试', email: `ingest-${actorId}@example.com`, status: 'active' })
    await handle.db.insert(targets).values({ id: targetId, code: `ingest-${targetId}`, name: '采集目标', entryUrl: 'https://shop.example/home', loginUrl: 'https://shop.example/login' })
    await handle.db.insert(targetAccounts).values({ id: accountId, targetId, displayName: '采集账号', username: `ops-${accountId}`, status: 'active', usage: 'both', mapUsageGuard: 'Y' })
    await registerWorker(handle.db, { workerId, instanceId, capacity: 2, lostAfterSeconds: 3600, protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL, MAP_JOBS_PROTOCOL] })
    await handle.db.insert(browserSessions).values({
      id: newId(), targetId, targetAccountId: accountId, status: 'OPEN', health: 'HEALTHY', authState: 'AUTHENTICATED',
      ownerWorkerId: workerId, ownerWorkerInstanceId: instanceId, generation: 1, fencingToken: 1,
      profileKey: 'fixture', reusePolicy: 'NEW_PAGE', idleTtlSeconds: 300, maxLifetimeSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600_000), lastAuthSuccessAt: new Date(),
    })
  })

  afterAll(async () => { await handle?.close() })

  it('页面身份配置保留其他状态规则，拒绝过期修订和重复参数', async () => {
    const ruleTargetId = newId()
    await handle.db.insert(schemaFor(handle.db).targets).values({
      id: ruleTargetId, code: `rule-${ruleTargetId}`, name: '状态规则目标',
      entryUrl: 'https://shop.example/home', loginUrl: 'https://shop.example/login',
    })
    const actor = { kind: 'console' as const, id: actorId }
    expect(await getTargetStateRuleConfig(handle.db, ruleTargetId)).toMatchObject({
      revision: 0, rule: { ruleVersion: 1, ignoreQueryParams: [] },
    })
    await upsertTargetStateRule(handle.db, ruleTargetId, targetStateRuleSchema.parse({
      ruleVersion: 3, routeMatches: [{ pattern: '/orders', name: '订单' }],
    }), actor)
    const updated = await updateTargetStateRuleQueryParams(handle.db, ruleTargetId, {
      expectedRevision: 1, ignoreQueryParams: ['nonce', 'timestamp'], reason: '排除临时参数',
    }, actor)
    expect(updated).toMatchObject({ revision: 2, rule: {
      ruleVersion: 4, ignoreQueryParams: ['nonce', 'timestamp'],
      routeMatches: [{ pattern: '/orders', name: '订单' }],
    } })
    await expect(updateTargetStateRuleQueryParams(handle.db, ruleTargetId, {
      expectedRevision: 1, ignoreQueryParams: [], reason: '旧配置',
    }, actor)).rejects.toMatchObject({ code: 'MAP_REVISION_CONFLICT' })
    await expect(updateTargetStateRuleQueryParams(handle.db, ruleTargetId, {
      expectedRevision: 2, ignoreQueryParams: ['nonce', 'nonce'], reason: '重复',
    }, actor)).rejects.toThrow()
    expect((await getTargetStateRuleConfig(handle.db, ruleTargetId)).rule.ignoreQueryParams)
      .toEqual(['nonce', 'timestamp'])
  })

  it('首次并发维护页面身份规则只接受一个修订', async () => {
    const concurrentTargetId = newId()
    await handle.db.insert(schemaFor(handle.db).targets).values({
      id: concurrentTargetId, code: `concurrent-${concurrentTargetId}`, name: '并发规则目标',
      entryUrl: 'https://shop.example/home', loginUrl: 'https://shop.example/login',
    })
    const actor = { kind: 'console' as const, id: actorId }
    const results = await Promise.allSettled(['nonce', 'timestamp'].map(name =>
      updateTargetStateRuleQueryParams(handle.db, concurrentTargetId, {
        expectedRevision: 0, ignoreQueryParams: [name], reason: '并发初始设置',
      }, actor)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason))
      .toMatchObject([{ code: 'MAP_REVISION_CONFLICT' }])
    expect((await getTargetStateRuleConfig(handle.db, concurrentTargetId)).revision).toBe(1)
  })

  it('多账号未明确选择时不向助手提供任一账号的元素定位', async () => {
    const scopedTargetId = newId()
    const firstAccountId = newId()
    const secondAccountId = newId()
    const { targets, targetAccounts, mapJobs, mapIngestPages } = schemaFor(handle.db)
    await handle.db.insert(targets).values({ id: scopedTargetId, code: `accounts-${scopedTargetId}`,
      name: '多账号目标', entryUrl: 'https://shop.example/home', loginUrl: 'https://shop.example/login' })
    for (const [index, id] of [firstAccountId, secondAccountId].entries()) await handle.db.insert(targetAccounts).values({
      id, targetId: scopedTargetId, displayName: `账号 ${id}`, username: `user-${id}`,
      status: 'active', usage: 'both', mapUsageGuard: index === 0 ? 'Y' : null,
    })
    const entry = await createMapMenuEntry(handle.db, scopedTargetId, {
      name: '报表', url: 'https://shop.example/report', enabled: true,
      arrivalName: '报表', arrivalTarget: arrivalTargetForName('报表'), idempotencyKey: `entry:${newId()}`,
    }, { kind: 'console', id: actorId })
    for (const [index, id] of [firstAccountId, secondAccountId].entries()) {
      const jobId = newId()
      const observedAt = new Date(Date.now() + index * 1000)
      await handle.db.insert(mapJobs).values({ id: jobId, targetId: scopedTargetId, targetAccountId: id,
        jobKind: 'map_ingest', jobStatus: 'completed', revision: 1, remainingBudgetSeconds: 0,
        scope: 'entries', frozenEntriesJson: [], policyRevision: 1, requestJson: {},
        frozenPolicyJson: FACTORY_MAP_JOB_POLICY, createdBy: actorId, createdAt: observedAt, updatedAt: observedAt })
      await handle.db.insert(mapIngestPages).values({ jobId, entryId: entry.entryId, targetId: scopedTargetId,
        targetAccountId: id, pageKey: 'page:report', viewStateKey: 'view:report',
        presentationStateKey: `pres:report:${index}`, arrivalMethod: 'goto', menuPathJson: ['报表'],
        title: '报表', urlPattern: 'https://shop.example/report',
        elementsJson: [{ fingerprint: `column-${index}`, category: 'table_column', role: 'columnheader',
          name: `账号 ${index} 专有列`, locator: arrivalTargetForName(`账号 ${index} 专有列`) }],
        completeness: 'complete', reasonsJson: [], observedAt })
    }
    const implicit = await getTargetKnowledgeContext(handle.db, scopedTargetId, { maxPages: 3 })
    expect(implicit).toMatchObject({ targetAccountId: secondAccountId, accountSelectionAmbiguous: true,
      truncated: true })
    expect(implicit.pages[0]?.views[0]?.elements).toEqual([])
    const explicit = await getTargetKnowledgeContext(handle.db, scopedTargetId,
      { targetAccountId: firstAccountId, maxPages: 3 })
    expect(explicit).toMatchObject({ targetAccountId: firstAccountId, accountSelectionAmbiguous: false })
    expect(explicit.pages[0]?.views[0]?.elements[0]?.name).toBe('账号 0 专有列')
  })

  it('允许同名但 URL 不同的一级菜单分别入库', async () => {
    const sameNameTargetId = newId()
    await handle.db.insert(schemaFor(handle.db).targets).values({
      id: sameNameTargetId, code: `same-menu-${sameNameTargetId}`, name: '同名菜单目标',
      entryUrl: 'https://shop.example/home', loginUrl: 'https://shop.example/login',
    })
    const actor = { kind: 'console' as const, id: actorId }
    for (const url of ['https://shop.example/admin/usage', 'https://shop.example/usage']) {
      await createMapMenuEntry(handle.db, sameNameTargetId, {
        name: 'Usage', url, menuAnchor: { label: 'Usage' }, enabled: true,
        arrivalName: 'Usage', arrivalTarget: arrivalTargetForName('Usage'),
        idempotencyKey: `same-menu:${newId()}`,
      }, actor)
    }
    const rows = await handle.db.select().from(schemaFor(handle.db).mapMenuEntries)
      .where(eq(schemaFor(handle.db).mapMenuEntries.targetId, sameNameTargetId))
    expect(rows.map(row => row.entryUrl).sort()).toEqual([
      'https://shop.example/admin/usage', 'https://shop.example/usage',
    ])
  })

  it('冻结一级菜单并创建只读分片；相同 manualId 幂等', async () => {
    const actor = { kind: 'console' as const, id: actorId }
    const entry = await createMapMenuEntry(handle.db, targetId, {
      name: 'API 令牌', url: 'https://shop.example/tokens', menuAnchor: { label: 'API 令牌' },
      enabled: true, arrivalName: 'API 令牌', arrivalTarget: arrivalTargetForName('API 令牌'),
      idempotencyKey: `entry:${newId()}`,
    }, actor)
    const initial = await getMapJobPolicy(handle.db, targetId)
    const policy = await updateMapJobPolicy(handle.db, targetId, {
      expectedRevision: initial.revision, manualJobsEnabled: true,
      idempotencyKey: `policy:${newId()}`, reason: '开启测试采集',
    }, actor)
    await upsertTargetStateRule(handle.db, targetId,
      targetStateRuleSchema.parse({ ruleVersion: 1, ignoreQueryParams: ['nonce'] }), actor)
    const body = { manualId: `manual:${newId()}`, expectedPolicyRevision: policy.revision, scope: 'full' as const }
    const created = await createMapIngestJob(handle.db, targetId, body, actor)
    expect(created.created).toBe(true)
    expect(created.job.jobKind).toBe('map_ingest')
    expect(created.job.ingestProgress).toMatchObject({ totalEntries: 1, completedEntries: 0 })
    expect(created.job.slices).toHaveLength(1)
    const duplicate = await createMapIngestJob(handle.db, targetId, body, actor)
    expect(duplicate.created).toBe(false)
    expect(duplicate.job.jobId).toBe(created.job.jobId)
    const { runs, mapJobs } = schemaFor(handle.db)
    const [run] = await handle.db.select().from(runs)
    const [job] = await handle.db.select().from(mapJobs).where(eq(mapJobs.id, created.job.jobId))
    expect(run?.snapshot.mapJob?.ingest?.entries[0]?.entryId).toBe(entry.entryId)
    expect(run?.snapshot.steps[0]?.effectType).toBe('READ_ONLY')
    expect(run?.snapshot.steps[0]).toMatchObject({ type: 'map_ingest',
      input: { ignoreQueryParams: ['nonce'] } })
    expect(job?.frozenEntriesJson[0]?.entryId).toBe(entry.entryId)
    const grant = await forceGrantForRun(handle, created.job.slices[0]!.runId, workerId)
    const { stepRuns, attempts } = schemaFor(handle.db)
    const [stepRun] = await handle.db.select().from(stepRuns).where(eq(stepRuns.runId, grant.runId))
    expect(stepRun).toBeDefined()
    const attemptId = newId()
    await handle.db.insert(attempts).values({
      id: attemptId, stepRunId: stepRun!.id, attemptNo: 1, status: 'RUNNING', startedAt: new Date(),
    })
    await commitMapIngestProgress(handle.db, {
      grant, jobId: created.job.jobId, runId: grant.runId,
      stepRunId: stepRun!.id, attemptId,
      cursor: { entryIndex: 0, queue: [], visitedPageKeys: ['page:tokens'],
        entryPageCounts: { [entry.entryId]: 1 }, elapsedSeconds: 5,
        completedEntries: [], processedNodes: 1 },
      page: { jobId: created.job.jobId, entryId: entry.entryId, targetId, targetAccountId: accountId,
        pageKey: 'page:tokens', viewStateKey: 'view:page:tokens:default',
        presentationStateKey: 'pres:view:page:tokens:default:1234567890abcdef', arrivalMethod: 'goto',
        menuPath: ['API 令牌'],
        title: 'API 令牌', urlPattern: 'https://shop.example/tokens',
        elements: [{ fingerprint: 'fingerprint-tokens', category: 'table_column', role: 'columnheader',
          name: '令牌名称', locator: arrivalTargetForName('令牌名称') }],
        completeness: 'complete', reasons: [], observedAt: new Date().toISOString() },
    })
    const { mapObservations, mapIngestPages } = schemaFor(handle.db)
    const facts = await handle.db.select().from(mapObservations)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.sourceType).toBe('map_ingest')
    const [pageFact] = await handle.db.select().from(mapIngestPages)
      .where(eq(mapIngestPages.jobId, created.job.jobId))
    expect(pageFact).toMatchObject({ arrivalMethod: 'goto',
      presentationStateKey: 'pres:view:page:tokens:default:1234567890abcdef' })
    await recordMapIngestSliceResult(handle.db, {
      grant, jobId: created.job.jobId,
      runId: created.job.slices[0]!.runId,
      cursor: {
        entryIndex: 0, queue: [{ entryId: entry.entryId, kind: 'explicit_url', label: 'API 令牌',
          url: 'https://shop.example/tokens', depth: 0, menuPath: ['API 令牌'] }],
        visitedPageKeys: ['page:tokens'], entryPageCounts: { [entry.entryId]: 1 }, elapsedSeconds: 20,
        completedEntries: [], processedNodes: 1,
      },
      nodes: [], blockedPostPaths: [],
      inferredReadPostPaths: [{ path: 'https://shop.example/api/orders/list', count: 2 }],
      inferredReadPostCount: 2,
      blockedImpactCounts: { unclassified: 0, unreadable_ping: 1, verified_non_content_rule: 2 },
      dialogs: 0, detectedMenus: [],
    })
    expect((await getMapJob(handle.db, created.job.jobId)).ingestSummary?.blockedImpactCounts)
      .toEqual({ unclassified: 0, unreadable_ping: 1, verified_non_content_rule: 2 })
    expect(await completeMapJobSlice(handle.db, created.job.slices[0]!.runId, 'completed')).toMatchObject({ continue: true })
    const nextRows = await handle.db.select().from(schemaFor(handle.db).mapJobSlices)
    expect(nextRows).toHaveLength(2)
    const [nextRun] = await handle.db.select().from(runs).where(eq(runs.id, nextRows.find(row => row.sliceOrdinal === 1)!.runId))
    expect(nextRun?.snapshot.steps[0]?.type).toBe('map_ingest')
    expect(nextRun?.snapshot.mapJob?.sliceOrdinal).toBe(1)
    const nextGrant = await forceGrantForRun(handle, nextRun!.id, workerId)
    await recordMapIngestSliceResult(handle.db, {
      grant: nextGrant, jobId: created.job.jobId, runId: nextRun!.id,
      cursor: { entryIndex: 1, queue: [], visitedPageKeys: ['page:tokens'],
        entryPageCounts: { [entry.entryId]: 1 }, elapsedSeconds: 30,
        completedEntries: [entry.entryId], processedNodes: 2 },
      nodes: [{ label: 'API 令牌', code: 'collected', pageKey: 'page:tokens' }],
      blockedPostPaths: [],
      inferredReadPostPaths: [{ path: 'https://shop.example/api/orders/list', count: 1 }],
      inferredReadPostCount: 1,
      blockedImpactCounts: { unclassified: 0, unreadable_ping: 0, verified_non_content_rule: 1 },
      dialogs: 0, detectedMenus: [],
    })
    expect((await getMapJob(handle.db, created.job.jobId)).ingestSummary).toMatchObject({
      outcome: 'complete', inferredReadPostCount: 3,
      inferredReadPostPaths: [{ path: 'https://shop.example/api/orders/list', count: 3 }],
      blockedImpactCounts: {
        unclassified: 0, unreadable_ping: 1, verified_non_content_rule: 3,
      },
    })
    const projection = await ensureMapProjection(handle.db, targetId)
    const { mapJobs: jobsTable, mapProjections, mapReleases } = schemaFor(handle.db)
    await handle.db.update(jobsTable).set({ jobStatus: 'completed', activeGuard: null })
      .where(eq(jobsTable.id, created.job.jobId))
    expect(await sealCompletedMapIngestJobs(handle.db)).toBe(0)
    await handle.db.update(mapProjections).set({ cursor: facts[0]!.ingestSeq, revision: 1 }).where(eq(mapProjections.id, projection.id))
    expect(await sealCompletedMapIngestJobs(handle.db)).toBe(1)
    expect(await sealCompletedMapIngestJobs(handle.db)).toBe(0)
    const sealedJob = await getMapJob(handle.db, created.job.jobId)
    const [release] = await handle.db.select().from(mapReleases)
    expect(sealedJob.releaseId).toBe(release?.id)
    expect(release?.manifest).toMatchObject({ source: 'map_ingest', jobId: created.job.jobId,
      sourceJobInferredReadPostCount: 3 })
  })

  it('过期 Run 租约不能提交采集游标或分片汇总', async () => {
    const scopedTargetId = newId()
    const scopedAccountId = newId()
    const { targets, targetAccounts, browserSessions, runLeases, stepRuns } = schemaFor(handle.db)
    await handle.db.insert(targets).values({
      id: scopedTargetId, code: `stale-${scopedTargetId}`, name: '失效租约目标',
      entryUrl: 'https://shop.example/home', loginUrl: 'https://shop.example/login',
    })
    await handle.db.insert(targetAccounts).values({
      id: scopedAccountId, targetId: scopedTargetId, displayName: '失效租约账号',
      username: `stale-${scopedAccountId}`, status: 'active', usage: 'both', mapUsageGuard: 'Y',
    })
    await handle.db.insert(browserSessions).values({
      id: newId(), targetId: scopedTargetId, targetAccountId: scopedAccountId,
      status: 'OPEN', health: 'HEALTHY', authState: 'AUTHENTICATED',
      ownerWorkerId: workerId, ownerWorkerInstanceId: instanceId, generation: 1, fencingToken: 1,
      profileKey: 'fixture-stale', reusePolicy: 'NEW_PAGE', idleTtlSeconds: 300, maxLifetimeSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600_000), lastAuthSuccessAt: new Date(),
    })
    await createMapMenuEntry(handle.db, scopedTargetId, {
      name: '订单', url: 'https://shop.example/orders', enabled: true,
      arrivalName: '订单', arrivalTarget: arrivalTargetForName('订单'), idempotencyKey: newId(),
    }, { kind: 'console', id: actorId })
    const initial = await getMapJobPolicy(handle.db, scopedTargetId)
    const policy = await updateMapJobPolicy(handle.db, scopedTargetId, {
      expectedRevision: initial.revision, manualJobsEnabled: true,
      idempotencyKey: newId(), reason: '失效租约测试',
    }, { kind: 'console', id: actorId })
    const created = await createMapIngestJob(handle.db, scopedTargetId, {
      manualId: newId(), expectedPolicyRevision: policy.revision, scope: 'full',
    }, { kind: 'console', id: actorId })
    const runId = created.job.slices[0]!.runId
    const grant = await forceGrantForRun(handle, runId, workerId)
    const [step] = await handle.db.select({ id: stepRuns.id }).from(stepRuns).where(eq(stepRuns.runId, runId))
    await handle.db.update(runLeases).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(runLeases.id, grant.leaseId))
    const cursor = { entryIndex: 0, queue: [], visitedPageKeys: [], entryPageCounts: {},
      elapsedSeconds: 5, completedEntries: [], processedNodes: 1 }

    await expect(commitMapIngestProgress(handle.db, {
      grant, jobId: created.job.jobId, runId, stepRunId: step!.id, attemptId: newId(), cursor,
    })).rejects.toMatchObject({ code: 'MAP_FACT_STALE_OWNER' })
    await expect(recordMapIngestSliceResult(handle.db, {
      grant, jobId: created.job.jobId, runId, cursor,
      nodes: [{ label: '订单', code: 'collected' }], blockedPostPaths: [], dialogs: 0, detectedMenus: [],
    })).rejects.toMatchObject({ code: 'MAP_FACT_STALE_OWNER' })
    const job = await getMapJob(handle.db, created.job.jobId)
    expect(job.ingestSummary).toBeNull()
    expect(job.ingestCursor).toBeUndefined()
  })
})
