import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  RELIABILITY_ERROR_CODES,
  type IncidentLineage,
  type IncidentSeverity,
  type IncidentStatus,
  type ReliabilityIncidentDto,
  type ReliabilityIncidentMemberDto,
  type ReliabilitySignalDto,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { cursorFilter, encodeCursor } from '../cursor.js'
import { newId } from '../id.js'
import { atomic, clockNow, schemaFor } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'

export interface ListIncidentsQuery {
  targetId?: string
  status?: IncidentStatus
  severity?: IncidentSeverity
  assetKind?: 'scenario' | 'action_module'
  assetId?: string
  search?: string
  cursor?: string
  limit?: number
  offset?: number
}

export async function listIncidents(
  db: Db,
  query: ListIncidentsQuery,
): Promise<{ items: ReliabilityIncidentDto[]; nextCursor?: string | null; total: number }> {
  const { reliabilityIncidents } = schemaFor(db)
  const limit = Math.min(query.limit ?? 50, 100)
  const offset = query.offset ?? 0

  const filterConditions = [
    query.targetId ? eq(reliabilityIncidents.targetId, query.targetId) : sql`1=1`,
    query.status ? eq(reliabilityIncidents.status, query.status) : sql`1=1`,
    query.severity ? eq(reliabilityIncidents.severity, query.severity) : sql`1=1`,
    query.assetId ? sql`${reliabilityIncidents.groupingKey} LIKE ${'%' + query.assetId + '%'}` : sql`1=1`,
    query.search
      ? sql`(${reliabilityIncidents.title} LIKE ${'%' + query.search + '%'} OR ${reliabilityIncidents.summary} LIKE ${'%' + query.search + '%'} OR ${reliabilityIncidents.groupingKey} LIKE ${'%' + query.search + '%'})`
      : sql`1=1`,
  ]

  const queryConditions = [...filterConditions]
  if (query.cursor) {
    const cFilter = cursorFilter(reliabilityIncidents.lastSeenAt, reliabilityIncidents.id, query.cursor)
    if (cFilter) queryConditions.push(cFilter)
  }

  const rows = await db
    .select()
    .from(reliabilityIncidents)
    .where(and(...queryConditions))
    .orderBy(desc(reliabilityIncidents.lastSeenAt), desc(reliabilityIncidents.id))
    .limit(limit + 1)
    .offset(query.cursor ? 0 : offset)

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(reliabilityIncidents)
    .where(and(...filterConditions))

  const hasMore = rows.length > limit
  const pagedRows = hasMore ? rows.slice(0, limit) : rows
  const lastItem = pagedRows.at(-1)
  const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.lastSeenAt, lastItem.id) : null

  const items: ReliabilityIncidentDto[] = pagedRows.map((r) => ({
    id: r.id,
    targetId: r.targetId,
    groupingKey: r.groupingKey,
    scopeDigest: r.scopeDigest,
    severity: r.severity as IncidentSeverity,
    status: r.status as IncidentStatus,
    actionRequiredReason: r.actionRequiredReason ?? undefined,
    memberCount: r.memberCount,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    title: r.title,
    summary: r.summary,
    rootCauseHypothesis: r.rootCauseHypothesis ?? undefined,
    evidenceScores: r.evidenceScores as any,
    silencedUntil: r.silencedUntil?.toISOString(),
    dismissedReason: r.dismissedReason ?? undefined,
    lineage: (r.lineage as IncidentLineage) ?? undefined,
    revision: r.revision,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))

  return { items, total: Number(countRow?.count ?? 0) }
}

