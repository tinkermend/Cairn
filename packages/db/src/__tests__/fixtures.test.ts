import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  reserveTargetFixtureUpload,
  commitTargetFixtureUpload,
  abandonTargetFixtureUpload,
  listTargetFixtures,
  getTargetFixtureObject,
  softDeleteTargetFixture,
  resolveFixtureForRun,
} from '../fixtures/fixtures.js'

describe.each(DRIVERS)('%s target fixtures domain operations', (driver) => {
  let handle: DbHandle
  let targetId: string
  let scenarioId: string
  let accountId: string

  beforeAll(async () => {
    handle = await openContractDb(driver)
    const t = schemaFor(handle.db)
    targetId = newId()
    scenarioId = newId()
    accountId = newId()

    await handle.db.insert(t.consoleAccounts).values({
      id: accountId,
      displayName: '测试账号',
      email: `${accountId}@example.com`,
      status: 'active',
    })

    await handle.db.insert(t.targets).values({
      id: targetId,
      code: `target-${targetId.slice(0, 8)}`,
      name: '测试上传目标',
      entryUrl: 'https://example.com',
    })

    await handle.db.insert(t.scenarios).values({
      id: scenarioId,
      targetId,
      name: '测试场景',
      createdByConsoleAccountId: accountId,
    })
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('reserves, commits, and resolves a fixture upload', async () => {
    const reserved = await reserveTargetFixtureUpload(handle.db, {
      targetId,
      scenarioId,
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      byteSize: 1024,
      digest: 'sha256:abcd1234',
    })

    expect(reserved.fixtureId).toBeTruthy()
    expect(reserved.objectId).toBeTruthy()
    expect(reserved.objectKey).toContain(`v1/fixtures/${reserved.fixtureId}`)
    expect(reserved.alreadyAvailable).toBe(false)

    // Attempting to resolve before commit fails
    await expect(
      resolveFixtureForRun(handle.db, {
        fixtureId: reserved.fixtureId,
        targetId,
      }),
    ).rejects.toThrow()

    // Commit the upload
    const committed = await commitTargetFixtureUpload(handle.db, {
      fixtureId: reserved.fixtureId,
      generationId: reserved.generationId,
      byteSize: 1024,
      digest: 'sha256:abcd1234',
    })
    expect(committed).toBe(true)

    // Now resolveFixtureForRun succeeds and returns RunFileHandle
    const handleResult = await resolveFixtureForRun(handle.db, {
      fixtureId: reserved.fixtureId,
      targetId,
      digest: 'sha256:abcd1234',
    })

    expect(handleResult.kind).toBe('cairn.file/v1')
    expect(handleResult.scope).toBe('fixture')
    expect(handleResult.fixtureId).toBe(reserved.fixtureId)
    expect(handleResult.name).toBe('invoice.pdf')
    expect(handleResult.mimeType).toBe('application/pdf')
    expect(handleResult.byteSize).toBe(1024)
    expect(handleResult.digest).toBe('sha256:abcd1234')

    // Cross-target resolve is rejected
    await expect(
      resolveFixtureForRun(handle.db, {
        fixtureId: reserved.fixtureId,
        targetId: newId(),
      }),
    ).rejects.toThrow(/跨目标/)

    // Digest mismatch is rejected
    await expect(
      resolveFixtureForRun(handle.db, {
        fixtureId: reserved.fixtureId,
        targetId,
        digest: 'sha256:wrongdigest',
      }),
    ).rejects.toThrow(/摘要/)
  })

  it('rejects commit with wrong generationId or mismatched digest', async () => {
    const reserved = await reserveTargetFixtureUpload(handle.db, {
      targetId,
      name: 'avatar.png',
      contentType: 'image/png',
      digest: 'sha256:correct',
    })

    // Wrong generationId
    await expect(
      commitTargetFixtureUpload(handle.db, {
        fixtureId: reserved.fixtureId,
        generationId: newId(),
        byteSize: 2048,
        digest: 'sha256:correct',
      }),
    ).rejects.toThrow(/上传代次/)

    // Wrong digest
    await expect(
      commitTargetFixtureUpload(handle.db, {
        fixtureId: reserved.fixtureId,
        generationId: reserved.generationId,
        byteSize: 2048,
        digest: 'sha256:different',
      }),
    ).rejects.toThrow(/摘要/)
  })

  it('abandons a pending fixture upload', async () => {
    const reserved = await reserveTargetFixtureUpload(handle.db, {
      targetId,
      name: 'abandon_me.txt',
      contentType: 'text/plain',
    })

    const abandoned = await abandonTargetFixtureUpload(handle.db, reserved.generationId)
    expect(abandoned).toBe(true)

    // Cannot resolve or get
    await expect(
      getTargetFixtureObject(handle.db, reserved.fixtureId),
    ).rejects.toThrow()
  })

  it('lists fixtures and supports pagination', async () => {
    const res1 = await reserveTargetFixtureUpload(handle.db, {
      targetId,
      scenarioId,
      name: 'list_test_1.txt',
      contentType: 'text/plain',
      byteSize: 10,
      digest: 'sha256:item1',
    })
    await commitTargetFixtureUpload(handle.db, {
      fixtureId: res1.fixtureId,
      generationId: res1.generationId,
      byteSize: 10,
      digest: 'sha256:item1',
    })

    const list = await listTargetFixtures(handle.db, {
      targetId,
      scenarioId,
    })
    expect(list.items.length).toBeGreaterThanOrEqual(1)
    const found = list.items.find((i) => i.id === res1.fixtureId)
    expect(found).toBeDefined()
    expect(found?.available).toBe(true)
    expect(found?.name).toBe('list_test_1.txt')
  })

  it('soft-deletes a fixture and cascades deleteRequestedAt to stored_objects', async () => {
    const reserved = await reserveTargetFixtureUpload(handle.db, {
      targetId,
      name: 'to_delete.pdf',
      contentType: 'application/pdf',
      byteSize: 500,
      digest: 'sha256:del1',
    })
    await commitTargetFixtureUpload(handle.db, {
      fixtureId: reserved.fixtureId,
      generationId: reserved.generationId,
      byteSize: 500,
      digest: 'sha256:del1',
    })

    const { object } = await getTargetFixtureObject(handle.db, reserved.fixtureId)
    expect(object.status).toBe('available')

    await softDeleteTargetFixture(handle.db, reserved.fixtureId)

    // After soft deletion, getTargetFixtureObject throws notFound
    await expect(getTargetFixtureObject(handle.db, reserved.fixtureId)).rejects.toThrow()

    // And resolveFixtureForRun throws
    await expect(
      resolveFixtureForRun(handle.db, {
        fixtureId: reserved.fixtureId,
        targetId,
      }),
    ).rejects.toThrow()

    // Verification that stored_objects.deleteRequestedAt is set
    const t = schemaFor(handle.db)
    const { eq } = await import('drizzle-orm')
    const [storedObj] = await handle.db
      .select()
      .from(t.storedObjects)
      .where(eq(t.storedObjects.fixtureId, reserved.fixtureId))
    expect(storedObj?.deleteRequestedAt).not.toBeNull()
  })

  it('refuses soft deletion if referenced by a published scenario', async () => {
    const reserved = await reserveTargetFixtureUpload(handle.db, {
      targetId,
      name: 'referenced.pdf',
      contentType: 'application/pdf',
      byteSize: 300,
      digest: 'sha256:ref1',
    })
    await commitTargetFixtureUpload(handle.db, {
      fixtureId: reserved.fixtureId,
      generationId: reserved.generationId,
      byteSize: 300,
      digest: 'sha256:ref1',
    })

    // Create a published scenario version referencing this fixtureId
    const t = schemaFor(handle.db)
    await handle.db.insert(t.scenarioVersions).values({
      id: newId(),
      scenarioId,
      versionNo: 1,
      kind: 'published',
      sourceDigest: 'sha256:source',
      definition: {
        id: scenarioId,
        steps: [
          {
            id: newId(),
            type: 'upload',
            input: {
              files: [
                {
                  from: 'asset',
                  fixtureId: reserved.fixtureId,
                },
              ],
            },
          },
        ],
      } as any,
      createdByConsoleAccountId: accountId,
    })

    await expect(
      softDeleteTargetFixture(handle.db, reserved.fixtureId),
    ).rejects.toThrow(/已发布/)
  })
})
