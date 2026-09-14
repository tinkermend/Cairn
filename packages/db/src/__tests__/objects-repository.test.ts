import { DRIVERS, openContractDb } from './contract-fixture.js'
import { schemaFor, databaseNow, afterSeconds } from '../native.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { Step } from '@cairn/shared'
import { OBJECT_MISSING_REASONS, objectKeyFor } from '@cairn/shared'
import {
  commitStoredObject,
  createRunWithSnapshot,
  createScenarioWithVersion,
  getStoredObjectById,
  listPurgeCandidates,
  listRunEvidence,
  markStoredObjectPurgeFailed,
  markStoredObjectPurged,
  openIsolatedDb,
  recordMissingObjectEvidence,
  recordObjectEvidence,
  reserveStoredObject,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { newId } from '../id.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'
let consoleAccounts = pg_consoleAccounts
import { targets as pg_targets } from '../schema/targets.js'
let targets = pg_targets

const SCHEMA = `cairn_test_${Date.now().toString(36)}_obj`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000081',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 对象账本 Repository（集成）', { timeout: 30_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let targetId: string
  let scenarioId: string
  let runId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, SCHEMA)
    ;({ consoleAccounts, targets } = schemaFor(handle.db))
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'obj-tester',
      email: `obj-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `obj-${SCHEMA.slice(-6)}`,
      name: '对象夹具',
      entryUrl: 'https://example.com',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '对象账本',
      steps: [echoStep],
      actor: { id: actorId },
    })
    scenarioId = scenario.id
    const created = await createRunWithSnapshot(handle.db, {
      scenarioId,
      actor: { id: actorId },
    })
    runId = created.detail.id
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('reserve → commit → 挂指针；PENDING 不能挂', async () => {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    expect(reserved.objectKey).toBe(objectKeyFor(runId, reserved.id))

    await expect(
      recordObjectEvidence(handle.db, { runId, type: 'log', objectKey: reserved.objectKey }),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_AVAILABLE' })

    const committed = await commitStoredObject(handle.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 4,
      digest: `sha256:${'ab'.repeat(32)}`,
    })
    expect(committed.status).toBe('available')
    expect(committed.contentType).toBe('text/plain')

    const evidence = await recordObjectEvidence(handle.db, {
      runId,
      type: 'log',
      objectKey: reserved.objectKey,
    })
    expect(evidence.objectKey).toBe(reserved.objectKey)
    expect(evidence.contentType).toBe('text/plain')
    expect(evidence.payload).toBeUndefined()

    const listed = await listRunEvidence(handle.db, runId)
    const found = listed.items.find((item) => item.id === evidence.id)
    expect(found?.objectKey).toBe(reserved.objectKey)
    expect(found?.digest).toBe(committed.digest)
  })

  it('过期 PENDING 不能 commit；清理候选按 purge_attempts 排序', async () => {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 1000),
    })
    await expect(
      commitStoredObject(handle.db, {
        id: reserved.id,
        contentType: 'text/plain',
        byteSize: 1,
        digest: `sha256:${'cd'.repeat(32)}`,
        now: new Date(Date.now() + 10_000),
        pendingTtlSeconds: 1,
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_AVAILABLE' })

    const past = new Date(Date.now() - 60_000)
    await handle.db.update(schemaFor(handle.db).storedObjects).set({ createdAt: past }).where(eq(schemaFor(handle.db).storedObjects.id, reserved.id))
    const candidates = await listPurgeCandidates(handle.db, {
      now: new Date(),
      pendingTtlSeconds: 1,
      limit: 100,
    })
    expect(candidates.some((row) => row.id === reserved.id && row.status === 'pending')).toBe(true)

    const marked = await markStoredObjectPurged(handle.db, {
      id: reserved.id,
      expectedStatus: 'pending',
      reason: 'upload_incomplete',
    })
    expect(marked.updated).toBe(true)
    expect((await getStoredObjectById(handle.db, reserved.id))?.status).toBe('purged')
  })

  it('PURGED 后证据补 missingReason；失败计数递增', async () => {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() - 1000),
    })
    await commitStoredObject(handle.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 2,
      digest: `sha256:${'ef'.repeat(32)}`,
    })
    const evidence = await recordObjectEvidence(handle.db, {
      runId,
      type: 'log',
      objectKey: reserved.objectKey,
    })
    expect(evidence.missingReason).toBeUndefined()

    const purged = await markStoredObjectPurged(handle.db, {
      id: reserved.id,
      expectedStatus: 'available',
      reason: 'expired',
    })
    expect(purged.updated).toBe(true)
    const listed = await listRunEvidence(handle.db, runId)
    const found = listed.items.find((item) => item.id === evidence.id)
    expect(found?.objectKey).toBe(reserved.objectKey)
    expect(found?.missingReason).toBe(OBJECT_MISSING_REASONS.purged)
    expect(found?.status).toBe('missing')

    const attempts = await markStoredObjectPurgeFailed(handle.db, { id: reserved.id })
    expect(attempts).toBe(1)
  })

  it('失败证据只写 missingReason，不挂 PENDING 指针', async () => {
    const missing = await recordMissingObjectEvidence(handle.db, {
      runId,
      type: 'log',
      missingReason: OBJECT_MISSING_REASONS.storeUnavailable,
    })
    expect(missing.objectKey).toBeUndefined()
    expect(missing.missingReason).toBe(OBJECT_MISSING_REASONS.storeUnavailable)
    expect(missing.status).toBe('missing')
  })

  it('禁止把 Run A 的对象挂到 Run B', async () => {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    await commitStoredObject(handle.db, {
      id: reserved.id,
      contentType: 'text/plain',
      byteSize: 3,
      digest: `sha256:${'11'.repeat(32)}`,
    })
    const other = await createRunWithSnapshot(handle.db, {
      scenarioId,
      input: { k: 'other' },
      actor: { id: actorId },
    })
    expect(other.detail.id).not.toBe(runId)
    await expect(
      recordObjectEvidence(handle.db, {
        runId: other.detail.id,
        type: 'log',
        objectKey: reserved.objectKey,
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_KEY_INVALID' })
  })
})