export async function getIncidentDetail(
  db: Db,
  incidentId: string,
): Promise<{ incident: ReliabilityIncidentDto; members: ReliabilityIncidentMemberDto[] }> {
  const { reliabilityIncidents, reliabilityIncidentMembers } = schemaFor(db)

  const [row] = await db
    .select()
    .from(reliabilityIncidents)
    .where(eq(reliabilityIncidents.id, incidentId))
  if (!row) {
    throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '未找到指定的可靠性事件')
  }

  const memberRows = await db
    .select()
    .from(reliabilityIncidentMembers)
    .where(eq(reliabilityIncidentMembers.incidentId, incidentId))

  const incident: ReliabilityIncidentDto = {
    id: row.id,
    targetId: row.targetId,
    groupingKey: row.groupingKey,
    scopeDigest: row.scopeDigest,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    actionRequiredReason: row.actionRequiredReason ?? undefined,
    memberCount: row.memberCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    title: row.title,
    summary: row.summary,
    rootCauseHypothesis: row.rootCauseHypothesis ?? undefined,
    evidenceScores: row.evidenceScores as any,
    silencedUntil: row.silencedUntil?.toISOString(),
    dismissedReason: row.dismissedReason ?? undefined,
    lineage: (row.lineage as IncidentLineage) ?? undefined,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }

  const members: ReliabilityIncidentMemberDto[] = memberRows.map((m) => ({
    id: m.id,
    incidentId: m.incidentId,
    memberRef: m.memberRef,
    memberType: m.memberType,
    joinedAt: m.joinedAt.toISOString(),
  }))

  return { incident, members }
}

export interface MergeIncidentsInput {
  sourceIncidentIds: string[]
  targetIncidentId: string
  reason?: string
  expectedRevision?: number
  actorId?: string
}

export async function mergeIncidents(
  db: Db,
  input: MergeIncidentsInput,
): Promise<ReliabilityIncidentDto> {
  return atomic(db, async (tx) => {
    const { reliabilityIncidents, reliabilityIncidentMembers } = schemaFor(tx)
    const now = await clockNow(tx)

    // Check target incident
    const [target] = await tx
      .select()
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.id, input.targetIncidentId))
    if (!target) {
      throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '目标可靠性事件不存在')
    }
    if (input.expectedRevision !== undefined && target.revision !== input.expectedRevision) {
      throw conflict(RELIABILITY_ERROR_CODES.INCIDENT_REVISION_CONFLICT, '事件版本冲突，请刷新后重试')
    }

    // Reparent members from sources
    for (const sourceId of input.sourceIncidentIds) {
      if (sourceId === input.targetIncidentId) continue
      const [src] = await tx
        .select()
        .from(reliabilityIncidents)
        .where(eq(reliabilityIncidents.id, sourceId))
      if (!src) continue

      // Reparent members
      await tx
        .update(reliabilityIncidentMembers)
        .set({ incidentId: input.targetIncidentId })
        .where(eq(reliabilityIncidentMembers.incidentId, sourceId))

      // Mark source incident as merged
      await tx
        .update(reliabilityIncidents)
        .set({
          status: 'RESOLVED',
          summary: `已合并至 ${input.targetIncidentId}: ${input.reason}`,
          lineage: { parentIncidentId: input.targetIncidentId },
          revision: src.revision + 1,
          updatedAt: now,
        })
        .where(eq(reliabilityIncidents.id, sourceId))
    }

    // Count updated members
    const [memberCountRow] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(reliabilityIncidentMembers)
      .where(eq(reliabilityIncidentMembers.incidentId, input.targetIncidentId))

    const existingLineage = (target.lineage as IncidentLineage) ?? {}
    const updatedMergedFrom = Array.from(
      new Set([...(existingLineage.mergedFrom ?? []), ...input.sourceIncidentIds]),
    )

    const nextRev = target.revision + 1
    await tx
      .update(reliabilityIncidents)
      .set({
        memberCount: Number(memberCountRow?.count ?? target.memberCount),
        lineage: { ...existingLineage, mergedFrom: updatedMergedFrom },
        revision: nextRev,
        updatedAt: now,
      })
      .where(eq(reliabilityIncidents.id, input.targetIncidentId))

    const { incident } = await getIncidentDetail(tx, input.targetIncidentId)
    return incident
  })
}

export interface SplitIncidentsInput {
  incidentId: string
  memberRefs: string[]
  newTitle?: string
  reason?: string
  expectedRevision?: number
  actorId?: string
}

