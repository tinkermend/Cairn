import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  RbacStore,
  createDemonstration,
  getDemonstration,
  claimRecordingArtifactCleanup,
  settleRecordingArtifactCleanup,
} from '@cairn/db'
import { openIsolatedDb, schemaFor, eq, type DbHandle } from '@cairn/db/testing'
import { parseDemonstrationFile } from '@cairn/authoring'
import { syncSha256Bytes } from '@cairn/shared'
import { LocalObjectStore, type ObjectStore, type PutObjectInput } from '@cairn/storage'
import { RecordingArtifactsService } from './artifacts.service'

describe('recording artifacts: real DB, decoding, and object-write faults', () => {
  let handle: DbHandle
  let actorId: string
  const targetId = randomUUID()
  let bytes: Buffer
  beforeAll(async () => {
    handle = await openIsolatedDb(`cairn_di_artifacts_${randomUUID().replaceAll('-', '')}`)
    const rbac = new RbacStore(handle, {
      hash: async (value) => value,
      verify: async (value, hashed) => value === hashed,
    })
    const role = (await rbac.listRoles()).items.find((r) => r.key === 'admin')!
    actorId = (
      await rbac.createAccount(
        {
          email: 'artifacts@example.test',
          displayName: 'Artifact test',
          password: 'Example123!',
          roleIds: [role.id],
        },
        null,
      )
    ).id
    await handle.db.insert(schemaFor(handle.db).targets).values({
      id: targetId,
      code: 'artifact-test',
      name: 'Artifact test',
      entryUrl: 'https://example.test',
    })
    bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
      .png()
      .toBuffer()
  })
  afterAll(async () => {
    await handle?.close()
  })

  async function recording(body = bytes) {
    const source = parseDemonstrationFile({
      targetId,
      captureId: randomUUID(),
      profile: 'midscene-yaml-flow@1',
      text: 'web:\n  url: https://example.test\ntasks:\n  - flow:\n      - aiTap: 查询',
    })
    source.assetManifest.push({
      clientAssetId: 'reviewed',
      kind: 'screenshot',
      digest: syncSha256Bytes(body),
      byteSize: body.length,
      contentType: 'image/png',
      width: 2,
      height: 2,
      redaction: 'locally_reviewed',
    })
    source.facts[0]!.after.screenshotAssetId = 'reviewed'
    return createDemonstration(
      handle,
      { idempotencyKey: randomUUID(), name: 'test', source, acknowledgedOmittedConfig: true },
      { id: actorId },
    )
  }
  function objectStore(
    onPut?: (input: PutObjectInput) => Promise<void>,
    beforeGet?: () => Promise<void>,
  ) {
    const objects = new Map<string, Uint8Array>()
    let writes = 0
    const store: ObjectStore = {
      put: async (input) => {
        writes++
        objects.set(input.key, input.body)
        await onPut?.(input)
        return {
          key: input.key,
          digest: `sha256:${syncSha256Bytes(input.body)}`,
          byteSize: input.body.length,
        }
      },
      get: async (key) => {
        const body = objects.get(key)
        if (!body) throw new Error('not found')
        await beforeGet?.()
        return {
          body,
          head: { key, digest: `sha256:${syncSha256Bytes(body)}`, byteSize: body.length },
        }
      },
      delete: async (key) => {
        objects.delete(key)
      },
      probe: async () => ({ ok: true, latencyMs: 0, errorClass: null }),
    }
    return { store, objects, writes: () => writes }
  }

  it('decodes reviewed images, keeps same-generation uploads idempotent and preserves fact digest', async () => {
    const created = await recording()
    const objects = objectStore()
    const service = new RecordingArtifactsService(handle, objects.store)
    const artifactId = created.artifacts[0]!.id
    const generation = randomUUID()
    for (let i = 0; i < 2; i++)
      expect(
        (await service.upload(created.recordingDraftId, artifactId, generation, bytes, actorId))
          .factDigest,
      ).toBe(created.factDigest)
    expect(objects.writes()).toBe(1)
    expect((await service.read(created.recordingDraftId, artifactId, actorId)).bytes).toEqual(bytes)
  })

  it('uses the production LocalObjectStore digest contract and reads physical bytes back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cairn-di-objects-'))
    try {
      const created = await recording()
      const service = new RecordingArtifactsService(
        handle,
        new LocalObjectStore(directory, 2_097_152),
      )
      const uploaded = await service.upload(
        created.recordingDraftId,
        created.artifacts[0]!.id,
        randomUUID(),
        bytes,
        actorId,
      )
      expect(uploaded.artifacts[0]!.status).toBe('available')
      expect(
        (await service.read(created.recordingDraftId, created.artifacts[0]!.id, actorId)).bytes,
      ).toEqual(bytes)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects invalid compressed pixels even when manifest hash and PNG header match', async () => {
    const corrupt = Buffer.from(bytes)
    const offset = corrupt.indexOf(Buffer.from('IDAT'))
    corrupt.fill(0, offset + 4, offset + 9)
    const created = await recording(corrupt)
    const objects = objectStore()
    await expect(
      new RecordingArtifactsService(handle, objects.store).upload(
        created.recordingDraftId,
        created.artifacts[0]!.id,
        randomUUID(),
        corrupt,
        actorId,
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(objects.writes()).toBe(0)
  })

  it('deletes bytes when object write succeeded but permission was revoked before DB commit', async () => {
    const created = await recording()
    const tables = schemaFor(handle.db)
    const objects = objectStore(async () => {
      await handle.db
        .update(tables.consoleAccounts)
        .set({ status: 'disabled' })
        .where(eq(tables.consoleAccounts.id, actorId))
    })
    try {
      await expect(
        new RecordingArtifactsService(handle, objects.store).upload(
          created.recordingDraftId,
          created.artifacts[0]!.id,
          randomUUID(),
          bytes,
          actorId,
        ),
      ).rejects.toBeDefined()
      expect(objects.objects.size).toBe(0)
      expect(objects.writes()).toBe(1)
    } finally {
      await handle.db
        .update(tables.consoleAccounts)
        .set({ status: 'active' })
        .where(eq(tables.consoleAccounts.id, actorId))
    }
    expect(
      (await getDemonstration(handle, created.recordingDraftId, actorId)).artifacts[0]!.status,
    ).not.toBe('available')
  })

  it('reconciles a put that returns after deletion, including a repeated tombstone sweep', async () => {
    const created = await recording()
    const tables = schemaFor(handle.db)
    const generation = randomUUID()
    const objects = objectStore(async () => {
      await handle.db
        .update(tables.recordingDrafts)
        .set({ deletedAt: new Date() })
        .where(eq(tables.recordingDrafts.id, created.recordingDraftId))
      const claimed = await claimRecordingArtifactCleanup(handle)
      expect(claimed.some((item) => item.id === generation)).toBe(true)
      for (const item of claimed) {
        await objects.store.delete(item.objectKey)
        await settleRecordingArtifactCleanup(handle, item.id)
      }
      // Simulate a storage client writing after the cleanup completed.
      const [upload] = await handle.db
        .select()
        .from(tables.recordingArtifactUploads)
        .where(eq(tables.recordingArtifactUploads.id, generation))
      objects.objects.set(upload!.objectKey, bytes)
    })
    await expect(
      new RecordingArtifactsService(handle, objects.store).upload(
        created.recordingDraftId,
        created.artifacts[0]!.id,
        generation,
        bytes,
        actorId,
      ),
    ).rejects.toBeDefined()
    expect(objects.objects.size).toBe(0)
    expect(objects.writes()).toBe(1)
    for (const item of await claimRecordingArtifactCleanup(handle, {
      now: new Date(Date.now() + 65_000),
    })) {
      await objects.store.delete(item.objectKey)
      await settleRecordingArtifactCleanup(handle, item.id)
    }
    const [artifact] = await handle.db
      .select()
      .from(tables.recordingArtifacts)
      .where(eq(tables.recordingArtifacts.id, created.artifacts[0]!.id))
    expect(artifact!.status).toBe('purged')
  })

  it('rechecks authorization after object read rather than returning bytes after revocation', async () => {
    const created = await recording()
    const tables = schemaFor(handle.db)
    const objects = objectStore(undefined, async () => {
      await handle.db
        .update(tables.consoleAccounts)
        .set({ status: 'disabled' })
        .where(eq(tables.consoleAccounts.id, actorId))
    })
    const service = new RecordingArtifactsService(handle, objects.store)
    await service.upload(
      created.recordingDraftId,
      created.artifacts[0]!.id,
      randomUUID(),
      bytes,
      actorId,
    )
    try {
      await expect(
        service.read(created.recordingDraftId, created.artifacts[0]!.id, actorId),
      ).rejects.toBeDefined()
    } finally {
      await handle.db
        .update(tables.consoleAccounts)
        .set({ status: 'active' })
        .where(eq(tables.consoleAccounts.id, actorId))
    }
  })
})
