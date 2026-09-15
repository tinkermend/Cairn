import type { EvidenceRow } from '../records.js'
import { atomic, schemaFor } from '../native.js'
import { updateRows } from '../native.js'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import {
  EVIDENCE_INCOMPLETE_CODE,
  FINISHED_RUN_STATUSES,
  RUNTIME_SCHEMA_VERSION,
  stepUsesBrowser,
  isFinishedRunStatus,
  resolveEvidencePolicy,
  shouldCaptureEvidence,
  type EvidenceMetadata,
  type EvidenceType,
  type JsonValue,
  type RunEvidenceStatus,
  type RunSnapshot,
  type Step,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { attempts, evidences, runs, stepRuns } from '../schema/execution.js'
import { storedObjects } from '../schema/objects.js'
import { toEvidenceMetadata } from './evidence-map.js'
import { lockRunRow } from '../leases/leases.js'
import { appendRunEvents } from '../observe/events.js'
import { commitObjectEvidence, markEvidenceMissing } from './objects.js'

export type PendingEvidenceRow = EvidenceMetadata & {
  objectId: string | null
  objectCreatedAt: Date | null
  objectStatus: string | null
  objectContentType: string | null
  objectByteSize: number | null
  objectDigest: string | null
}

export async function getEvidenceForRun(
  db: Db,
  input: { runId: string; evidenceId: string },
): Promise<EvidenceRow | null> {
  const { evidences, runs } = schemaFor(db)
  const [row] = await db
    .select({ evidence: evidences })
    .from(evidences)
    .innerJoin(runs, eq(runs.id, evidences.runId))
    .where(
      and(
        eq(evidences.id, input.evidenceId),
        eq(evidences.runId, input.runId),
        isNull(runs.deletedAt),
      ),
    )
    .limit(1)
  return row?.evidence ?? null
}

export async function listPendingEvidence(
  db: Db,
  input: { limit?: number } = {},
): Promise<PendingEvidenceRow[]> {
  const { evidences, storedObjects } = schemaFor(db)
  const rows = await db
    .select({
      evidence: evidences,
      objectCreatedAt: storedObjects.createdAt,
      objectStatus: storedObjects.status,
      objectContentType: storedObjects.contentType,
      objectByteSize: storedObjects.byteSize,
      objectDigest: storedObjects.digest,
    })
    .from(evidences)
    .leftJoin(storedObjects, eq(storedObjects.id, evidences.objectId))
    .where(eq(evidences.status, 'pending'))
    .orderBy(asc(evidences.createdAt), asc(evidences.id))
    .limit(input.limit ?? 200)
  return rows.map((row) => ({
    ...toEvidenceMetadata(row.evidence),
    objectId: row.evidence.objectId,
    objectCreatedAt: row.objectCreatedAt,
    objectStatus: row.objectStatus,
    objectContentType: row.objectContentType,
    objectByteSize: row.objectByteSize,
    objectDigest: row.objectDigest,
  }))
}

export type SettleEvidenceOptions = {
  now?: Date
  pendingTtlSeconds: number
  maxUploadAttempts: number
}

export async function settleExpiredPendingEvidence(
  db: Db,
  options: SettleEvidenceOptions,
): Promise<{ marked: number; committed: number; runs: string[] }> {
  const { runs } = schemaFor(db)
  const now = options.now ?? new Date()
  const pendingBefore = new Date(now.getTime() - options.pendingTtlSeconds * 1000)
  const pending = await listPendingEvidence(db, { limit: 500 })
  const runIds = new Set<string>()
  let committed = 0
  const leftover: PendingEvidenceRow[] = []

  for (const row of pending) {
    if (
      row.objectStatus === 'available' &&
      row.objectContentType &&
      row.objectByteSize != null &&
      row.objectDigest
    ) {
      const done = await commitObjectEvidence(db, {
        id: row.id,
        contentType: row.objectContentType,
        byteSize: row.objectByteSize,
        digest: row.objectDigest,
      })
      if (done) {
        committed += 1
        runIds.add(row.runId)
      }
      continue
    }
    leftover.push(row)
  }

  const expired = leftover.filter((row) => {
    if ((row.uploadAttempts ?? 0) >= options.maxUploadAttempts) return true
    if (
      row.objectStatus === 'pending' &&
      row.objectCreatedAt &&
      row.objectCreatedAt < pendingBefore
    ) {
      return true
    }
    if (!row.objectId && new Date(row.createdAt) < pendingBefore) return true
    return false
  })
  let marked = 0
  for (const row of expired) {
    const updated = await markEvidenceMissing(db, { id: row.id, reason: 'worker_lost' })
    if (updated) {
      marked += 1
      runIds.add(row.runId)
    }
  }
  for (const runId of runIds) {
    await settleRunEvidence(db, runId, options)
  }
  return { marked, committed, runs: [...runIds] }
}

/**
 * 已终态、轴仍 PENDING 的 Run。覆盖 finally 收尾失败、核查后未收、以及没有任何 pending 证据行可被 TTL 扫到的成功 Run。
 */
export async function settleFinishedPendingRuns(
  db: Db,
  options: SettleEvidenceOptions,
): Promise<{ settled: number }> {
  const { runs } = schemaFor(db)
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(inArray(runs.status, [...FINISHED_RUN_STATUSES]), eq(runs.evidenceStatus, 'PENDING')),
    )
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .limit(200)
  let settled = 0
  for (const row of rows) {
    const result = await settleRunEvidence(db, row.id, options)
    if (result.updated) settled += 1
  }
  return { settled }
}

