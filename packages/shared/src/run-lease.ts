import { z } from 'zod'
import { entityIdSchema, leaseExpiresAtSchema } from './wire.js'

export const WORKER_STATUSES = ['READY', 'DRAINING', 'STOPPED', 'LOST'] as const
export type WorkerStatus = (typeof WORKER_STATUSES)[number]
export const workerStatusSchema = z.enum(WORKER_STATUSES)

export const RUN_LEASE_STATUSES = ['ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'] as const
export type RunLeaseStatus = (typeof RUN_LEASE_STATUSES)[number]
export const runLeaseStatusSchema = z.enum(RUN_LEASE_STATUSES)

/**
 * 只列平台真会发出的码。
 *
 * 之前还有 `RUN_LEASE_LOST` / `RUN_LEASE_UNKNOWN`：丢租与"这租约不是我的"都只表现为
 * 写入 0 行、在途执行停手，没有任何地方把它们落库或返回给调用方。没有产生者的枚举成员
 * 会让人以为存在一条不存在的错误通道，和被删掉的 `WORKER_CAPACITY_EXCEEDED` 同类。
 * 将来真有产生者时再加回来。
 */
export const RUN_LEASE_ERROR_CODES = ['WORKER_ID_CONFLICT', 'RUN_RECOVERY_EXHAUSTED'] as const
export type RunLeaseErrorCode = (typeof RUN_LEASE_ERROR_CODES)[number]
export const runLeaseErrorCodeSchema = z.enum(RUN_LEASE_ERROR_CODES)

export const DEFAULT_WORKER_CAPACITY = 1
export const DEFAULT_WORKER_HEARTBEAT_MS = 5_000
export const DEFAULT_RUN_LEASE_TTL_SECONDS = 30
export const DEFAULT_WORKER_LOST_AFTER_SECONDS = 45
export const DEFAULT_RUN_MAX_RECOVERIES = 3

export const runGrantSchema = z.strictObject({
  runId: entityIdSchema,
  leaseId: entityIdSchema,
  fencingToken: z.number().int().min(1),
  holderWorkerId: z.string().min(1).max(128),
  expiresAt: leaseExpiresAtSchema,
})
export type RunGrant = z.infer<typeof runGrantSchema>

export const reviewRunBodySchema = z.strictObject({
  conclusion: z.enum(['fail', 'cancel']),
  note: z.string().trim().max(512).optional(),
})
export type ReviewRunBody = z.infer<typeof reviewRunBodySchema>

export const resumeAuthBodySchema = z.strictObject({
  note: z.string().trim().max(512).optional(),
  token: z.string().min(16).max(128).optional(),
})
export type ResumeAuthBody = z.infer<typeof resumeAuthBodySchema>
