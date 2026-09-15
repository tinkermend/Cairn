import { z } from 'zod'
import { entityIdSchema } from './wire.js'

/**
 * 对象存储跨进程约定。适配器只认字节；contentType 与生命周期在账本。
 */

export const OBJECT_STORE_DRIVERS = ['local', 's3'] as const
export type ObjectStoreDriver = (typeof OBJECT_STORE_DRIVERS)[number]
export const objectStoreDriverSchema = z.enum(OBJECT_STORE_DRIVERS)

export const STORED_OBJECT_STATUSES = ['pending', 'available', 'purged'] as const
export type StoredObjectStatus = (typeof STORED_OBJECT_STATUSES)[number]
export const storedObjectStatusSchema = z.enum(STORED_OBJECT_STATUSES)

export const PURGE_REASONS = ['expired', 'upload_incomplete', 'run_deleted'] as const
export type PurgeReason = (typeof PURGE_REASONS)[number]
export const purgeReasonSchema = z.enum(PURGE_REASONS)

export const OBJECT_STORE_ERROR_CODES = [
  'OBJECT_NOT_FOUND',
  'OBJECT_KEY_INVALID',
  'OBJECT_KEY_CONFLICT',
  'OBJECT_TOO_LARGE',
  'OBJECT_DIGEST_MISMATCH',
  'OBJECT_NOT_AVAILABLE',
  'OBJECT_STORE_UNAVAILABLE',
] as const
export type ObjectStoreErrorCode = (typeof OBJECT_STORE_ERROR_CODES)[number]
export const objectStoreErrorCodeSchema = z.enum(OBJECT_STORE_ERROR_CODES)

export const OBJECT_MISSING_REASONS = {
  storeUnavailable: 'object_store_unavailable',
  purged: 'object_purged',
  uploadIncomplete: 'upload_incomplete',
  workerLost: 'worker_lost',
  traceTooLarge: 'trace_too_large',
  captureFailed: 'capture_failed',
} as const
export type ObjectMissingReason = (typeof OBJECT_MISSING_REASONS)[keyof typeof OBJECT_MISSING_REASONS]

export const OBJECT_DIGEST_PREFIX = 'sha256:'
export const objectDigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'digest 须为 sha256: + 64 位小写 hex')
export type ObjectDigest = z.infer<typeof objectDigestSchema>

export const objectContentTypeSchema = z.string().min(1).max(128)

/**
 * 对象键。平台分配形如 `v1/runs/{runId}/{objectId}`；
 * 证据字段共用这套字符规则，避免 listRunEvidence 对历史脏键整表 500。
 */
export const objectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((value, ctx) => {
    if (value.startsWith('/')) {
      ctx.addIssue({ code: 'custom', message: '对象键不得以 / 开头' })
      return
    }
    if (value.endsWith('/')) {
      ctx.addIssue({ code: 'custom', message: '对象键不得以 / 结尾' })
      return
    }
    if (value.includes('..')) {
      ctx.addIssue({ code: 'custom', message: '对象键不得包含 ..' })
      return
    }
    if (value.includes('//')) {
      ctx.addIssue({ code: 'custom', message: '对象键不得包含空段' })
      return
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: '对象键只允许字母数字与 /._-' })
    }
  })
export type ObjectKey = z.infer<typeof objectKeySchema>

export function objectKeyFor(runId: string, objectId: string): string {
  const run = entityIdSchema.parse(runId)
  const id = entityIdSchema.parse(objectId)
  return objectKeySchema.parse(`v1/runs/${run}/${id}`)
}

export function isAbsoluteFsPath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

export class ObjectStoreError extends Error {
  readonly code: ObjectStoreErrorCode

  constructor(code: ObjectStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ObjectStoreError'
    this.code = code
  }
}

export function isObjectStoreError(error: unknown): error is ObjectStoreError {
  return error instanceof ObjectStoreError
}
