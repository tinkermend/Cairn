import { and, asc, desc, eq, inArray, lt, or } from 'drizzle-orm'
import {
  FACTORY_PLATFORM_CONFIG,
  LOCAL_SECRET_PROVIDER,
  modelServiceOrigin,
  PLATFORM_CONFIG_SINGLETON_ID,
  platformConfigCurrentSchema,
  platformConfigDocumentSchema,
  platformConfigDiff,
  platformModelUrlSchema,
  platformConfigRevisionListSchema,
  upgradePlatformConfigDocument,
  PLATFORM_CONFIG_SCHEMA_UNSUPPORTED,
  type PlatformConfigCurrent,
  type PlatformConfigDocument,
  type PlatformConfigRevisionList,
  type PlatformConfigSource,
} from '@cairn/shared'
import { decodeAuditCursor, encodeAuditCursor } from '../audit/cursor.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, schemaFor, updateRows } from '../native.js'
import { badRequest, conflict, isUniqueViolation, notFound } from '../runs/errors.js'
import { listTargetsOutsideFreshnessRange } from '../sessions/auth-profile.js'
import { loadSecretCiphertext, registerStandaloneSecret } from '../secrets/store.js'

export type PlatformBootstrap = {
  document: PlatformConfigDocument
  reason: string
}

function toCurrent(row: {
  revision: number
  document: PlatformConfigDocument
  updatedAt: Date
  updatedByConsoleAccountId: string | null
  reason: string
  source: PlatformConfigSource
}): PlatformConfigCurrent {
  return platformConfigCurrentSchema.parse({
    revision: row.revision,
    document: upgradePlatformConfigDocument(row.document),
    updatedAt: row.updatedAt.toISOString(),
    updatedByAccountId: row.updatedByConsoleAccountId,
    reason: row.reason,
    source: row.source,
  })
}

export async function getPlatformConfig(db: Db): Promise<PlatformConfigCurrent | null> {
  const { platformConfig } = schemaFor(db)
  const [row] = await db
    .select()
    .from(platformConfig)
    .where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID))
    .limit(1)
  return row ? toCurrent(row) : null
}

