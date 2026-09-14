import { and, desc, eq, gte, lt, or, type SQL } from 'drizzle-orm'
import {
  auditListResponseSchema,
  loginAuditListResponseSchema,
  normalizeLoginIdentifier,
  type AuditClientKind,
  type AuditListResponse,
  type LoginAuditListResponse,
  type LoginAuditQuery,
  type OperationAuditQuery,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { decodeAuditCursor, encodeAuditCursor } from './cursor.js'

function iso(value: Date): string {
  return value.toISOString()
}

function rangeAndCursor(
  createdAt: ReturnType<typeof schemaFor>['consoleAuditEvents']['createdAt'],
  id: ReturnType<typeof schemaFor>['consoleAuditEvents']['id'],
  query: { cursor?: string; from?: Date; to?: Date },
): SQL | undefined {
  const parts: SQL[] = []
  if (query.from) parts.push(gte(createdAt, query.from))
  if (query.to) parts.push(lt(createdAt, query.to))
  if (query.cursor) {
    const cursor = decodeAuditCursor(query.cursor)
    parts.push(
      or(lt(createdAt, cursor.createdAt), and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)))!,
    )
  }
  return parts.length ? and(...parts) : undefined
}

function actorDto(row: {
  actorId: string | null
  actorName: string | null
  actorEmail: string | null
}) {
  return row.actorId
    ? { id: row.actorId, displayName: row.actorName ?? '已删除账号', email: row.actorEmail }
    : null
}

export async function listOperationAuditEvents(
  db: Db,
  query: OperationAuditQuery,
): Promise<AuditListResponse> {
  const { consoleAccounts, consoleAuditEvents, serviceCallers } = schemaFor(db)
  const filters = [
    eq(consoleAuditEvents.category, 'operation'),
    query.action ? eq(consoleAuditEvents.action, query.action) : undefined,
    query.actorId ? or(eq(consoleAuditEvents.actorConsoleAccountId, query.actorId), eq(consoleAuditEvents.actorServiceCallerId, query.actorId)) : undefined,
    rangeAndCursor(consoleAuditEvents.createdAt, consoleAuditEvents.id, query),
  ].filter((value): value is SQL => value !== undefined)

  const rows = await db
    .select({
      id: consoleAuditEvents.id,
      requestId: consoleAuditEvents.requestId,
      action: consoleAuditEvents.action,
      resource: consoleAuditEvents.resource,
      resourceId: consoleAuditEvents.resourceId,
      summary: consoleAuditEvents.summary,
      clientIp: consoleAuditEvents.clientIp,
      userAgent: consoleAuditEvents.userAgent,
      clientKind: consoleAuditEvents.clientKind,
      createdAt: consoleAuditEvents.createdAt,
      serviceId: serviceCallers.id,
      serviceName: serviceCallers.name,
      credentialId: consoleAuditEvents.actorServiceCredentialId,
      actorId: consoleAccounts.id,
      actorName: consoleAccounts.displayName,
      actorEmail: consoleAccounts.email,
    })
    .from(consoleAuditEvents)
    .leftJoin(consoleAccounts, eq(consoleAccounts.id, consoleAuditEvents.actorConsoleAccountId))
    .leftJoin(serviceCallers, eq(serviceCallers.id, consoleAuditEvents.actorServiceCallerId))
    .where(and(...filters))
    .orderBy(desc(consoleAuditEvents.createdAt), desc(consoleAuditEvents.id))
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return auditListResponseSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      requestId: row.requestId,
      action: row.action,
      resource: row.resource,
      resourceId: row.resourceId,
      summary: row.summary,
      clientIp: row.clientIp,
      userAgent: row.userAgent,
      clientKind: (row.clientKind as AuditClientKind | null) ?? null,
      createdAt: iso(row.createdAt),
      actor: row.serviceId ? { id: row.serviceId, displayName: row.serviceName, email: null, kind: 'service', credentialId: row.credentialId } : actorDto(row),
    })),
    nextCursor: rows.length > query.limit && last ? encodeAuditCursor(last.createdAt, last.id) : undefined,
  })
}

export async function listLoginAuditEvents(
  db: Db,
  query: LoginAuditQuery,
): Promise<LoginAuditListResponse> {
  const { consoleAccounts, consoleAuditEvents } = schemaFor(db)
  const identifier = query.identifier ? normalizeLoginIdentifier(query.identifier) : undefined
  const filters = [
    eq(consoleAuditEvents.category, 'login'),
    query.outcome ? eq(consoleAuditEvents.outcome, query.outcome) : undefined,
    query.actorId ? eq(consoleAuditEvents.actorConsoleAccountId, query.actorId) : undefined,
    identifier ? eq(consoleAuditEvents.loginIdentifier, identifier) : undefined,
    query.clientKind ? eq(consoleAuditEvents.clientKind, query.clientKind) : undefined,
    rangeAndCursor(consoleAuditEvents.createdAt, consoleAuditEvents.id, query),
  ].filter((value): value is SQL => value !== undefined)

  const rows = await db
    .select({
      id: consoleAuditEvents.id,
      loginIdentifier: consoleAuditEvents.loginIdentifier,
      outcome: consoleAuditEvents.outcome,
      failureReason: consoleAuditEvents.failureReason,
      clientIp: consoleAuditEvents.clientIp,
      userAgent: consoleAuditEvents.userAgent,
      clientKind: consoleAuditEvents.clientKind,
      createdAt: consoleAuditEvents.createdAt,
      actorId: consoleAccounts.id,
      actorName: consoleAccounts.displayName,
      actorEmail: consoleAccounts.email,
    })
    .from(consoleAuditEvents)
    .leftJoin(consoleAccounts, eq(consoleAccounts.id, consoleAuditEvents.actorConsoleAccountId))
    .where(and(...filters))
    .orderBy(desc(consoleAuditEvents.createdAt), desc(consoleAuditEvents.id))
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return loginAuditListResponseSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      loginIdentifier: row.loginIdentifier ?? '',
      outcome: row.outcome === 'success' ? 'success' : 'failure',
      failureReason: row.failureReason,
      clientIp: row.clientIp,
      userAgent: row.userAgent,
      clientKind: row.clientKind === 'extension' ? 'extension' : 'web',
      createdAt: iso(row.createdAt),
      actor: actorDto(row),
    })),
    nextCursor: rows.length > query.limit && last ? encodeAuditCursor(last.createdAt, last.id) : undefined,
  })
}
