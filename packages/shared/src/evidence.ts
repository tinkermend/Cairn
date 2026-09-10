import { z } from 'zod'
import { entityIdSchema, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

/**
 * Evidence 元数据。结构化索引走这条契约；截图 / Trace 只留对象指针。
 *
 * 二进制不进 schema。上传失败必须带 `missingReason`，
 * 不能靠「没有 objectKey」让调用方猜是没采集还是丢了。
 */

export const EVIDENCE_TYPES = ['input', 'output', 'error', 'screenshot', 'log', 'trace'] as const
export type EvidenceType = (typeof EVIDENCE_TYPES)[number]
export const evidenceTypeSchema = z.enum(EVIDENCE_TYPES)

export const evidenceMetadataSchema = z.strictObject({
  schemaVersion: runtimeSchemaVersionSchema,
  id: entityIdSchema,
  runId: entityIdSchema,
  stepRunId: entityIdSchema.optional(),
  attemptId: entityIdSchema.optional(),
  type: evidenceTypeSchema,
  createdAt: utcInstantSchema,
  objectKey: z.string().min(1).max(512).optional(),
  contentType: z.string().min(1).max(128).optional(),
  byteSize: z.number().int().nonnegative().optional(),
  digest: z.string().min(1).max(128).optional(),
  missingReason: z.string().min(1).max(512).optional(),
})
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>
