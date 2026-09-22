import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm'
import {
  entityIdSchema,
  fixtureObjectKeyFor,
  RUN_FILE_HANDLE_KIND,
  type ResourceDeletedBy,
  type RunFileHandle,
  type TargetFixtureDto,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, locked, schemaFor } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import type { StoredObjectRow, TargetFixtureRow } from '../records.js'

export const FIXTURE_UPLOAD_DEADLINE_MS = 15 * 60_000

export async function reserveTargetFixtureUpload(
  db: Db,
  input: {
    targetId: string
    scenarioId?: string | null
    name: string
    contentType: string
    byteSize?: number | null
    digest?: string | null
    fixtureId?: string
    generationId?: string
  },
  actorId?: string,
): Promise<{
  fixtureId: string
  objectId: string
  objectKey: string
  generationId: string
  deadlineAt: Date
  alreadyAvailable: boolean
}> {
  entityIdSchema.parse(input.targetId)
  if (input.scenarioId) entityIdSchema.parse(input.scenarioId)
  return atomic(db, async (tx) => {
    if (actorId) {
      await lockConsoleAuthorization(tx, actorId)
      await assertTargetPermission(tx, actorId, input.targetId, 'target:write')
    }
    const { targets, scenarios, targetFixtures, storedObjects } = schemaFor(tx)
    const [target] = await tx
      .select({ id: targets.id })
      .from(targets)
      .where(and(eq(targets.id, input.targetId), isNull(targets.deletedAt)))
      .limit(1)
    if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')

    if (input.scenarioId) {
      const [scenario] = await tx
        .select({ id: scenarios.id })
        .from(scenarios)
        .where(
          and(
            eq(scenarios.id, input.scenarioId),
            eq(scenarios.targetId, input.targetId),
            isNull(scenarios.deletedAt),
          ),
        )
        .limit(1)
      if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '关联场景不存在')
    }

    const fixtureId = input.fixtureId ?? newId()
    const generationId = input.generationId ?? newId()
    const objectKey = fixtureObjectKeyFor(fixtureId)
    const now = new Date()
    const deadlineAt = new Date(now.getTime() + FIXTURE_UPLOAD_DEADLINE_MS)
    const retainUntil = new Date(now.getTime() + 3650 * 86400_000)

    const [existingFixture] = await locked(
      tx,
      tx
        .select()
        .from(targetFixtures)
        .where(and(eq(targetFixtures.id, fixtureId), isNull(targetFixtures.deletedAt)))
        .limit(1),
    )

    if (existingFixture) {
      if (existingFixture.targetId !== input.targetId) {
        throw conflict('FIXTURE_TARGET_MISMATCH', '目标系统不匹配')
      }
      const [existingObject] = await tx
        .select()
        .from(storedObjects)
        .where(and(eq(storedObjects.fixtureId, fixtureId), eq(storedObjects.ownerKind, 'fixture')))
        .limit(1)

      if (
        existingObject &&
        existingObject.status === 'available' &&
        !existingObject.deleteRequestedAt &&
        !existingObject.purgedAt
      ) {
        return {
          fixtureId,
          objectId: existingObject.id,
          objectKey: existingObject.objectKey,
          generationId: existingFixture.uploadGenerationId ?? generationId,
          deadlineAt: existingFixture.uploadDeadlineAt ?? deadlineAt,
          alreadyAvailable: true,
        }
      }

      await tx
        .update(targetFixtures)
        .set({
          name: input.name,
          contentType: input.contentType,
          byteSize: input.byteSize ?? null,
          digest: input.digest ?? null,
          uploadGenerationId: generationId,
          uploadDeadlineAt: deadlineAt,
          updatedAt: now,
        })
        .where(eq(targetFixtures.id, fixtureId))

      let objectId = existingObject?.id
      if (!objectId) {
        objectId = newId()
        await tx.insert(storedObjects).values({
          id: objectId,
          objectKey,
          ownerKind: 'fixture',
          fixtureId,
          status: 'pending',
          contentType: input.contentType,
          byteSize: input.byteSize ?? null,
          digest: input.digest ?? null,
          retainUntil,
          createdAt: now,
        })
      } else {
        await tx
          .update(storedObjects)
          .set({
            status: 'pending',
            contentType: input.contentType,
            byteSize: input.byteSize ?? null,
            digest: input.digest ?? null,
            deleteRequestedAt: null,
            purgedAt: null,
          })
          .where(eq(storedObjects.id, objectId))
      }

      return {
        fixtureId,
        objectId,
        objectKey,
        generationId,
        deadlineAt,
        alreadyAvailable: false,
      }
    }

    const objectId = newId()
    await tx.insert(targetFixtures).values({
      id: fixtureId,
      targetId: input.targetId,
      scenarioId: input.scenarioId ?? null,
      name: input.name,
      contentType: input.contentType,
      byteSize: input.byteSize ?? null,
      digest: input.digest ?? null,
      uploadGenerationId: generationId,
      uploadDeadlineAt: deadlineAt,
      createdByConsoleAccountId: actorId ?? null,
      createdAt: now,
      updatedAt: now,
    })

    await tx.insert(storedObjects).values({
      id: objectId,
      objectKey,
      ownerKind: 'fixture',
      fixtureId,
      status: 'pending',
      contentType: input.contentType,
      byteSize: input.byteSize ?? null,
      digest: input.digest ?? null,
      retainUntil,
      createdAt: now,
    })

    return {
      fixtureId,
      objectId,
      objectKey,
      generationId,
      deadlineAt,
      alreadyAvailable: false,
    }
  })
}

