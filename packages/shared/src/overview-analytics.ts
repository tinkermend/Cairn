import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const overviewTimeRangeSchema = z.enum(['24h', '7d', '30d'])
export type OverviewTimeRange = z.infer<typeof overviewTimeRangeSchema>

export const overviewAnalyticsQuerySchema = z.object({
  range: overviewTimeRangeSchema.default('7d'),
  targetId: entityIdSchema.optional(),
  from: utcInstantSchema.optional(),
  to: utcInstantSchema.optional(),
})
export type OverviewAnalyticsQuery = z.input<typeof overviewAnalyticsQuerySchema>
export type OverviewAnalyticsQueryParsed = z.infer<typeof overviewAnalyticsQuerySchema>

export const overviewTimelinePointSchema = z.object({
  bucketAt: utcInstantSchema,
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  timedOut: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  p95DurationMs: z.number().int().nonnegative().nullable(),
})
export type OverviewTimelinePoint = z.infer<typeof overviewTimelinePointSchema>

export const scenarioRankingItemSchema = z.object({
  scenarioId: entityIdSchema,
  scenarioName: z.string(),
  targetId: entityIdSchema,
  targetName: z.string(),
  runCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
})
export type ScenarioRankingItem = z.infer<typeof scenarioRankingItemSchema>

export const overviewSummarySchema = z.object({
  totalRuns: z.number().int().nonnegative(),
  succeededRuns: z.number().int().nonnegative(),
  failedRuns: z.number().int().nonnegative(),
  timedOutRuns: z.number().int().nonnegative(),
  canceledRuns: z.number().int().nonnegative(),
  runningRuns: z.number().int().nonnegative(),
  pendingRuns: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  avgDurationMs: z.number().int().nonnegative().nullable(),
  p95DurationMs: z.number().int().nonnegative().nullable(),
  runsDeltaPercentage: z.number().nullable(),
  successRateDeltaPercentage: z.number().nullable(),
})
export type OverviewSummary = z.infer<typeof overviewSummarySchema>

export const overviewOutcomesSchema = z.object({
  passed: z.number().int().nonnegative(),
  violation: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  notEvaluated: z.number().int().nonnegative(),
})
export type OverviewOutcomes = z.infer<typeof overviewOutcomesSchema>

export const overviewTriggersSchema = z.object({
  manual: z.number().int().nonnegative(),
  schedule: z.number().int().nonnegative(),
  serviceApi: z.number().int().nonnegative(),
  suiteMember: z.number().int().nonnegative(),
})
export type OverviewTriggers = z.infer<typeof overviewTriggersSchema>

export const overviewAnalyticsResponseSchema = z.object({
  asOf: utcInstantSchema,
  range: overviewTimeRangeSchema,
  summary: overviewSummarySchema,
  timeline: z.array(overviewTimelinePointSchema),
  outcomes: overviewOutcomesSchema,
  triggers: overviewTriggersSchema,
  topScenarios: z.array(scenarioRankingItemSchema).max(10),
  troubledScenarios: z.array(scenarioRankingItemSchema).max(10),
})
export type OverviewAnalyticsResponse = z.infer<typeof overviewAnalyticsResponseSchema>
