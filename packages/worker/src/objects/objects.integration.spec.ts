import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commitStoredObject,
  consoleAccounts,
  createRunWithSnapshot,
  createScenarioWithVersion,
  eq,
  getRun,
  getStoredObjectById,
  attempts,
  listRunEvidence,
  newId,
  openIsolatedDb,
  reserveStoredObject,
  sql,
  stepRuns,
  storedObjects,
  targets,
  type DbHandle,
} from '@cairn/db/testing'
import { OBJECT_MISSING_REASONS, type Step } from '@cairn/shared'
import { LocalObjectStore } from '@cairn/storage'
import { ObjectService } from './object.service.js'

const SCHEMA = `cairn_test_${Date.now().toString(36)}_ost`

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000091',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'hello' },
}

describe('对象存储托管协议（集成）', { timeout: 30_000 }, () => {
  let handle: DbHandle
  let dir: string
  let store: LocalObjectStore
  let objects: ObjectService
  let actorId: string
  let targetId: string
  let runId: string
  let otherRunId: string

  beforeAll(async () => {
    handle = await openIsolatedDb(SCHEMA)
    dir = await mkdtemp(join(tmpdir(), 'cairn-wobj-'))
    store = new LocalObjectStore(dir, 1024)
    objects = new ObjectService(handle, store, {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 1024,
    })
    actorId = newId()
    targetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'obj-worker',
      email: `wobj-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `wobj-${SCHEMA.slice(-6)}`,
      name: '对象执行夹具',
      entryUrl: 'https://example.com',
    })
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: '对象协议',
      steps: [echoStep],
      actor: { id: actorId },
    })
    runId = (await createRunWithSnapshot(handle.db, { scenarioId: scenario.id, actor: { id: actorId } }))
      .detail.id
    otherRunId = (
      await createRunWithSnapshot(handle.db, {
        scenarioId: scenario.id,
        input: { k: '1' },
        actor: { id: actorId },
      })
    ).detail.id
  })

  afterAll(async () => {
    await handle?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('put → 挂 log 指针 → get；contentType 来自账本', async () => {
    const body = new TextEncoder().encode('hello-object')
    const evidence = await objects.putObjectEvidence({
      runId,
      body,
      contentType: 'text/plain',
      type: 'log',
    })
    expect(evidence.type).toBe('log')
    expect(evidence.contentType).toBe('text/plain')
    expect(evidence.payload).toBeUndefined()

    const listed = await listRunEvidence(handle.db, runId)
    const found = listed.items.find((item) => item.id === evidence.id)
    expect(found?.objectKey).toBe(evidence.objectKey)
    expect(found?.contentType).toBe('text/plain')

    const got = await objects.getObject(evidence.objectKey!)
    expect(got.contentType).toBe('text/plain')
    expect(got.body).toEqual(body)
    expect(got.head.key).toBe(evidence.objectKey)
  })

  it('commit 后未挂指针：对象仍 AVAILABLE，清理只按 retain_until', async () => {
    const put = await objects.putObject({
      runId,
      body: new TextEncoder().encode('orphan-available'),
      contentType: 'text/plain',
    })
    const before = await listRunEvidence(handle.db, runId)
    expect(before.items.some((item) => item.objectKey === put.objectKey)).toBe(false)
    expect((await getStoredObjectById(handle.db, put.objectId))?.status).toBe('available')

    await handle.db
      .update(storedObjects)
      .set({ retainUntil: new Date(Date.now() - 1000) })
      .where(eq(storedObjects.id, put.objectId))
    const purged = await objects.purgeExpiredObjects({ limit: 100 })
    expect(purged.purged).toBeGreaterThanOrEqual(1)
    expect((await getStoredObjectById(handle.db, put.objectId))?.status).toBe('purged')
    const after = await listRunEvidence(handle.db, otherRunId)
    expect(after.items.some((item) => item.objectKey === put.objectKey)).toBe(false)
  })

  it('put 成功、commit 失败后可同键重试；换字节被拒绝', async () => {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 86_400_000),
    })
    const bytesA = new TextEncoder().encode('first-body')
    await store.put({ key: reserved.objectKey, body: bytesA, contentType: 'text/plain' })
    await expect(
      commitStoredObject(handle.db, {
        id: reserved.id,
        contentType: 'text/plain',
        byteSize: bytesA.byteLength,
        digest: 'sha256:' + '00'.repeat(32),
        now: new Date(Date.now() + 10_000),
        pendingTtlSeconds: 1,
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_AVAILABLE' })
    expect((await getStoredObjectById(handle.db, reserved.id))?.status).toBe('pending')

    await expect(
      objects.putObject({
        runId,
        objectId: reserved.id,
        body: new TextEncoder().encode('second-body'),
        contentType: 'text/plain',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_KEY_CONFLICT' })

    const retried = await objects.putObject({
      runId,
      objectId: reserved.id,
      body: bytesA,
      contentType: 'text/plain',
    })
    expect(retried.objectId).toBe(reserved.id)
    expect((await getStoredObjectById(handle.db, reserved.id))?.status).toBe('available')
  })

  it('PENDING 超过 TTL 清理后不能再 commit', async () => {
    const reserved = await reserveStoredObject(handle.db, {
      runId,
      retainUntil: new Date(Date.now() + 1000),
    })
    const pendingBody = new TextEncoder().encode('pending-bytes')
    await store.put({ key: reserved.objectKey, body: pendingBody, contentType: 'text/plain' })
    expect((await store.get(reserved.objectKey)).body).toEqual(pendingBody)
    await handle.db.execute(
      sql`update cairn.stored_objects set created_at = ${new Date(Date.now() - 10_000)} where id = ${reserved.id}`,
    )
    const shortTtl = new ObjectService(handle, store, {
      retainDays: 30,
      pendingTtlSeconds: 1,
      maxBytes: 1024,
    })
    const result = await shortTtl.purgeExpiredObjects({ limit: 100 })
    expect(result.purged).toBeGreaterThanOrEqual(1)
    const [row] = await handle.db.select().from(storedObjects).where(eq(storedObjects.id, reserved.id))
    expect(row?.status).toBe('purged')
    expect(row?.purgeReason).toBe('upload_incomplete')
    await expect(store.get(reserved.objectKey)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
    await expect(
      commitStoredObject(handle.db, {
        id: reserved.id,
        contentType: 'text/plain',
        byteSize: 1,
        digest: 'sha256:' + '11'.repeat(32),
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_AVAILABLE' })
  })

  it('盘上字节被改后托管 get 报 OBJECT_DIGEST_MISMATCH', async () => {
    const put = await objects.putObject({
      runId,
      body: new TextEncoder().encode('digest-ok'),
      contentType: 'text/plain',
    })
    await writeFile(join(dir, ...put.objectKey.split('/')), 'tampered-bytes')
    await expect(objects.getObject(put.objectKey)).rejects.toMatchObject({
      code: 'OBJECT_DIGEST_MISMATCH',
    })
  })

  it('过期 AVAILABLE 清理后 get 失败，证据保留指针与 object_purged', async () => {
    const evidence = await objects.putObjectEvidence({
      runId,
      body: new TextEncoder().encode('to-expire'),
      contentType: 'text/plain',
      type: 'log',
    })
    const runStatus = (await getRun(handle.db, runId)).status
    await handle.db
      .update(storedObjects)
      .set({ retainUntil: new Date(Date.now() - 1000) })
      .where(eq(storedObjects.objectKey, evidence.objectKey!))
    await objects.purgeExpiredObjects({ limit: 100 })
    await expect(objects.getObject(evidence.objectKey!)).rejects.toMatchObject({
      code: 'OBJECT_NOT_AVAILABLE',
    })
    const listed = await listRunEvidence(handle.db, runId)
    const found = listed.items.find((item) => item.id === evidence.id)
    expect(found?.objectKey).toBe(evidence.objectKey)
    expect(found?.missingReason).toBe(OBJECT_MISSING_REASONS.purged)
    expect(found?.status).toBe('missing')
    expect((await getRun(handle.db, runId)).status).toBe(runStatus)
  })

  it('delete 永久失败的键不饿死同批其他对象', async () => {
    const failing = {
      put: store.put.bind(store),
      get: store.get.bind(store),
      delete: async (key: string) => {
        if (key.includes('fail-me')) {
          throw new Error('bucket policy denied')
        }
        return store.delete(key)
      },
    }
    const svc = new ObjectService(handle, failing, {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 1024,
    })
    const blocked = await objects.putObject({
      runId,
      body: new TextEncoder().encode('blocked'),
      contentType: 'text/plain',
    })
    const other = await objects.putObject({
      runId,
      body: new TextEncoder().encode('other-ok'),
      contentType: 'text/plain',
    })
    await handle.db.execute(
      sql`update cairn.stored_objects set object_key = ${blocked.objectKey + '-fail-me'}, retain_until = ${new Date(Date.now() - 1000)} where id = ${blocked.objectId}`,
    )
    await handle.db
      .update(storedObjects)
      .set({ retainUntil: new Date(Date.now() - 1000) })
      .where(eq(storedObjects.id, other.objectId))

    await svc.purgeExpiredObjects({ limit: 100 })
    await svc.purgeExpiredObjects({ limit: 100 })
    const blockedRow = await getStoredObjectById(handle.db, blocked.objectId)
    expect(blockedRow?.status).toBe('available')
    expect(blockedRow?.purgeAttempts).toBeGreaterThanOrEqual(2)
    expect((await getStoredObjectById(handle.db, other.objectId))?.status).toBe('purged')
  })

  it('put 失败后证据 object_key 为空且带 missing_reason', async () => {
    const before = (await listRunEvidence(handle.db, runId)).items.length
    await expect(
      objects.putObjectEvidence({
        runId,
        body: new Uint8Array(2048),
        contentType: 'text/plain',
        type: 'log',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
    const listed = await listRunEvidence(handle.db, runId)
    const added = listed.items.slice(before)
    expect(added.some((item) => item.objectKey && item.missingReason == null)).toBe(false)
    expect(added.some((item) => item.status === 'missing' && item.missingReason === OBJECT_MISSING_REASONS.storeUnavailable)).toBe(
      true,
    )
    const pendingPointers = added.filter((item) => item.objectKey)
    expect(pendingPointers).toEqual([])
  })

  it('挂指针与清理并发时不会出现可下载的 PURGED 指针', async () => {
    const put = await objects.putObject({
      runId,
      body: new TextEncoder().encode('race'),
      contentType: 'text/plain',
    })
    await handle.db
      .update(storedObjects)
      .set({ retainUntil: new Date(Date.now() - 1000) })
      .where(eq(storedObjects.id, put.objectId))

    const outcomes = await Promise.allSettled([
      objects.recordObjectEvidence({ runId, type: 'log', objectKey: put.objectKey }),
      objects.purgeExpiredObjects({ limit: 100 }),
    ])
    const listed = await listRunEvidence(handle.db, runId)
    const dangling = listed.items.filter(
      (item) => item.objectKey === put.objectKey && !item.missingReason,
    )
    const row = await getStoredObjectById(handle.db, put.objectId)
    expect(row?.status).toBe('purged')
    expect(dangling).toEqual([])
    // 两种合法结局：挂上了指针并被补上 object_purged，或 attach 撞见已清理直接失败。
    const attach = outcomes[0]
    if (attach?.status === 'rejected') {
      expect(attach.reason).toMatchObject({ code: 'OBJECT_NOT_AVAILABLE' })
    } else {
      const attached = listed.items.find((item) => item.objectKey === put.objectKey)
      expect(attached?.missingReason).toBe(OBJECT_MISSING_REASONS.purged)
    }
  })

  let attemptSeq = 1
  async function newAttempt(targetRunId: string) {
    const [step] = await handle.db.select().from(stepRuns).where(eq(stepRuns.runId, targetRunId))
    const attemptId = newId()
    await handle.db.insert(attempts).values({
      id: attemptId,
      stepRunId: step!.id,
      attemptNo: attemptSeq++,
      status: 'RUNNING',
      startedAt: new Date(),
    })
    return attemptId
  }

  it('同一调用内第一次 put 失败、退避后第二次成功，对象只有一份', async () => {
    const attemptId = await newAttempt(runId)
    let puts = 0
    const flaky = {
      put: async (input: { key: string; body: Uint8Array; contentType: string }) => {
        puts += 1
        if (puts === 1) throw new Error('s3 5xx')
        return store.put(input)
      },
      get: store.get.bind(store),
      delete: store.delete.bind(store),
    }
    const svc = new ObjectService(handle, flaky, {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 1024,
      uploadMaxAttempts: 3,
      uploadBackoffMs: 0,
    })
    const body = new TextEncoder().encode('retry-shot')
    const saved = await svc.putObjectEvidence({
      runId,
      attemptId,
      type: 'screenshot',
      body,
      contentType: 'image/png',
    })
    expect(saved.status).toBe('available')
    expect(puts).toBe(2)
    const objects = await handle.db.select().from(storedObjects).where(eq(storedObjects.runId, runId))
    expect(objects.filter((row) => row.objectKey === saved.objectKey)).toHaveLength(1)
  })

  it('同一调用内连续失败直到上限后判 missing', async () => {
    const attemptId = await newAttempt(runId)
    const failing = {
      put: async () => {
        throw new Error('still down')
      },
      get: store.get.bind(store),
      delete: store.delete.bind(store),
    }
    const svc = new ObjectService(handle, failing, {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 1024,
      uploadMaxAttempts: 2,
      uploadBackoffMs: 0,
    })
    await expect(
      svc.putObjectEvidence({
        runId,
        attemptId,
        type: 'screenshot',
        body: new TextEncoder().encode('bounded'),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/still down/)
    const row = (await listRunEvidence(handle.db, runId)).items.find((item) => item.attemptId === attemptId)
    expect(row?.status).toBe('missing')
    expect(row?.missingReason).toBe(OBJECT_MISSING_REASONS.storeUnavailable)
  })

  it('put 已成功、证据 commit 失败时重试只补证据，不再 put', async () => {
    const attemptId = await newAttempt(runId)
    let puts = 0
    const counting = {
      put: async (input: { key: string; body: Uint8Array; contentType: string }) => {
        puts += 1
        return store.put(input)
      },
      get: store.get.bind(store),
      delete: store.delete.bind(store),
    }
    let interrupted = false
    const svc = new ObjectService(handle, counting, {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 1024,
      uploadMaxAttempts: 3,
      uploadBackoffMs: 0,
      afterObjectPut: async () => {
        if (!interrupted) {
          interrupted = true
          throw new Error('commit evidence interrupted')
        }
      },
    })
    const saved = await svc.putObjectEvidence({
      runId,
      attemptId,
      type: 'screenshot',
      body: new TextEncoder().encode('after-put'),
      contentType: 'image/png',
    })
    expect(saved.status).toBe('available')
    expect(puts).toBe(1)
    const objects = await handle.db.select().from(storedObjects).where(eq(storedObjects.runId, runId))
    expect(objects.filter((row) => row.objectKey === saved.objectKey)).toHaveLength(1)
  })

  it('Trace 超限不上传，记 trace_too_large', async () => {
    const attemptId = await newAttempt(runId)
    const svc = new ObjectService(handle, store, {
      retainDays: 30,
      pendingTtlSeconds: 3600,
      maxBytes: 1024,
      traceMaxBytes: 16,
      uploadMaxAttempts: 3,
    })
    await expect(
      svc.putObjectEvidence({
        runId,
        attemptId,
        type: 'trace',
        body: new Uint8Array(64),
        contentType: 'application/zip',
      }),
    ).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
    const row = (await listRunEvidence(handle.db, runId)).items.find(
      (item) => item.attemptId === attemptId && item.type === 'trace',
    )
    expect(row?.status).toBe('missing')
    expect(row?.missingReason).toBe(OBJECT_MISSING_REASONS.traceTooLarge)
    expect(row?.objectKey).toBeUndefined()
  })
})