export async function commitTargetFixtureUpload(
  db: Db,
  input: {
    fixtureId: string
    generationId: string
    byteSize: number
    digest: string
  },
  actorId?: string,
): Promise<boolean> {
  entityIdSchema.parse(input.fixtureId)
  return atomic(db, async (tx) => {
    const { targetFixtures, storedObjects } = schemaFor(tx)
    const [fixture] = await locked(
      tx,
      tx
        .select()
        .from(targetFixtures)
        .where(and(eq(targetFixtures.id, input.fixtureId), isNull(targetFixtures.deletedAt)))
        .limit(1),
    )
    if (!fixture) throw notFound('FIXTURE_NOT_FOUND', '测试夹具不存在')
    if (actorId) {
      await lockConsoleAuthorization(tx, actorId)
      await assertTargetPermission(tx, actorId, fixture.targetId, 'target:write')
    }

    if (fixture.uploadGenerationId !== input.generationId) {
      const [obj] = await tx
        .select()
        .from(storedObjects)
        .where(and(eq(storedObjects.fixtureId, fixture.id), eq(storedObjects.ownerKind, 'fixture')))
        .limit(1)
      if (obj?.status === 'available' && fixture.digest === input.digest) {
        return true
      }
      throw conflict('FIXTURE_GENERATION_MISMATCH', '上传代次不匹配')
    }

    if (fixture.uploadDeadlineAt && fixture.uploadDeadlineAt.getTime() < Date.now()) {
      throw conflict('FIXTURE_UPLOAD_EXPIRED', '上传代次已超时')
    }

    if (fixture.digest && fixture.digest !== input.digest) {
      throw conflict('FIXTURE_DIGEST_MISMATCH', '上传内容摘要与预留不符')
    }

    const now = new Date()
    await tx
      .update(storedObjects)
      .set({
        status: 'available',
        availableAt: now,
        byteSize: input.byteSize,
        digest: input.digest,
      })
      .where(and(eq(storedObjects.fixtureId, fixture.id), eq(storedObjects.ownerKind, 'fixture')))

    await tx
      .update(targetFixtures)
      .set({
        byteSize: input.byteSize,
        digest: input.digest,
        uploadGenerationId: null,
        uploadDeadlineAt: null,
        updatedAt: now,
      })
      .where(eq(targetFixtures.id, fixture.id))

    return true
  })
}

