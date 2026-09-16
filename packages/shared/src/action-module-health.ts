import { z } from 'zod'
import { utcInstantSchema } from './wire.js'

export const MODULE_HEALTH_SIGNALS = ['unknown', 'healthy', 'degraded'] as const
export type ModuleHealthSignal = (typeof MODULE_HEALTH_SIGNALS)[number]
export const moduleHealthSignalSchema = z.enum(MODULE_HEALTH_SIGNALS)

export const moduleHealthSummarySchema = z.object({
  signal: moduleHealthSignalSchema,
  sampleCount: z.number().int().nonnegative(),
  verifiedRate: z.number().min(0).max(1).nullable(),
  windowDays: z.number().int().positive(),
  configRevision: z.number().int().positive(),
  asOf: utcInstantSchema,
  verificationInsufficient: z.boolean().default(false),
})
export type ModuleHealthSummary = z.infer<typeof moduleHealthSummarySchema>
