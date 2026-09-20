import { and, eq } from 'drizzle-orm'
import {
  mergeCaptchaLoginKindParams,
  type CaptchaAttemptOutcome,
  type ChallengeAuditRecord,
  type ChallengeType,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { clockNow, insertRows, schemaFor, updateRows } from '../native.js'
import { getSessionOperation, readSessionScheduling } from './occupancy-read.js'
import { contentDigestFor } from './occupancy-operations.js'
import type { SessionKey } from './sessions.js'
import type { SessionOperationRow } from '../records.js'

export async function recordCaptchaLoginAttempt(
  db: Db,
  input: {
    key: SessionKey
    sessionId?: string
    generation?: number
    runId?: string
    operationId?: string
    attempt: number
    maxAttempts: number
    challengeType: ChallengeType
    outcome: CaptchaAttemptOutcome
    audit: ChallengeAuditRecord
  },
): Promise<SessionOperationRow | null> {
  const kindParams = mergeCaptchaLoginKindParams(undefined, {
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    challengeType: input.challengeType,
    outcome: input.outcome,
    audit: input.audit,
  })

  if (input.operationId) {
    const current = await getSessionOperation(db, input.operationId)
    if (!current) return null
    const merged = mergeCaptchaLoginKindParams(current.kindParams, {
      attempt: input.attempt,
      maxAttempts: input.maxAttempts,
      challengeType: input.challengeType,
      outcome: input.outcome,
      audit: input.audit,
    })
    const { sessionOperations } = schemaFor(db)
    const now = await clockNow(db)
    const [row] = await updateRows(
      db,
      sessionOperations,
      {
        kindParams: merged,
        attemptNo: Math.max(current.attemptNo, input.attempt),
        updatedAt: now,
      },
      and(eq(sessionOperations.id, current.id), eq(sessionOperations.status, current.status)),
    )
    return (row as SessionOperationRow | undefined) ?? current
  }

  const { revision } = await readSessionScheduling(db)
  const { sessionOperations } = schemaFor(db)
  const now = await clockNow(db)
  const success = input.outcome === 'success'
  const [row] = await insertRows(db, sessionOperations, {
    id: newId(),
    targetId: input.key.targetId,
    targetAccountId: input.key.targetAccountId,
    kind: 'LOGIN',
    kindParams,
    origin: 'BACKGROUND',
    status: success ? 'SUCCEEDED' : 'FAILED',
    expectedSessionId: input.sessionId ?? null,
    expectedGeneration: input.generation ?? null,
    idempotencyKey: `captcha:${input.runId ?? input.sessionId ?? input.key.targetAccountId}:${input.audit.challengeId}:${input.attempt}`,
    contentDigest: contentDigestFor(kindParams),
    secretRefs: [],
    platformConfigRevision: revision,
    queueDeadlineAt: now,
    attemptNo: input.attempt,
    errorCode: success ? null : input.outcome === 'ambiguous' ? 'OUTCOME_UNKNOWN' : 'SESSION_AUTH_UNSUPPORTED',
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  })
  return row ?? null
}
