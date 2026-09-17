import { and, eq } from 'drizzle-orm'
import {
  MAP_FACT_BATCH_MAX,
  mapGapObservation,
  mapObservationShell,
  mapRecordingFactKey,
  type MapFactBatchItem,
  type RecordingEvent,
  type RecordingItem,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { appendMapFacts } from '../map/facts.js'
import { schemaFor, updateRows } from '../native.js'
import { DomainError, isUniqueViolation } from '../runs/errors.js'

/** 录制转地图的固定服务主体，禁止冒用 RunGrant。 */
export const RECORDING_MAP_INGEST_SERVICE_ID = '00000000-0000-4000-8000-00000000b019'

export const recordingMapIngestTestHooks = {
  afterBatch: null as null | ((nextIndex: number) => void | Promise<void>),
  beforeAdvanceCursor: null as null | ((expectedNextIndex: number) => void | Promise<void>),
}

export type RecordingMapIngestStatus = 'pending' | 'completed' | 'aborted'

export type ContinueRecordingMapIngestResult = {
  recordingDraftId: string
  nextIndex: number
  status: RecordingMapIngestStatus
  written: number
}

function safeUrlPattern(url: string | undefined): string {
  if (!url || url === 'about:blank') return 'https://unknown.invalid/'
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().slice(0, 512)
  } catch {
    return 'https://unknown.invalid/'
  }
}

function isoTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function framePathOf(item: RecordingItem) {
  return (item.framePath ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((name) => ({ name: name.slice(0, 128) }))
}

export function observationFromRecordingItem(input: {
  targetId: string
  recordingId: string
  sourceVersion: string
  item: RecordingItem
  events: RecordingEvent[]
  observedAt: string
}) {
  const originalEventIndex = Math.min(...input.item.sourceIndexes)
  const event = input.events[originalEventIndex]
  const key = mapRecordingFactKey({
    recordingId: input.recordingId,
    sourceVersion: input.sourceVersion,
    originalEventIndex,
  })
  return mapObservationShell({
    id: newId(),
    targetId: input.targetId,
    sourceType: 'recorder',
    sourceRef: {
      sourceType: 'recorder',
      recordingId: input.recordingId,
      sourceVersion: input.sourceVersion,
      originalEventIndex,
      sourceIndexes: input.item.sourceIndexes,
    },
    phase: 'after_action',
    dedupeKey: key,
    observedAt: input.observedAt,
    captureStatus: 'observed',
    completeness: 'none',
    truncated: true,
    missingReasons: ['NOT_APPLICABLE'],
    topUrlPattern: safeUrlPattern(typeof event?.url === 'string' ? event.url : undefined),
    framePath: framePathOf(input.item),
    actionRef: { actionKind: input.item.sourceAction },
    semanticSummary: {
      predicates: [
        { name: 'recordedAction', value: input.item.sourceAction },
        { name: 'itemStatus', value: input.item.status },
        ...(input.item.pageAlias ? [{ name: 'pageAlias', value: input.item.pageAlias }] : []),
      ],
    },
  })
}

export async function ensureRecordingMapIngestTx(
  tx: Db,
  recordingDraftId: string,
  now = new Date(),
): Promise<void> {
  const { recordingMapIngests } = schemaFor(tx)
  const [existing] = await tx
    .select({ recordingDraftId: recordingMapIngests.recordingDraftId })
    .from(recordingMapIngests)
    .where(eq(recordingMapIngests.recordingDraftId, recordingDraftId))
    .limit(1)
  if (existing) return
  await tx.insert(recordingMapIngests).values({
    recordingDraftId,
    nextIndex: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  })
}

async function commitRecordingMapIngestCursor(
  db: Db,
  input: {
    recordingDraftId: string
    expectedNextIndex: number
    nextIndex: number
    status: RecordingMapIngestStatus
    lastError: string | null
  },
): Promise<boolean> {
  const { recordingMapIngests } = schemaFor(db)
  if (recordingMapIngestTestHooks.beforeAdvanceCursor) {
    await recordingMapIngestTestHooks.beforeAdvanceCursor(input.expectedNextIndex)
  }
  const updated = await updateRows(
    db,
    recordingMapIngests,
    {
      nextIndex: input.nextIndex,
      status: input.status,
      lastError: input.lastError,
      updatedAt: new Date(),
    },
    and(
      eq(recordingMapIngests.recordingDraftId, input.recordingDraftId),
      eq(recordingMapIngests.nextIndex, input.expectedNextIndex),
      eq(recordingMapIngests.status, 'pending'),
    ),
  )
  return updated.length > 0
}

export async function continueRecordingMapIngest(
  db: Db,
  input: { recordingDraftId: string },
): Promise<ContinueRecordingMapIngestResult> {
  const { recordingDrafts, recordingMapIngests } = schemaFor(db)
  const [draft] = await db
    .select()
    .from(recordingDrafts)
    .where(eq(recordingDrafts.id, input.recordingDraftId))
    .limit(1)
  if (!draft) {
    return {
      recordingDraftId: input.recordingDraftId,
      nextIndex: 0,
      status: 'aborted',
      written: 0,
    }
  }
  try {
    await db.transaction(async (tx) => {
      await ensureRecordingMapIngestTx(tx as unknown as Db, input.recordingDraftId)
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  let written = 0
  let conflictAt = -1
  let conflictStreak = 0
  while (true) {
    const [cursor] = await db
      .select()
      .from(recordingMapIngests)
      .where(eq(recordingMapIngests.recordingDraftId, input.recordingDraftId))
      .limit(1)
    if (!cursor || cursor.status !== 'pending') {
      return {
        recordingDraftId: input.recordingDraftId,
        nextIndex: cursor?.nextIndex ?? 0,
        status: cursor?.status ?? 'aborted',
        written,
      }
    }

    const [live] = await db
      .select()
      .from(recordingDrafts)
      .where(eq(recordingDrafts.id, input.recordingDraftId))
      .limit(1)
    if (!live || live.deletedAt) {
      const aborted = await commitRecordingMapIngestCursor(db, {
        recordingDraftId: input.recordingDraftId,
        expectedNextIndex: cursor.nextIndex,
        nextIndex: cursor.nextIndex,
        status: 'aborted',
        lastError: 'draft_deleted',
      })
      if (!aborted) continue
      return {
        recordingDraftId: input.recordingDraftId,
        nextIndex: cursor.nextIndex,
        status: 'aborted',
        written,
      }
    }

    const items = live.items
    if (cursor.nextIndex >= items.length) {
      const completed = await commitRecordingMapIngestCursor(db, {
        recordingDraftId: input.recordingDraftId,
        expectedNextIndex: cursor.nextIndex,
        nextIndex: cursor.nextIndex,
        status: 'completed',
        lastError: null,
      })
      if (!completed) continue
      return {
        recordingDraftId: input.recordingDraftId,
        nextIndex: cursor.nextIndex,
        status: 'completed',
        written,
      }
    }

    const batch = items.slice(cursor.nextIndex, cursor.nextIndex + MAP_FACT_BATCH_MAX)
    const observedAt = isoTimestamp(live.createdAt)
    const facts: MapFactBatchItem[] = batch.map((item) => ({
      type: 'observation',
      observation: observationFromRecordingItem({
        targetId: live.targetId,
        recordingId: live.recordingId,
        sourceVersion: live.sourceVersion,
        item,
        events: live.events,
        observedAt,
      }),
    }))

    try {
      await appendMapFacts(db, {
        caller: { kind: 'service', serviceId: RECORDING_MAP_INGEST_SERVICE_ID },
        facts,
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MAP_FACT_IDEMPOTENCY_CONFLICT') {
        if (conflictAt === cursor.nextIndex) conflictStreak += 1
        else {
          conflictAt = cursor.nextIndex
          conflictStreak = 1
        }
        if (conflictStreak < 8) continue
      }
      if (error instanceof DomainError) {
        const aborted = await commitRecordingMapIngestCursor(db, {
          recordingDraftId: input.recordingDraftId,
          expectedNextIndex: cursor.nextIndex,
          nextIndex: cursor.nextIndex,
          status: 'aborted',
          lastError: error.code.slice(0, 512),
        })
        if (!aborted) continue
        return {
          recordingDraftId: input.recordingDraftId,
          nextIndex: cursor.nextIndex,
          status: 'aborted',
          written,
        }
      }
      throw error
    }

    const nextIndex = cursor.nextIndex + batch.length
    const done = nextIndex >= items.length
    const advanced = await commitRecordingMapIngestCursor(db, {
      recordingDraftId: input.recordingDraftId,
      expectedNextIndex: cursor.nextIndex,
      nextIndex,
      status: done ? 'completed' : 'pending',
      lastError: null,
    })
    if (!advanced) continue
    conflictAt = -1
    conflictStreak = 0
    written += batch.length
    if (recordingMapIngestTestHooks.afterBatch) {
      await recordingMapIngestTestHooks.afterBatch(nextIndex)
    }
    if (done) {
      return {
        recordingDraftId: input.recordingDraftId,
        nextIndex,
        status: 'completed',
        written,
      }
    }
  }
}

export function recordingSourceGapObservation(input: {
  targetId: string
  recordingId: string
  sourceVersion: string
  originalEventIndex: number
  observedAt: string
}) {
  const key = mapRecordingFactKey({
    recordingId: input.recordingId,
    sourceVersion: input.sourceVersion,
    originalEventIndex: input.originalEventIndex,
  })
  return mapGapObservation({
    id: newId(),
    targetId: input.targetId,
    sourceType: 'recorder',
    sourceRef: {
      sourceType: 'recorder',
      recordingId: input.recordingId,
      sourceVersion: input.sourceVersion,
      originalEventIndex: input.originalEventIndex,
    },
    phase: 'after_action',
    dedupeKey: `${key}-gap`.slice(0, 192),
    observedAt: input.observedAt,
    reason: 'NOT_APPLICABLE',
  })
}
