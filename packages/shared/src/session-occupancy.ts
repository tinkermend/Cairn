import { z } from 'zod'
import type { FrozenTargetAuth } from './platform-config.js'
import type { AuthObservation, FrozenAuthVerification } from './session-auth.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'
import { sessionGrantSchema, type SessionGrant } from './session.js'

/** Worker 进入 READY 必须声明；新旧二进制不得混跑。 */
export const SESSION_OCCUPANCY_PROTOCOL = 'session-occupancy@2' as const

export const SESSION_LEASE_PURPOSES = ['EXECUTION', 'MAINTENANCE', 'AUTH_WAIT'] as const
export type SessionLeasePurpose = (typeof SESSION_LEASE_PURPOSES)[number]
export const sessionLeasePurposeSchema = z.enum(SESSION_LEASE_PURPOSES)

export const SESSION_LEASE_OWNER_KINDS = ['RUN', 'SESSION_OPERATION'] as const
export type SessionLeaseOwnerKind = (typeof SESSION_LEASE_OWNER_KINDS)[number]
export const sessionLeaseOwnerKindSchema = z.enum(SESSION_LEASE_OWNER_KINDS)

export const sessionLeaseOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('RUN'), runId: entityIdSchema }),
  z.strictObject({ kind: z.literal('SESSION_OPERATION'), operationId: entityIdSchema }),
])
export type SessionLeaseOwner = z.infer<typeof sessionLeaseOwnerSchema>

export const DEFAULT_PROFILE_AFFINITY_WAIT_SECONDS = 120
export const DEFAULT_OPERATION_QUEUE_TIMEOUT_SECONDS = 300

export const platformSessionSchedulingSchema = z.strictObject({
  profileAffinityWaitSeconds: z.number().int().min(1).max(3_600),
  operationQueueTimeoutSeconds: z.number().int().min(30).max(3_600),
})
export type PlatformSessionScheduling = z.infer<typeof platformSessionSchedulingSchema>

export const FACTORY_SESSION_SCHEDULING: PlatformSessionScheduling = {
  profileAffinityWaitSeconds: DEFAULT_PROFILE_AFFINITY_WAIT_SECONDS,
  operationQueueTimeoutSeconds: DEFAULT_OPERATION_QUEUE_TIMEOUT_SECONDS,
}

export const RUN_WAIT_REASONS = [
  'SESSION_IN_USE_BY_RUN',
  'SESSION_IN_MAINTENANCE',
  'SESSION_WAITING_FOR_AUTH',
  'SESSION_LOST',
  'WORKER_SESSION_CAPACITY',
  'PROFILE_AFFINITY_WAIT',
  'NO_ELIGIBLE_WORKER',
] as const
export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number]
export const runWaitReasonSchema = z.enum(RUN_WAIT_REASONS)

export const SESSION_OPERATION_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_AUTH',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type SessionOperationStatus = (typeof SESSION_OPERATION_STATUSES)[number]
export const sessionOperationStatusSchema = z.enum(SESSION_OPERATION_STATUSES)

export const SESSION_MAINTENANCE_KINDS = [
  'PREPARE',
  'VERIFY_AUTH',
  'LOGIN',
  'RENEW_AUTH',
  'REFRESH_LOGIN_PAGE',
  'CLOSE',
  'RESTART',
  'RESET_PROFILE',
] as const
export const SESSION_OPERATION_KINDS = ['VALIDATE_AUTH_PROFILE', ...SESSION_MAINTENANCE_KINDS] as const
export type SessionOperationKind = (typeof SESSION_OPERATION_KINDS)[number]
export const sessionOperationKindSchema = z.enum(SESSION_OPERATION_KINDS)

export const SESSION_OPERATION_ORIGINS = ['USER', 'BACKGROUND'] as const
export type SessionOperationOrigin = (typeof SESSION_OPERATION_ORIGINS)[number]
export const sessionOperationOriginSchema = z.enum(SESSION_OPERATION_ORIGINS)

export const SESSION_PROFILE_STATES = ['ABSENT', 'PRESENT'] as const
export type SessionProfileState = (typeof SESSION_PROFILE_STATES)[number]
export const sessionProfileStateSchema = z.enum(SESSION_PROFILE_STATES)

export const sessionProfileCleanupSchema = z.strictObject({
  workerId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
})
export type SessionProfileCleanup = z.infer<typeof sessionProfileCleanupSchema>

export const sessionAcquireReasons = ['reused', 'created'] as const
export type SessionAcquireReason = (typeof sessionAcquireReasons)[number]

export const sessionGrantOccupancySchema = sessionGrantSchema.extend({
  purpose: sessionLeasePurposeSchema.default('EXECUTION'),
  ownerKind: sessionLeaseOwnerKindSchema.default('RUN'),
  runId: entityIdSchema.nullable().optional(),
  operationId: entityIdSchema.nullable().optional(),
})
export type SessionGrantOccupancy = z.infer<typeof sessionGrantOccupancySchema>

export function isExecutorGrant(grant: { purpose?: SessionLeasePurpose }): boolean {
  return (grant.purpose ?? 'EXECUTION') === 'EXECUTION'
}

export function isMaintenanceGrant(grant: { purpose?: SessionLeasePurpose }): boolean {
  return grant.purpose === 'MAINTENANCE'
}

export type { AuthObservation }

export type LoginOutcome =
  | { ok: true; authState: 'AUTHENTICATED' }
  | { ok: false; reason: 'manual' | 'failed' | 'unsupported' | 'paused' | 'mismatch'; message: string }

export type SessionAuthPort = {
  verify(
    grant: SessionGrant,
    frozenAuth: FrozenTargetAuth,
    verification?: FrozenAuthVerification,
  ): Promise<AuthObservation>
  login(
    grant: SessionGrant,
    frozenAuth: FrozenTargetAuth,
    verification?: FrozenAuthVerification,
  ): Promise<LoginOutcome>
}

export const sessionOperationDtoSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  kind: sessionOperationKindSchema,
  origin: sessionOperationOriginSchema,
  status: sessionOperationStatusSchema,
  expectedSessionId: entityIdSchema.nullable(),
  expectedGeneration: z.number().int().positive().nullable(),
  ownerWorkerId: z.string().min(1).max(128).nullable(),
  attemptNo: z.number().int().nonnegative(),
  queueDeadlineAt: utcInstantSchema,
  errorCode: z.string().min(1).max(64).nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  finishedAt: utcInstantSchema.nullable(),
})
export type SessionOperationDto = z.infer<typeof sessionOperationDtoSchema>
