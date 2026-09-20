import { and, eq } from 'drizzle-orm'
import {
  AI_CALL_KIND,
  RUNTIME_SCHEMA_VERSION,
  SCENARIO_AI_LEDGER_PURPOSE,
  aiCallEvidenceSchema,
  isAiCallEvidence,
  type AiCallEvidence,
  type JsonValue,
  type RunGrant,
  type SessionGrant,
} from '@cairn/shared'
import { atomic, insertIgnoreRows, schemaFor } from '../native.js'
import { lockRunRow, verifyRunLeaseForWrite } from '../leases/leases.js'
import { verifySessionLeaseForCommit } from '../sessions/sessions.js'
import type { Db } from '../client.js'
import { newId } from '../id.js'

export type ReserveAiModelCallInput = {
  runId: string
  stepRunId: string
  attemptId?: string
  maxCalls: number
  grant: RunGrant
  sessionLease?: SessionGrant & { holderWorkerId: string }
  model?: string
}

export type ReserveAiModelCallResult =
  | { ok: true; n: number; evidenceId: string }
  | { ok: false; code: 'AI_BUDGET_EXCEEDED' | 'RUN_NOT_WRITABLE' }

export async function reserveAiModelCall(
  db: Db,
  input: ReserveAiModelCallInput,
): Promise<ReserveAiModelCallResult> {
  return atomic(db, async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run || run.status !== 'RUNNING') return { ok: false as const, code: 'RUN_NOT_WRITABLE' as const }
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) {
      return { ok: false as const, code: 'RUN_NOT_WRITABLE' as const }
    }
    if (input.sessionLease) {
      const held = await verifySessionLeaseForCommit(tx, input.sessionLease)
      if (!held) return { ok: false as const, code: 'RUN_NOT_WRITABLE' as const }
    }
    const { evidences: table } = schemaFor(tx as unknown as Db)
    const rows = await tx
      .select()
      .from(table)
      .where(and(eq(table.stepRunId, input.stepRunId), eq(table.type, 'log')))
    const used = rows.filter((row) => isAiCallEvidence(row.payload)).length
    if (used >= input.maxCalls) return { ok: false as const, code: 'AI_BUDGET_EXCEEDED' as const }
    const n = used + 1
    const evidenceId = newId()
    const payload: AiCallEvidence = aiCallEvidenceSchema.parse({
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      kind: AI_CALL_KIND,
      n,
      phase: 'reserved',
      model: input.model,
      startedAt: new Date().toISOString(),
      attemptId: input.attemptId,
    })
    await tx.insert(table).values({
      id: evidenceId,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      type: 'log',
      status: 'available',
      schemaVersion: 1,
      payload: payload as JsonValue,
      createdAt: new Date(),
    })
    return { ok: true as const, n, evidenceId }
  })
}

export async function completeAiModelCall(
  db: Db,
  input: {
    evidenceId: string
    phase: 'completed' | 'failed'
    model?: string
    durationMs?: number
    inputTokens?: number | null
    outputTokens?: number | null
    cost?: number | null
    errorCode?: string
    summary?: string
  },
): Promise<void> {
  const { evidences: table } = schemaFor(db)
  const [row] = await db.select().from(table).where(eq(table.id, input.evidenceId)).limit(1)
  if (!row || !isAiCallEvidence(row.payload)) return
  const endedAt = new Date().toISOString()
  const payload = aiCallEvidenceSchema.parse({
    ...row.payload,
    phase: input.phase,
    model: input.model ?? row.payload.model,
    endedAt,
    durationMs: input.durationMs,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    cost: input.cost ?? null,
    errorCode: input.errorCode,
    summary: input.summary,
  })
  await atomic(db, async (tx) => {
    await tx
      .update(table)
      .set({ payload: payload as JsonValue })
      .where(eq(table.id, input.evidenceId))
  })
  try {
    const { scenarioAiCalls } = schemaFor(db)
    await insertIgnoreRows(db, scenarioAiCalls, {
      id: newId(),
      evidenceId: input.evidenceId,
      runId: row.runId,
      stepRunId: row.stepRunId ?? row.runId,
      attemptId: row.attemptId,
      purpose: SCENARIO_AI_LEDGER_PURPOSE,
      model: payload.model ?? null,
      phase: input.phase,
      durationMs: input.durationMs ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cost: null,
      errorCode: input.errorCode ?? null,
    })
  } catch (error) {
    console.error('[db] scenario_ai_calls 写入失败，不影响 evidence', error instanceof Error ? error.message : error)
  }
}
