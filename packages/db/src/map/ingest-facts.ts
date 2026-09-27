import { and, desc, eq } from 'drizzle-orm'
import {
  canonicalJson,
  mapConditionSnapshot,
  mapIngestCursorSchema,
  mapIngestPageSnapshotSchema,
  mapObservationShell,
  syncSha256,
  type MapIngestCursor,
  type MapIngestPageSnapshot,
  type MapIngestSummary,
  type RunGrant,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { verifyRunLeaseForWrite } from '../leases/leases.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { appendMapFactsTx } from './facts.js'
import { mapNotFound, mapStaleOwner } from './errors.js'
import { diffMapIngestPages } from './ingest-changes.js'

export async function commitMapIngestProgress(
  db: Db,
  input: {
    grant: RunGrant
    jobId: string
    runId: string
    stepRunId: string
    attemptId: string
    cursor: MapIngestCursor
    page?: MapIngestPageSnapshot
  },
): Promise<void> {
  const cursor = mapIngestCursorSchema.parse(input.cursor)
  const page = input.page ? mapIngestPageSnapshotSchema.parse(input.page) : undefined
  await atomic(db, async tx => {
    const { mapJobs, mapJobSlices, mapIngestPages } = schemaFor(tx)
    const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, input.jobId)))
    if (!job || job.jobStatus === 'cancelled' || job.jobStatus === 'failed' || job.jobStatus === 'completed')
      mapNotFound('采集作业已结束')
    const [slice] = await tx.select().from(mapJobSlices)
      .where(and(eq(mapJobSlices.jobId, input.jobId), eq(mapJobSlices.runId, input.runId))).limit(1)
    if (!slice || input.grant.runId !== input.runId || !(await verifyRunLeaseForWrite(tx, input.grant)))
      mapStaleOwner()
    if (page && (page.jobId !== job.id || page.targetId !== job.targetId || page.targetAccountId !== job.targetAccountId))
      mapStaleOwner()
    const previous = job.ingestCursor
    if (previous && (cursor.processedNodes < previous.processedNodes || cursor.entryIndex < previous.entryIndex))
      return
    if (page) {
      const [existing] = await tx.select({ id: mapIngestPages.id }).from(mapIngestPages)
        .where(and(eq(mapIngestPages.jobId, job.id), eq(mapIngestPages.viewStateKey, page.viewStateKey))).limit(1)
      if (!existing) {
        const digest = syncSha256(page.viewStateKey)
        const chunks = Array.from({ length: Math.max(1, Math.ceil(page.elements.length / 80)) }, (_, index) => page.elements.slice(index * 80, index * 80 + 80))
        const observations = chunks.map((elements, index) => mapObservationShell({
          id: newId(), targetId: job.targetId, sourceType: 'map_ingest',
          sourceRef: { sourceType: 'map_ingest', runId: input.runId, stepRunId: input.stepRunId, attemptId: input.attemptId },
          phase: 'after_action', dedupeKey: 'map-ingest:' + job.id + ':' + digest + ':' + index,
          sourceEventKey: 'map-ingest:' + digest + ':' + index, collectorVersion: 'map-ingest@1',
          observedAt: page.observedAt, captureStatus: 'observed',
          completeness: page.completeness, truncated: false,
          missingReasons: [], topUrlPattern: page.urlPattern,
          conditionSnapshot: mapConditionSnapshot({ targetId: job.targetId, targetAccountId: job.targetAccountId }),
          regionRefs: [{ key: 'main', kind: 'region' }],
          nodeSetKind: 'region',
          semanticSummary: { predicates: [
            { name: 'title', value: page.title },
            { name: 'menuPath', value: page.menuPath.join(' > ') },
          ] },
          stateSummary: { regions: { page: { pageKey: page.pageKey,
            viewStateKey: page.viewStateKey, presentationStateKey: page.presentationStateKey,
            arrivalMethod: page.arrivalMethod } } },
          structuralSummary: {
            nodeCount: elements.length, truncated: false,
            features: {
              kind: 'surface-inventory', title: page.title, heading: page.title, landmarks: [],
              named: elements.map(element => ({
                role: element.role, name: element.name, category: element.category,
                fingerprint: element.fingerprint, ...(element.locator ? { locator: element.locator } : {}),
              })),
            },
          },
        }))
        await appendMapFactsTx(tx, { caller: { kind: 'run', grant: input.grant },
          facts: observations.map(observation => ({ type: 'observation' as const, observation })) })
        await insertRows(tx, mapIngestPages, {
          id: newId(), jobId: job.id, entryId: page.entryId, targetId: job.targetId,
          targetAccountId: job.targetAccountId, pageKey: page.pageKey, viewStateKey: page.viewStateKey,
          presentationStateKey: page.presentationStateKey, arrivalMethod: page.arrivalMethod,
          menuPathJson: page.menuPath, title: page.title, urlPattern: page.urlPattern,
          elementsJson: page.elements, completeness: page.completeness,
          reasonsJson: page.reasons, observedAt: new Date(page.observedAt),
        })
      }
    }
    const now = await clockNow(tx)
    await tx.update(mapJobs).set({
      ingestCursor: cursor, jobStatus: 'running', revision: job.revision + 1, updatedAt: now,
    }).where(eq(mapJobs.id, job.id))
  })
}

