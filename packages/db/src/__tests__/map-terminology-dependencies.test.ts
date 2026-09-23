import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  createTerminology,
  updateTerminology,
  findTermsBySource,
  listTermSourceDependencies,
  checkTermSourcesFreshness,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 知识来源关系型依赖索引与读时校验', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_dep_${Date.now().toString(36)}`)
    const { consoleAccounts } = schemaFor(handle.db)
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-dep-test',
      email: `map-dep-${actorId}@example.com`,
      status: 'active',
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  function actor() {
    return { kind: 'console' as const, id: actorId }
  }

  async function freshTarget(codePrefix = 'dep'): Promise<string> {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `${codePrefix}-${id}`,
      name: '依赖测试目标',
      entryUrl: 'https://dep.example',
    })
    return id
  }

  it('创建与更新术语时同步维护关系型依赖索引表并支持反向检索', async () => {
    const targetId = await freshTarget()
    const { analysisJobs, analysisCandidates } = schemaFor(handle.db)

    // Create a mock analysis candidate as source
    const jobId = newId()
    const candidateId = newId()
    await handle.db.insert(analysisJobs).values({
      id: jobId,
      targetId,
      mode: 'run_incremental',
      status: 'SUCCEEDED',
      profileRef: 'default',
      sourceScope: { includeFailures: true },
      strategyVersion: 'analysis-strategy@1',
      budget: { maxItems: 50, useAi: false },
      coverageGaps: [],
      authorizedActorId: actorId,
    })
    await handle.db.insert(analysisCandidates).values({
      id: candidateId,
      jobId,
      targetId,
      kind: 'experience',
      title: '提交按钮',
      summary: '候选术语',
      sources: [{ kind: 'map', targetId }],
      payload: { term: '提交按钮' },
      status: 'pending',
    })

    const term = await createTerminology(
      handle.db,
      targetId,
      {
        idempotencyKey: 'term-create-dep-1',
        canonicalName: '提交按钮',
        aliases: ['SubmitBtn'],
        meaning: '表单最终确认提交按钮',
        sources: [
          {
            kind: 'analysis_candidate',
            jobId,
            candidateId,
          },
        ],
      },
      actor(),
    )

    expect(term.termId).toBeDefined()
    expect(term.revision).toBe(1)

    // 1. 验证关系型依赖索引表已自动写入
    const deps = await listTermSourceDependencies(handle.db, targetId, term.termId, 1)
    expect(deps.length).toBe(1)
    expect(deps[0].sourceKind).toBe('analysis_candidate')
    expect(deps[0].sourceId).toBe(candidateId)
    expect(deps[0].termRevision).toBe(1)

    // 2. 验证反向定位能力
    const reverseTerms = await findTermsBySource(
      handle.db,
      targetId,
      'analysis_candidate',
      candidateId,
    )
    expect(reverseTerms.length).toBe(1)
    expect(reverseTerms[0].termId).toBe(term.termId)

    // 3. 验证读时新鲜度检查（权限和来源存在）
    const freshCheck = await checkTermSourcesFreshness(handle.db, targetId, term.termId, {
      runRead: true,
      workflowRead: true,
      moduleRead: true,
      mapAnalyze: true,
      mapRead: true,
    })
    expect(freshCheck.valid).toBe(true)

    // 4. 验证缺少必要权限时 fail-closed
    const forbiddenCheck = await checkTermSourcesFreshness(handle.db, targetId, term.termId, {
      runRead: false, // analysis_candidate with run_incremental requires runRead
      workflowRead: true,
      moduleRead: true,
      mapAnalyze: true,
      mapRead: true,
    })
    expect(forbiddenCheck.valid).toBe(false)
    expect(forbiddenCheck.reason).toBe('SOURCE_INVALID_OR_REVOKED')

    // 5. 更新术语（r2）增加新依赖
    const candidateId2 = newId()
    await handle.db.insert(analysisCandidates).values({
      id: candidateId2,
      jobId,
      targetId,
      kind: 'experience',
      title: '提交按钮2',
      summary: '候选术语2',
      sources: [{ kind: 'map', targetId }],
      payload: { term: '提交按钮2' },
      status: 'pending',
    })

    const updated = await updateTerminology(
      handle.db,
      targetId,
      term.termId,
      {
        expectedRevision: 1,
        meaning: '表单最终确认提交按钮（已修订）',
        sources: [
          {
            kind: 'analysis_candidate',
            jobId,
            candidateId: candidateId2,
          },
        ],
      },
      actor(),
    )

    expect(updated.revision).toBe(2)
    const depsR2 = await listTermSourceDependencies(handle.db, targetId, term.termId, 2)
    expect(depsR2.length).toBe(1)
    expect(depsR2[0].sourceId).toBe(candidateId2)
  })
})