export async function splitIncidents(
  db: Db,
  input: SplitIncidentsInput,
): Promise<{ sourceIncident: ReliabilityIncidentDto; newIncident: ReliabilityIncidentDto }> {
  return atomic(db, async (tx) => {
    const { reliabilityIncidents, reliabilityIncidentMembers } = schemaFor(tx)
    const now = await clockNow(tx)

    const [source] = await tx
      .select()
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.id, input.incidentId))
    if (!source) {
      throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '源可靠性事件不存在')
    }
    if (input.expectedRevision !== undefined && source.revision !== input.expectedRevision) {
      throw conflict(RELIABILITY_ERROR_CODES.INCIDENT_REVISION_CONFLICT, '事件版本冲突，请刷新后重试')
    }

    const newIdVal = newId()
    // Create new incident
    await tx.insert(reliabilityIncidents).values({
      id: newIdVal,
      targetId: source.targetId,
      groupingKey: `${source.groupingKey}_split_${now.getTime()}`,
      scopeDigest: source.scopeDigest,
      severity: source.severity,
      status: 'DETECTED',
      memberCount: input.memberRefs.length,
      firstSeenAt: now,
      lastSeenAt: now,
      title: input.newTitle ?? `${source.title} (拆分)`,
      summary: input.reason ? `从事件 ${input.incidentId} 拆分: ${input.reason}` : `从事件 ${input.incidentId} 拆分`,
      evidenceScores: source.evidenceScores,
      lineage: { splitFrom: input.incidentId },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })

    // Reparent selected members
    if (input.memberRefs.length > 0) {
      await tx
        .update(reliabilityIncidentMembers)
        .set({ incidentId: newIdVal })
        .where(
          and(
            eq(reliabilityIncidentMembers.incidentId, input.incidentId),
            inArray(reliabilityIncidentMembers.memberRef, input.memberRefs),
          ),
        )
    }

    // Update source incident count & revision
    const [countRow] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(reliabilityIncidentMembers)
      .where(eq(reliabilityIncidentMembers.incidentId, input.incidentId))

    await tx
      .update(reliabilityIncidents)
      .set({
        memberCount: Number(countRow?.count ?? 0),
        revision: source.revision + 1,
        updatedAt: now,
      })
      .where(eq(reliabilityIncidents.id, input.incidentId))

    const { incident: sourceIncident } = await getIncidentDetail(tx, input.incidentId)
    const { incident: newIncident } = await getIncidentDetail(tx, newIdVal)
    return { sourceIncident, newIncident }
  })
}

export async function dismissIncident(
  db: Db,
  input: { incidentId: string; reason: string; expectedRevision?: number; actorId?: string },
): Promise<ReliabilityIncidentDto> {
  return atomic(db, async (tx) => {
    const { reliabilityIncidents } = schemaFor(tx)
    const now = await clockNow(tx)

    const [row] = await tx
      .select()
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.id, input.incidentId))
    if (!row) {
      throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '可靠性事件不存在')
    }
    if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
      throw conflict(RELIABILITY_ERROR_CODES.INCIDENT_REVISION_CONFLICT, '事件版本冲突，请刷新后重试')
    }

    await tx
      .update(reliabilityIncidents)
      .set({
        status: 'DISMISSED',
        dismissedReason: input.reason,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(reliabilityIncidents.id, input.incidentId))

    const { incident } = await getIncidentDetail(tx, input.incidentId)
    return incident
  })
}

export async function silenceIncident(
  db: Db,
  input: { incidentId: string; durationMinutes?: number; durationHours?: number; reason?: string; expectedRevision?: number; actorId?: string },
): Promise<ReliabilityIncidentDto> {
  return atomic(db, async (tx) => {
    const { reliabilityIncidents } = schemaFor(tx)
    const now = await clockNow(tx)
    const minutes = input.durationMinutes ?? (input.durationHours ? input.durationHours * 60 : 60)
    const silencedUntil = new Date(now.getTime() + minutes * 60 * 1000)

    const [row] = await tx
      .select()
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.id, input.incidentId))
    if (!row) {
      throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '可靠性事件不存在')
    }
    if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
      throw conflict(RELIABILITY_ERROR_CODES.INCIDENT_REVISION_CONFLICT, '事件版本冲突，请刷新后重试')
    }

    await tx
      .update(reliabilityIncidents)
      .set({
        silencedUntil,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(reliabilityIncidents.id, input.incidentId))

    const { incident } = await getIncidentDetail(tx, input.incidentId)
    return incident
  })
}