export async function settleRunEvidence(
  db: Db,
  runId: string,
  options: SettleEvidenceOptions,
): Promise<{ evidenceStatus: RunEvidenceStatus; updated: boolean }> {
  const { attempts, evidences, runs, stepRuns } = schemaFor(db)
  const now = options.now ?? new Date()
  return atomic(db, async (tx) => {
    await lockRunRow(tx, runId)
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run) return { evidenceStatus: 'PENDING' as const, updated: false }

    const snapshot = run.snapshot as RunSnapshot
    const policy = resolveEvidencePolicy(snapshot.evidencePolicy)
    const stepRows = await tx.select().from(stepRuns).where(eq(stepRuns.runId, runId))
    const attemptRows =
      stepRows.length === 0
        ? []
        : await tx
            .select()
            .from(attempts)
            .where(
              inArray(
                attempts.stepRunId,
                stepRows.map((s) => s.id),
              ),
            )
    const evidenceRows = await tx.select().from(evidences).where(eq(evidences.runId, runId))
    const stepsById = new Map((snapshot.steps ?? []).map((step) => [step.id, step]))

    const required = collectRequiredEvidence(stepRows, attemptRows, evidenceRows, stepsById, policy)
    const next = decideEvidenceStatus({
      runStatus: run.status,
      required,
      evidenceRows,
    })

    if (!isFinishedRunStatus(run.status) || next === 'PENDING') {
      return { evidenceStatus: run.evidenceStatus, updated: false }
    }

    const [updated] = await updateRows(
      tx,
      runs,
      { evidenceStatus: next },
      and(eq(runs.id, runId), eq(runs.evidenceStatus, 'PENDING')),
      { evidenceStatus: runs.evidenceStatus },
    )

    if (next === 'INCOMPLETE') {
      await insertIncompleteEvidence(tx, runId, required, evidenceRows, now)
    }

    if (updated) {
      await appendRunEvents(tx, runId, [
        { type: 'run.status_changed', payload: { evidenceStatus: next } },
      ])
    }

    return {
      evidenceStatus: updated?.evidenceStatus ?? run.evidenceStatus,
      updated: Boolean(updated),
    }
  })
}

type RequiredSlot = {
  attemptId: string
  type: EvidenceType
  missingReason?: string
}