export async function abandonTargetFixtureUpload(
  db: Db,
  generationId: string,
): Promise<boolean> {
  return atomic(db, async (tx) => {
    const { targetFixtures, storedObjects } = schemaFor(tx)
    const [fixture] = await locked(
      tx,
      tx
        .select()
        .from(targetFixtures)
        .where(eq(targetFixtures.uploadGenerationId, generationId))
        .limit(1),
    )
    if (!fixture) return false

    const now = new Date()
    await tx
      .update(storedObjects)
      .set({
        status: 'purged',
        purgeReason: 'upload_incomplete',
        purgedAt: now,
        deleteRequestedAt: now,
      })
      .where(and(eq(storedObjects.fixtureId, fixture.id), eq(storedObjects.status, 'pending')))

    if (fixture.byteSize == null) {
      await tx
        .update(targetFixtures)
        .set({
          deletedAt: now,
          uploadGenerationId: null,
          uploadDeadlineAt: null,
          updatedAt: now,
        })
        .where(eq(targetFixtures.id, fixture.id))
    } else {
      await tx
        .update(targetFixtures)
        .set({
          uploadGenerationId: null,
          uploadDeadlineAt: null,
          updatedAt: now,
        })
        .where(eq(targetFixtures.id, fixture.id))
    }
    return true
  })
}