export async function recordMapIngestSliceResult(
  db: Db,
  input: {
    grant: RunGrant
    jobId: string
    runId: string
    cursor: MapIngestCursor
    nodes: Array<{ label: string; code: string; pageKey?: string }>
    blockedPostPaths: Array<{ path: string; count: number }>
    inferredReadPostPaths?: Array<{ path: string; count: number }>
    inferredReadPostCount?: number
    blockedImpactCounts?: NonNullable<MapIngestSummary['blockedImpactCounts']>
    dialogs: number
    detectedMenus: MapIngestSummary['detectedMenus']
  },
): Promise<void> {
  await atomic(db, async tx => {
    const { mapJobs, mapJobSlices, mapIngestPages } = schemaFor(tx)
    const [job] = await locked(tx, tx.select().from(mapJobs).where(eq(mapJobs.id, input.jobId)))
    if (!job || job.jobStatus === 'cancelled') return
    const [slice] = await tx.select().from(mapJobSlices)
      .where(and(eq(mapJobSlices.jobId, input.jobId), eq(mapJobSlices.runId, input.runId))).limit(1)
    if (!slice || input.grant.runId !== input.runId || !(await verifyRunLeaseForWrite(tx, input.grant)))
      mapStaleOwner()
    if ((job.ingestSummary?.slices ?? 0) >= slice.sliceOrdinal + 1) return
    const pages = await tx.select().from(mapIngestPages).where(eq(mapIngestPages.jobId, job.id))
    const counts = { ...(job.ingestSummary?.resultCounts ?? {}) }
    for (const node of input.nodes) counts[node.code] = (counts[node.code] ?? 0) + 1
    const post = new Map((job.ingestSummary?.blockedPostPaths ?? []).map(item => [item.path, item.count]))
    for (const item of input.blockedPostPaths) post.set(item.path, (post.get(item.path) ?? 0) + item.count)
    const inferred = new Map((job.ingestSummary?.inferredReadPostPaths ?? []).map(item => [item.path, item.count]))
    for (const item of input.inferredReadPostPaths ?? []) inferred.set(item.path, (inferred.get(item.path) ?? 0) + item.count)
    const previousImpact = job.ingestSummary?.blockedImpactCounts
    const impact = input.blockedImpactCounts
      ? {
        unclassified: (previousImpact?.unclassified ?? 0) + input.blockedImpactCounts.unclassified,
        unreadable_ping: (previousImpact?.unreadable_ping ?? 0) + input.blockedImpactCounts.unreadable_ping,
        verified_non_content_rule: (previousImpact?.verified_non_content_rule ?? 0)
          + input.blockedImpactCounts.verified_non_content_rule,
      }
      : previousImpact
    const partialPages = pages.filter(page => page.completeness === 'partial').length
    const finished = input.cursor.entryIndex >= job.frozenEntriesJson.length && input.cursor.queue.length === 0
    const complete = finished
      && partialPages === 0 && Object.keys(counts).every(code => code === 'collected')
    let changeSet = { changes: job.ingestSummary?.changes ?? [], truncated: job.ingestSummary?.changesTruncated ?? false }
    if (finished && job.scope !== 'detect_top_menus') {
      const candidates = await tx.select().from(mapJobs)
        .where(and(eq(mapJobs.targetId, job.targetId), eq(mapJobs.jobKind, 'map_ingest'),
          eq(mapJobs.targetAccountId, job.targetAccountId), eq(mapJobs.scope, job.scope),
          eq(mapJobs.jobStatus, 'completed')))
        .orderBy(desc(mapJobs.createdAt)).limit(100)
      const entryIds = canonicalJson(job.frozenEntriesJson.map(entry => entry.entryId).sort())
      const previous = candidates.find(candidate => candidate.id !== job.id
        && candidate.createdAt < job.createdAt
        && canonicalJson(candidate.frozenEntriesJson.map(entry => entry.entryId).sort()) === entryIds)
      if (previous) {
        const before = await tx.select().from(mapIngestPages).where(eq(mapIngestPages.jobId, previous.id))
        changeSet = diffMapIngestPages(before.map(page => ({
          pageKey: page.pageKey, viewStateKey: page.viewStateKey, elements: page.elementsJson,
        })), pages.map(page => ({
          pageKey: page.pageKey, viewStateKey: page.viewStateKey, elements: page.elementsJson,
        })), complete && previous.ingestSummary?.outcome === 'complete' && job.scope === 'full')
      }
    }
    const summary: MapIngestSummary = {
      outcome: complete ? 'complete' : 'partial',
      entries: job.frozenEntriesJson.length, pages: new Set(pages.map(page => page.pageKey)).size,
      elements: pages.reduce((total, page) => total + page.elementsJson.length, 0),
      partialPages, resultCounts: counts,
      blockedPostPaths: [...post].sort((left, right) => right[1] - left[1]).slice(0, 20)
        .map(([path, count]) => ({ path, count })),
      ...(input.inferredReadPostCount || job.ingestSummary?.inferredReadPostCount ? {
        inferredReadPostCount: (job.ingestSummary?.inferredReadPostCount ?? 0) + (input.inferredReadPostCount ?? 0),
        inferredReadPostPaths: [...inferred].sort((left, right) => right[1] - left[1]).slice(0, 20)
          .map(([path, count]) => ({ path, count })),
      } : {}),
      ...(impact ? { blockedImpactCounts: impact } : {}),
      changes: changeSet.changes, changesTruncated: changeSet.truncated,
      durationSeconds: input.cursor.elapsedSeconds, slices: slice.sliceOrdinal + 1,
      ...(input.detectedMenus?.length ? { detectedMenus: input.detectedMenus } : {}),
    }
    const now = await clockNow(tx)
    await tx.update(mapJobs).set({ ingestCursor: input.cursor, ingestSummary: summary, updatedAt: now })
      .where(eq(mapJobs.id, job.id))
  })
}
