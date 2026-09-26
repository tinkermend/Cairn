import { z } from 'zod'
import { entityIdSchema } from './wire.js'

export const outputPolicySchema = z.strictObject({
  autoGenerateReport: z.boolean().default(false),
  reportProfileId: entityIdSchema.nullable().optional(),
  memberReportPolicy: z.enum(['inherit', 'suppress']).default('inherit'),
})
export type OutputPolicy = z.infer<typeof outputPolicySchema>

export const RUN_REPORT_STATUSES = [
  'not_configured',
  'pending',
  'generating',
  'generated',
  'failed',
  'partial_gaps',
] as const
export type RunReportStatus = (typeof RUN_REPORT_STATUSES)[number]
export const runReportStatusSchema = z.enum(RUN_REPORT_STATUSES)