export async function listTargetFixtures(
  db: Db,
  input: {
    targetId: string
    scenarioId?: string | null
    cursor?: string
    limit?: number
  },
  actorId?: string,
): Promise<{ items: TargetFixtureDto[]; nextCursor?: string }> {
  entityIdSchema.parse(input.targetId)
  if (actorId) {
    await assertTargetPermission(db, actorId, input.targetId, 'target:read')
  }
  const { targetFixtures, storedObjects } = schemaFor(db)
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)

  const rows = await db
    .select({
      fixture: targetFixtures,
      object: storedObjects,
    })
    .from(targetFixtures)
    .leftJoin(
      storedObjects,
      and(
        eq(storedObjects.fixtureId, targetFixtures.id),
        eq(storedObjects.ownerKind, 'fixture'),
      ),
    )
    .where(
      and(
        eq(targetFixtures.targetId, input.targetId),
        isNull(targetFixtures.deletedAt),
        input.scenarioId !== undefined
          ? input.scenarioId === null
            ? isNull(targetFixtures.scenarioId)
            : eq(targetFixtures.scenarioId, input.scenarioId)
          : undefined,
        input.cursor
          ? lt(targetFixtures.createdAt, new Date(input.cursor))
          : undefined,
      ),
    )
    .orderBy(desc(targetFixtures.createdAt), desc(targetFixtures.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const slice = hasMore ? rows.slice(0, limit) : rows

  const items: TargetFixtureDto[] = slice.map(({ fixture, object }) => ({
    id: fixture.id,
    targetId: fixture.targetId,
    scenarioId: fixture.scenarioId ?? null,
    name: fixture.name,
    contentType: fixture.contentType,
    byteSize: fixture.byteSize ?? object?.byteSize ?? null,
    digest: fixture.digest ?? object?.digest ?? null,
    available: object?.status === 'available' && !object.deleteRequestedAt && !object.purgedAt,
    createdAt: fixture.createdAt.toISOString(),
    updatedAt: fixture.updatedAt.toISOString(),
  }))

  const nextCursor =
    hasMore && slice.length > 0
      ? slice[slice.length - 1]!.fixture.createdAt.toISOString()
      : undefined
  return { items, nextCursor }
}

export async function getTargetFixtureObject(
  db: Db,
  fixtureId: string,
  actorId?: string,
): Promise<{ fixture: TargetFixtureRow; object: StoredObjectRow }> {
  entityIdSchema.parse(fixtureId)
  const { targetFixtures, storedObjects } = schemaFor(db)
  const [fixture] = await db
    .select()
    .from(targetFixtures)
    .where(and(eq(targetFixtures.id, fixtureId), isNull(targetFixtures.deletedAt)))
    .limit(1)
  if (!fixture) throw notFound('FIXTURE_NOT_FOUND', '测试夹具不存在')

  if (actorId) {
    await assertTargetPermission(db, actorId, fixture.targetId, 'target:read')
  }

  const [object] = await db
    .select()
    .from(storedObjects)
    .where(
      and(
        eq(storedObjects.fixtureId, fixture.id),
        eq(storedObjects.ownerKind, 'fixture'),
        eq(storedObjects.status, 'available'),
        isNull(storedObjects.deleteRequestedAt),
        isNull(storedObjects.purgedAt),
      ),
    )
    .limit(1)
  if (!object) throw notFound('FIXTURE_NOT_AVAILABLE', '测试夹具文件不可用或尚未就绪')

  return { fixture: fixture as TargetFixtureRow, object: object as StoredObjectRow }
}

export async function softDeleteTargetFixture(
  db: Db,
  fixtureId: string,
  actorId?: string,
  deletedBy?: ResourceDeletedBy,
): Promise<void> {
  entityIdSchema.parse(fixtureId)
  await atomic(db, async (tx) => {
    const { targetFixtures, storedObjects, scenarios, scenarioVersions } = schemaFor(tx)
    const [fixture] = await locked(
      tx,
      tx
        .select()
        .from(targetFixtures)
        .where(and(eq(targetFixtures.id, fixtureId), isNull(targetFixtures.deletedAt)))
        .limit(1),
    )
    if (!fixture) throw notFound('FIXTURE_NOT_FOUND', '测试夹具不存在')

    if (actorId) {
      await lockConsoleAuthorization(tx, actorId)
      await assertTargetPermission(tx, actorId, fixture.targetId, 'target:write')
    }

    const publishedVersions = await tx
      .select({
        scenarioId: scenarioVersions.scenarioId,
        definition: scenarioVersions.definition,
      })
      .from(scenarioVersions)
      .innerJoin(
        scenarios,
        and(
          eq(scenarios.id, scenarioVersions.scenarioId),
          eq(scenarios.targetId, fixture.targetId),
          isNull(scenarios.deletedAt),
        ),
      )
      .where(eq(scenarioVersions.kind, 'published'))

    const isReferenced = publishedVersions.some((v) => {
      const defStr = JSON.stringify(v.definition)
      return defStr.includes(fixtureId)
    })

    if (isReferenced) {
      throw conflict('FIXTURE_IN_USE', '该测试夹具已被已发布的场景引用，无法删除')
    }

    const now = new Date()
    const deleteActor: ResourceDeletedBy = deletedBy ?? {
      id: actorId ?? 'system',
      displayName: '系统',
      kind: 'console',
    }

    await tx
      .update(targetFixtures)
      .set({
        deletedAt: now,
        deletedBy: deleteActor,
        updatedAt: now,
      })
      .where(eq(targetFixtures.id, fixture.id))

    await tx
      .update(storedObjects)
      .set({
        deleteRequestedAt: now,
      })
      .where(
        and(
          eq(storedObjects.fixtureId, fixture.id),
          eq(storedObjects.ownerKind, 'fixture'),
          isNull(storedObjects.deleteRequestedAt),
        ),
      )
  })
}

export async function resolveFixtureForRun(
  db: Db,
  input: {
    fixtureId: string
    targetId: string
    digest?: string | null
  },
): Promise<RunFileHandle> {
  entityIdSchema.parse(input.fixtureId)
  entityIdSchema.parse(input.targetId)
  const { targetFixtures, storedObjects } = schemaFor(db)

  const [fixture] = await db
    .select()
    .from(targetFixtures)
    .where(eq(targetFixtures.id, input.fixtureId))
    .limit(1)

  if (!fixture || fixture.deletedAt !== null) {
    throw notFound('FIXTURE_NOT_FOUND', '测试夹具不存在或已删除')
  }

  if (fixture.targetId !== input.targetId) {
    throw conflict('FIXTURE_TARGET_MISMATCH', '测试夹具跨目标引用被拒绝')
  }

  if (input.digest && fixture.digest && fixture.digest !== input.digest) {
    throw conflict('FIXTURE_DIGEST_MISMATCH', '测试夹具摘要校验失败')
  }

  const [object] = await db
    .select()
    .from(storedObjects)
    .where(
      and(
        eq(storedObjects.fixtureId, fixture.id),
        eq(storedObjects.ownerKind, 'fixture'),
      ),
    )
    .limit(1)

  if (!object || object.status !== 'available' || object.deleteRequestedAt || object.purgedAt) {
    throw conflict('FIXTURE_NOT_AVAILABLE', '测试夹具文件不可用')
  }

  return {
    kind: RUN_FILE_HANDLE_KIND,
    scope: 'fixture',
    fixtureId: fixture.id,
    objectKey: object.objectKey,
    name: fixture.name,
    mimeType: fixture.contentType,
    byteSize: fixture.byteSize ?? object.byteSize ?? 0,
    digest: fixture.digest ?? object.digest ?? '',
    createdAt: fixture.createdAt.toISOString(),
  }
}
