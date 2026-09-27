import { and, eq, gt } from 'drizzle-orm'
import { registrationRequiresOccupancy, SESSION_OCCUPANCY_PROTOCOL } from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, schemaFor } from '../native.js'

export interface PlatformWorkerHealthSummary {
  asOf: Date
  healthyNodes: number
  expiredInServiceNodes: number
  affectedActiveRuns: number
  affectedActiveSessions: number
  earliestWorkerValidUntil: Date | null
}

export async function readPlatformWorkerHealthSummary(
  db: Db,
  asOf?: Date,
): Promise<PlatformWorkerHealthSummary> {
  const resolved = asOf ?? (await clockNow(db))
  const { workers, runLeases, sessionLeases } = schemaFor(db)

  const allWorkers = await db.select().from(workers)
  const healthyWorkerIds = new Set<string>()
  const validUntilList: number[] = []
  let expiredInServiceNodes = 0

  for (const w of allWorkers) {
    const isExecutor =
      registrationRequiresOccupancy(w.protocolCapabilities) ||
      Boolean(w.protocolCapabilities?.includes(SESSION_OCCUPANCY_PROTOCOL))

    if (!isExecutor) continue

    const isHeartbeatFresh = Boolean(
      w.heartbeatExpiresAt && w.heartbeatExpiresAt.getTime() > resolved.getTime(),
    )
    const isReady = w.status === 'READY'

    if (isReady && isHeartbeatFresh) {
      healthyWorkerIds.add(w.id)
      if (w.heartbeatExpiresAt) {
        validUntilList.push(w.heartbeatExpiresAt.getTime())
      }
    } else if ((w.status === 'READY' || w.status === 'DRAINING') && !isHeartbeatFresh) {
      expiredInServiceNodes += 1
    }
  }

  // 查询活跃的运行租约 (status = 'ACTIVE' 且 expiresAt > resolved)
  const activeRunLeases = await db
    .select({
      runId: runLeases.runId,
      holderWorkerId: runLeases.holderWorkerId,
    })
    .from(runLeases)
    .where(and(eq(runLeases.status, 'ACTIVE'), gt(runLeases.expiresAt, resolved)))

  const affectedRunIds = new Set<string>()
  for (const lease of activeRunLeases) {
    if (!healthyWorkerIds.has(lease.holderWorkerId)) {
      affectedRunIds.add(lease.runId)
    }
  }

  // 查询活跃的会话租约 (status = 'ACTIVE' 且 expiresAt > resolved)
  const activeSessionLeases = await db
    .select({
      sessionId: sessionLeases.sessionId,
      holderWorkerId: sessionLeases.holderWorkerId,
    })
    .from(sessionLeases)
    .where(and(eq(sessionLeases.status, 'ACTIVE'), gt(sessionLeases.expiresAt, resolved)))

  const affectedSessionIds = new Set<string>()
  for (const lease of activeSessionLeases) {
    if (!healthyWorkerIds.has(lease.holderWorkerId)) {
      affectedSessionIds.add(lease.sessionId)
    }
  }

  const earliestWorkerValidUntil =
    validUntilList.length > 0 ? new Date(Math.min(...validUntilList)) : null

  return {
    asOf: resolved,
    healthyNodes: healthyWorkerIds.size,
    expiredInServiceNodes,
    affectedActiveRuns: affectedRunIds.size,
    affectedActiveSessions: affectedSessionIds.size,
    earliestWorkerValidUntil,
  }
}