export async function resolveIncident(
  db: Db,
  input: { incidentId: string; reason: string; expectedRevision?: number; actorId?: string },
): Promise<ReliabilityIncidentDto> {
  return atomic(db, async (tx) => {
    const { reliabilityIncidents } = schemaFor(tx)
    const now = await clockNow(tx)

    const [row] = await tx
      .select()
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.id, input.incidentId))
    if (!row) {
      throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '可靠性事件不存在')
    }
    if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
      throw conflict(RELIABILITY_ERROR_CODES.INCIDENT_REVISION_CONFLICT, '事件版本冲突，请刷新后重试')
    }

    await tx
      .update(reliabilityIncidents)
      .set({
        status: 'RESOLVED',
        dismissedReason: input.reason,
        actionRequiredReason: null,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(reliabilityIncidents.id, input.incidentId))

    const { incident } = await getIncidentDetail(tx, input.incidentId)
    return incident
  })
}

export async function updateIncidentStatus(
  db: Db,
  input: {
    incidentId: string
    status: IncidentStatus
    actionRequiredReason?: string | null
    expectedRevision?: number
    actorId?: string
  },
): Promise<ReliabilityIncidentDto> {
  return atomic(db, async (tx) => {
    const { reliabilityIncidents } = schemaFor(tx)
    const now = await clockNow(tx)

    const [row] = await tx
      .select()
      .from(reliabilityIncidents)
      .where(eq(reliabilityIncidents.id, input.incidentId))
    if (!row) {
      throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '可靠性事件不存在')
    }
    if (input.expectedRevision !== undefined && row.revision !== input.expectedRevision) {
      throw conflict(RELIABILITY_ERROR_CODES.INCIDENT_REVISION_CONFLICT, '事件版本冲突，请刷新后重试')
    }

    await tx
      .update(reliabilityIncidents)
      .set({
        status: input.status,
        actionRequiredReason: input.actionRequiredReason !== undefined ? input.actionRequiredReason : row.actionRequiredReason,
        revision: row.revision + 1,
        updatedAt: now,
      })
      .where(eq(reliabilityIncidents.id, input.incidentId))

    const { incident } = await getIncidentDetail(tx, input.incidentId)
    return incident
  })
}

export async function listIncidentSignals(
  db: Db,
  incidentId: string,
  options?: { cursor?: string; limit?: number },
): Promise<{ items: ReliabilitySignalDto[]; nextCursor: string | null; total: number }> {
  const { reliabilityIncidents, reliabilitySignals } = schemaFor(db)
  const limit = Math.min(options?.limit ?? 50, 100)

  const [incident] = await db
    .select()
    .from(reliabilityIncidents)
    .where(eq(reliabilityIncidents.id, incidentId))
    .limit(1)

  if (!incident) {
    throw notFound(RELIABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, '可靠性事件不存在')
  }

  const conditions = [
    eq(reliabilitySignals.targetId, incident.targetId),
    eq(reliabilitySignals.groupingKey, incident.groupingKey),
  ]

  const rows = await db
    .select()
    .from(reliabilitySignals)
    .where(and(...conditions))
    .orderBy(desc(reliabilitySignals.occurredAt))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  const lastItem = sliced[sliced.length - 1]
  const nextCursor = hasMore && lastItem ? lastItem.id : null

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(reliabilitySignals)
    .where(and(...conditions))

  const items: ReliabilitySignalDto[] = sliced.map((r) => ({
    id: r.id,
    targetId: r.targetId,
    kind: r.kind,
    severity: r.severity as any,
    subjectRef: r.subjectRef as any,
    sourceRef: r.sourceRef as any,
    occurredAt: r.occurredAt.toISOString(),
    commitPosition: r.commitPosition ?? undefined,
    value: r.value ?? undefined,
    unit: r.unit ?? undefined,
    scopeDigest: r.scopeDigest,
    groupingKey: r.groupingKey ?? undefined,
    availability: (r.availability ?? 'available') as any,
    metadata: r.metadata ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }))

  return { items, nextCursor, total: Number(countRow?.count ?? 0) }
}