function collectRequiredEvidence(
  stepRows: { id: string; stepId: string }[],
  attemptRows: { id: string; stepRunId: string; status: string }[],
  evidenceRows: EvidenceRow[],
  stepsById: Map<string, Step>,
  policy: ReturnType<typeof resolveEvidencePolicy>,
): RequiredSlot[] {
  const required: RequiredSlot[] = []
  const byAttempt = new Map<string, EvidenceRow[]>()
  for (const row of evidenceRows) {
    if (!row.attemptId) continue
    const list = byAttempt.get(row.attemptId) ?? []
    list.push(row)
    byAttempt.set(row.attemptId, list)
  }

  for (const attempt of attemptRows) {
    if (attempt.status === 'RUNNING') continue
    const stepRow = stepRows.find((row) => row.id === attempt.stepRunId)
    const step = stepRow ? stepsById.get(stepRow.stepId) : undefined
    const rows = byAttempt.get(attempt.id) ?? []
    const failed = attempt.status === 'FAILED' || attempt.status === 'CANCELLED'

    for (const type of policy.required) {
      required.push({ attemptId: attempt.id, type, missingReason: reasonFor(rows, type) })
    }

    const hasOutcome = rows.some(
      (row) => (row.type === 'output' || row.type === 'error') && row.status !== 'missing',
    )
    if (!hasOutcome) {
      required.push({
        attemptId: attempt.id,
        type: 'error',
        missingReason: reasonFor(rows, 'error') ?? 'missing_outcome',
      })
    }

    if (step && stepUsesBrowser(step.type)) {
      if (shouldCaptureEvidence(policy.screenshot, failed)) {
        required.push({
          attemptId: attempt.id,
          type: 'screenshot',
          missingReason: reasonFor(rows, 'screenshot'),
        })
      }
      if (shouldCaptureEvidence(policy.trace, failed)) {
        required.push({
          attemptId: attempt.id,
          type: 'trace',
          missingReason: reasonFor(rows, 'trace'),
        })
      }
    }
  }
  return required
}

function reasonFor(rows: EvidenceRow[], type: EvidenceType): string | undefined {
  const row = rows.find((item) => item.type === type)
  if (!row) return 'missing'
  if (row.status === 'missing') return row.missingReason ?? 'missing'
  return undefined
}

function decideEvidenceStatus(input: {
  runStatus: string
  required: RequiredSlot[]
  evidenceRows: EvidenceRow[]
}): RunEvidenceStatus {
  if (!isFinishedRunStatus(input.runStatus as never)) return 'PENDING'
  const byAttemptType = new Map(
    input.evidenceRows
      .filter((row) => row.attemptId)
      .map((row) => [`${row.attemptId}:${row.type}`, row]),
  )
  let pending = false
  let missing = false
  for (const slot of input.required) {
    if (slot.type === 'error' && slot.missingReason === 'missing_outcome') {
      const rows = input.evidenceRows.filter((row) => row.attemptId === slot.attemptId)
      const outcome = rows.find((row) => row.type === 'output' || row.type === 'error')
      if (!outcome) missing = true
      else if (outcome.status === 'pending') pending = true
      else if (outcome.status === 'missing') missing = true
      continue
    }
    const row = byAttemptType.get(`${slot.attemptId}:${slot.type}`)
    if (!row) {
      missing = true
      continue
    }
    if (row.status === 'pending') pending = true
    if (row.status === 'missing') missing = true
  }
  if (pending) return 'PENDING'
  if (missing) return 'INCOMPLETE'
  return 'COMPLETE'
}

async function insertIncompleteEvidence(
  db: Db,
  runId: string,
  required: RequiredSlot[],
  evidenceRows: EvidenceRow[],
  now: Date,
): Promise<void> {
  const { evidences } = schemaFor(db)
  const exists = evidenceRows.some(
    (row) =>
      row.type === 'error' &&
      row.payload &&
      typeof row.payload === 'object' &&
      !Array.isArray(row.payload) &&
      row.payload.code === EVIDENCE_INCOMPLETE_CODE,
  )
  if (exists) return

  const missing = required
    .filter((slot): slot is RequiredSlot & { missingReason: string } => Boolean(slot.missingReason))
    .map((slot) => ({
      attemptId: slot.attemptId,
      type: slot.type,
      reason: slot.missingReason,
    }))

  try {
    await db.insert(evidences).values({
      id: newId(),
      runId,
      type: 'error',
      status: 'available',
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      payload: {
        code: EVIDENCE_INCOMPLETE_CODE,
        category: 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '必要证据缺失，业务结论未改写',
        missing,
      },
      createdAt: now,
    })
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (code !== '23505') throw error
  }
}

export async function recordInlineLogEvidence(
  db: Db,
  input: {
    runId: string
    stepRunId?: string
    attemptId?: string
    payload: JsonValue
  },
): Promise<void> {
  const { evidences } = schemaFor(db)
  await db.insert(evidences).values({
    id: newId(),
    runId: input.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
    type: 'log',
    status: 'available',
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    payload: input.payload,
    createdAt: new Date(),
  })
}