export async function getOrCreatePlatformConfig(
  db: Db,
  bootstrap: PlatformBootstrap = {
    document: FACTORY_PLATFORM_CONFIG,
    reason: '初始化：出厂默认',
  },
): Promise<PlatformConfigCurrent> {
  const existing = await getPlatformConfig(db)
  if (existing) return existing
  const document = platformConfigDocumentSchema.parse(bootstrap.document)
  try {
    await atomic(db, async (tx) => {
      const { platformConfig, platformConfigRevisions } = schemaFor(tx)
      const now = new Date()
      await tx.insert(platformConfig).values({
        id: PLATFORM_CONFIG_SINGLETON_ID,
        revision: 1,
        document,
        updatedByConsoleAccountId: null,
        reason: bootstrap.reason,
        source: 'bootstrap',
        updatedAt: now,
      })
      await tx.insert(platformConfigRevisions).values({
        id: newId(),
        revision: 1,
        document,
        actorConsoleAccountId: null,
        reason: bootstrap.reason,
        source: 'bootstrap',
        createdAt: now,
      })
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const created = await getPlatformConfig(db)
  if (!created) throw new Error('平台配置初始化失败')
  return created
}

async function writeRevision(
  db: Db,
  input: {
    expectedRevision: number
    document: PlatformConfigDocument
    reason: string
    source: Exclude<PlatformConfigSource, 'bootstrap'>
    actor: AuditActor
    auditAction: 'platform_config.update' | 'platform_config.restore'
    summary: string
    afterWrite?: (tx: Db) => Promise<void>
    notificationMutation?: boolean
  },
): Promise<PlatformConfigCurrent> {
  const document = platformConfigDocumentSchema.parse(input.document)
  const current = await getPlatformConfig(db)
  if (current) {
    const affected = await listTargetsOutsideFreshnessRange(db, document.sessionAuth)
    if (affected.length > 0) {
      throw badRequest('AUTH_FRESHNESS_OUT_OF_RANGE', '已发布规则的新鲜度超出新范围', { targets: affected })
    }
  }
  return atomic(db, async (tx) => {
    const { platformConfig, platformConfigRevisions } = schemaFor(tx)
    const [previous] = await tx.select().from(platformConfig).where(eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID)).for('update')
    if (previous) {
      const { validateNotificationConfigChangeTx } = await import('../notifications/config.js')
      await validateNotificationConfigChangeTx(tx, upgradePlatformConfigDocument(previous.document), document, input.actor.id, input.notificationMutation, input.source === 'restore')
    }
    const now = new Date()
    const nextRevision = input.expectedRevision + 1
    const updated = await updateRows(
      tx,
      platformConfig,
      {
        revision: nextRevision,
        document,
        updatedByConsoleAccountId: input.actor.id,
        reason: input.reason,
        source: input.source,
        updatedAt: now,
      },
      and(
        eq(platformConfig.id, PLATFORM_CONFIG_SINGLETON_ID),
        eq(platformConfig.revision, input.expectedRevision),
      ),
    )
    if (updated.length === 0) {
      const current = await getPlatformConfig(tx)
      throw conflict('PLATFORM_CONFIG_CONFLICT', '平台配置已被他人更新', current)
    }
    await tx.insert(platformConfigRevisions).values({
      id: newId(),
      revision: nextRevision,
      document,
      actorConsoleAccountId: input.actor.id,
      reason: input.reason,
      source: input.source,
      createdAt: now,
    })
    await recordAudit(
      tx,
      { id: input.actor.id },
      input.auditAction,
      'platform_config',
      PLATFORM_CONFIG_SINGLETON_ID,
      input.summary,
    )
    if (input.afterWrite) await input.afterWrite(tx)
    const current = await getPlatformConfig(tx)
    if (!current) throw new Error('平台配置写入后丢失')
    return current
  })
}

export async function updatePlatformConfig(
  db: Db,
  input: {
    expectedRevision: number
    document: PlatformConfigDocument
    reason: string
    actor: AuditActor
    afterWrite?: (tx: Db) => Promise<void>
    notificationMutation?: boolean
  },
): Promise<PlatformConfigCurrent> {
  return writeRevision(db, {
    ...input,
    source: 'update',
    auditAction: 'platform_config.update',
    summary: `更新平台配置到修订 ${input.expectedRevision + 1}`,
  })
}

/**
 * 历史修订只在写回时严格校验：当前代码跑不了的旧文档必须给出可读的拒绝原因，
 * 而不是抛裸 ZodError。
 */
function readRevisionDocument(raw: unknown, revision: number): PlatformConfigDocument {
  try {
    return upgradePlatformConfigDocument(raw)
  } catch (error) {
    throw badRequest(
      'PLATFORM_CONFIG_REVISION_INCOMPATIBLE',
      `修订 ${revision} 的配置与当前版本不兼容，无法恢复`,
      {
        revision,
        reason: error instanceof Error ? error.message : String(error),
        schemaUnsupported:
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === PLATFORM_CONFIG_SCHEMA_UNSUPPORTED,
      },
    )
  }
}

export async function getPlatformConfigRevision(
  db: Db,
  revision: number,
): Promise<PlatformConfigDocument> {
  const { platformConfigRevisions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(platformConfigRevisions)
    .where(eq(platformConfigRevisions.revision, revision))
    .limit(1)
  if (!row) throw notFound('PLATFORM_CONFIG_REVISION_NOT_FOUND', '要恢复的配置修订不存在')
  return readRevisionDocument(row.document, revision)
}

export async function restorePlatformConfig(
  db: Db,
  input: {
    revision: number
    expectedRevision: number
    reason: string
    actor: AuditActor
  },
): Promise<PlatformConfigCurrent> {
  const { platformConfigRevisions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(platformConfigRevisions)
    .where(eq(platformConfigRevisions.revision, input.revision))
    .limit(1)
  if (!row) throw notFound('PLATFORM_CONFIG_REVISION_NOT_FOUND', '要恢复的配置修订不存在')
  return writeRevision(db, {
    expectedRevision: input.expectedRevision,
    document: readRevisionDocument(row.document, input.revision),
    reason: input.reason,
    source: 'restore',
    actor: input.actor,
    auditAction: 'platform_config.restore',
    summary: `从修订 ${input.revision} 恢复平台配置`,
  })
}

export async function registerPlatformAiSecret(
  db: Db,
  input: { id: string; ciphertext: Buffer; baseUrl: string; actor: AuditActor },
): Promise<{ id: string }> {
  const modelOrigin = modelServiceOrigin(platformModelUrlSchema.parse(input.baseUrl))
  return atomic(db, async (tx) => {
    const { platformAiSecretBindings } = schemaFor(tx)
    const registered = await registerStandaloneSecret(tx, {
      id: input.id,
      ciphertext: input.ciphertext,
    })
    await tx.insert(platformAiSecretBindings).values({ secretId: input.id, modelOrigin })
    await recordAudit(
      tx,
      { id: input.actor.id },
      'platform_config.secret',
      'platform_config',
      registered.id,
      '登记浏览器 AI 模型密钥',
    )
    const { syncModelKeyCredential } = await import('../credentials/index.js')
    await syncModelKeyCredential(tx, { secretId: input.id, modelOrigin, actor: input.actor })
    return registered
  })
}

/** 绑定来自登记事实；存量引用使用首次出现的不可变修订，绝不按当前表单重绑。 */
export async function loadPlatformAiSecret(db: Db, secretId: string) {
  const secret = await loadSecretCiphertext(db, secretId)
  if (!secret || secret.provider !== LOCAL_SECRET_PROVIDER) return null
  const { platformAiSecretBindings, platformConfigRevisions } = schemaFor(db)
  const [binding] = await db
    .select()
    .from(platformAiSecretBindings)
    .where(eq(platformAiSecretBindings.secretId, secretId))
    .limit(1)
  if (binding) return { ...secret, modelOrigin: binding.modelOrigin }

  // ponytail: 只有存量未登记绑定的引用扫描历史；大量存量读取时将首次绑定回填到专表。
  const history = await db
    .select({ document: platformConfigRevisions.document })
    .from(platformConfigRevisions)
    .orderBy(asc(platformConfigRevisions.revision))
  for (const row of history) {
    const ai = (row.document as { browserAi?: PlatformConfigDocument['browserAi'] }).browserAi
    if (
      ai?.secretRef?.provider === LOCAL_SECRET_PROVIDER &&
      ai.secretRef.secretId === secretId &&
      ai.baseUrl
    ) {
      return {
        ...secret,
        modelOrigin: modelServiceOrigin(platformModelUrlSchema.parse(ai.baseUrl)),
      }
    }
  }
  return { ...secret, modelOrigin: null }
}

export async function listPlatformConfigRevisions(
  db: Db,
  query: { cursor?: string; limit?: number } = {},
): Promise<PlatformConfigRevisionList> {
  const limit = query.limit ?? 50
  const { platformConfigRevisions } = schemaFor(db)
  const cursor = query.cursor ? decodeAuditCursor(query.cursor) : undefined
  const rows = await db
    .select()
    .from(platformConfigRevisions)
    .where(
      cursor
        ? or(
            lt(platformConfigRevisions.createdAt, cursor.createdAt),
            and(
              eq(platformConfigRevisions.createdAt, cursor.createdAt),
              lt(platformConfigRevisions.id, cursor.id),
            ),
          )
        : undefined,
    )
    .orderBy(desc(platformConfigRevisions.createdAt), desc(platformConfigRevisions.id))
    .limit(limit + 1)

  const slice = rows.slice(0, limit)
  const wanted = new Set(slice.flatMap((row) => [row.revision, row.revision - 1]))
  const history =
    wanted.size === 0
      ? []
      : await db
          .select()
          .from(platformConfigRevisions)
          .where(inArray(platformConfigRevisions.revision, [...wanted]))
  const byRevision = new Map(
    history.map((row) => [row.revision, row.document as Record<string, unknown>] as const),
  )

  const last = slice.at(-1)
  return platformConfigRevisionListSchema.parse({
    items: slice.map((row) => {
      const document = row.document as Record<string, unknown>
      return {
        id: row.id,
        revision: row.revision,
        document,
        actorAccountId: row.actorConsoleAccountId,
        reason: row.reason,
        source: row.source,
        createdAt: row.createdAt.toISOString(),
        diff: platformConfigDiff(byRevision.get(row.revision - 1), document),
      }
    }),
    nextCursor:
      rows.length > limit && last ? encodeAuditCursor(last.createdAt, last.id) : undefined,
  })
}
