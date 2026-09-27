import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { FACTORY_MAP_JOB_POLICY } from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { cancelMapJob, getMapJob } from '../map/jobs.js'
import { openContractDb } from './contract-fixture.js'

describe('PostgreSQL map job target scope', { timeout: 60_000 }, () => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let creatorId: string
  let readConstrainedId: string
  let mapConstrainedId: string
  let maintainOnlyId: string
  let jobA: string
  let jobB: string

  beforeAll(async () => {
    handle = await openContractDb('postgres')
    const { consoleAccounts, consoleRoles, consoleRolePermissions, consoleAccountRoles,
      targets, targetAccounts, mapJobs } = schemaFor(handle.db)
    creatorId = newId()
    readConstrainedId = newId()
    mapConstrainedId = newId()
    maintainOnlyId = newId()
    const targetA = newId()
    const targetB = newId()
    jobA = newId()
    jobB = newId()
    await handle.db.insert(consoleAccounts).values([
      { id: creatorId, displayName: 'creator', email: `${creatorId}@test.invalid`, status: 'active' },
      { id: readConstrainedId, displayName: 'read-constrained', email: `${readConstrainedId}@test.invalid`, status: 'active' },
      { id: mapConstrainedId, displayName: 'map-constrained', email: `${mapConstrainedId}@test.invalid`, status: 'active' },
      { id: maintainOnlyId, displayName: 'maintain-only', email: `${maintainOnlyId}@test.invalid`, status: 'active' },
    ])
    await handle.db.insert(targets).values([
      { id: targetA, code: `map-job-a-${targetA}`, name: 'A', entryUrl: 'https://a.example' },
      { id: targetB, code: `map-job-b-${targetB}`, name: 'B', entryUrl: 'https://b.example' },
    ])
    const accountA = newId()
    const accountB = newId()
    await handle.db.insert(targetAccounts).values([
      { id: accountA, targetId: targetA, displayName: 'A account', username: 'a', status: 'active', usage: 'both' },
      { id: accountB, targetId: targetB, displayName: 'B account', username: 'b', status: 'active', usage: 'both' },
    ])
    for (const [targetId, targetAccountId, id] of [
      [targetA, accountA, jobA],
      [targetB, accountB, jobB],
    ] as const) {
      await handle.db.insert(mapJobs).values({
        id, targetId, targetAccountId, jobKind: 'map_ingest', jobStatus: 'queued',
        revision: 1, remainingBudgetSeconds: 30, scope: 'full', frozenEntriesJson: [],
        policyRevision: 1, requestJson: {}, frozenPolicyJson: FACTORY_MAP_JOB_POLICY,
        activeGuard: 'Y', createdBy: creatorId,
      })
    }
    for (const accountId of [readConstrainedId, mapConstrainedId]) {
      for (const permission of ['target:read', 'map:read', 'map:maintain'] as const) {
        const roleId = newId()
        const ids = accountId === readConstrainedId
          ? (permission === 'target:read' ? [targetA] : [targetA, targetB])
          : (permission === 'target:read' ? [targetA, targetB] : [targetB])
        await handle.db.insert(consoleRoles).values({ id: roleId, key: `map-job-${roleId}`, name: permission, kind: 'custom' })
        await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: roleId, permission })
        await handle.db.insert(consoleAccountRoles).values({
          consoleAccountId: accountId, consoleRoleId: roleId,
          targetScopeMode: 'selected', targetScopeIds: ids,
        })
      }
    }
    for (const permission of ['target:read', 'map:maintain'] as const) {
      const roleId = newId()
      await handle.db.insert(consoleRoles).values({ id: roleId, key: `map-job-${roleId}`, name: permission, kind: 'custom' })
      await handle.db.insert(consoleRolePermissions).values({ consoleRoleId: roleId, permission })
      await handle.db.insert(consoleAccountRoles).values({
        consoleAccountId: maintainOnlyId, consoleRoleId: roleId,
        targetScopeMode: 'selected', targetScopeIds: [targetA],
      })
    }
  })

  afterAll(async () => { await handle?.close() })

  it('requires target:read and map:read for a job ID, while internal reads remain available', async () => {
    await expect(getMapJob(handle.db, jobB, readConstrainedId)).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    await expect(getMapJob(handle.db, jobA, mapConstrainedId)).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    await expect(getMapJob(handle.db, jobB, '')).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    expect((await getMapJob(handle.db, jobA, readConstrainedId)).jobId).toBe(jobA)
    expect((await getMapJob(handle.db, jobB, mapConstrainedId)).jobId).toBe(jobB)
    expect((await getMapJob(handle.db, jobB)).jobId).toBe(jobB)
  })

  it('rejects cross-target cancellation without changing the job or writing an audit event', async () => {
    const { mapJobs, consoleAuditEvents } = schemaFor(handle.db)
    const [before] = await handle.db.select().from(mapJobs).where(eq(mapJobs.id, jobB))
    await expect(cancelMapJob(handle.db, jobB, { kind: 'console', id: readConstrainedId }, readConstrainedId))
      .rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    await expect(cancelMapJob(handle.db, jobA, { kind: 'console', id: mapConstrainedId }, mapConstrainedId))
      .rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    await expect(cancelMapJob(handle.db, jobB, { kind: 'console', id: readConstrainedId }, ''))
      .rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    await expect(cancelMapJob(handle.db, jobA, { kind: 'console', id: maintainOnlyId }, maintainOnlyId))
      .rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
    const [after] = await handle.db.select().from(mapJobs).where(eq(mapJobs.id, jobB))
    expect(after).toEqual(before)
    expect((await handle.db.select().from(mapJobs).where(eq(mapJobs.id, jobA)))[0]?.jobStatus).toBe('queued')
    expect(await handle.db.select().from(consoleAuditEvents).where(eq(consoleAuditEvents.action, 'map.job.cancel'))).toHaveLength(0)
  })

  it('allows same-target cancellation and preserves internal scheduled cancellation', async () => {
    expect((await cancelMapJob(handle.db, jobA, { kind: 'console', id: readConstrainedId }, readConstrainedId)).jobStatus)
      .toBe('cancelled')
    expect((await cancelMapJob(handle.db, jobB, { kind: 'console', id: creatorId })).jobStatus)
      .toBe('cancelled')
  })
})
