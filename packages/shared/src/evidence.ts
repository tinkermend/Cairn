import { z } from 'zod'
import { objectContentTypeSchema, objectKeySchema } from './object-store.js'
import { entityIdSchema, jsonValueSchema, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

/**
 * Evidence 元数据。结构化索引走这条契约；截图 / Trace 只留对象指针。
 *
 * 二进制不进 schema。上传失败必须带 `missingReason`，
 * 不能靠「没有 objectKey」让调用方猜是没采集还是丢了。
 *
 * `status` 是采集状态，与 Run 的执行结论无关（见 `RUN_EVIDENCE_STATUSES`）。
 */

export const EVIDENCE_TYPES = ['input', 'output', 'error', 'screenshot', 'log', 'trace'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES)

export const EVIDENCE_STATUSES = ['pending', 'available', 'missing'] as const
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number]
export const evidenceStatusSchema = z.enum(EVIDENCE_STATUSES)

/** Run 一级证据轴。与 `runs.status` 一样用大写，避免和证据行的小写 status 混读。 */
export const RUN_EVIDENCE_STATUSES = ['PENDING', 'COMPLETE', 'INCOMPLETE'] as const
export type RunEvidenceStatus = (typeof RUN_EVIDENCE_STATUSES)[number]
export const runEvidenceStatusSchema = z.enum(RUN_EVIDENCE_STATUSES)

export const EVIDENCE_INCOMPLETE_CODE = 'EVIDENCE_INCOMPLETE' as const

export const evidenceMetadataSchema = z.strictObject({
  schemaVersion: runtimeSchemaVersionSchema,
  id: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  type: evidenceTypeSchema,
  status: evidenceStatusSchema,
  createdAt: utcInstantSchema,
  objectKey: objectKeySchema.optional(),
  contentType: objectContentTypeSchema.optional(),
  byteSize: z.number().int().nonnegative().optional(),
  digest: z.string().min(1).max(128).optional(),
  missingReason: z.string().min(1).max(512).optional(),
  externalAccess: z.boolean().optional(),
  uploadAttempts: z.number().int().nonnegative().optional(),
  /** 结构化小证据。截图 / Trace 用 objectKey。 */
  payload: jsonValueSchema.optional(),
})
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>
