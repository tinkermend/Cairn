import { z } from 'zod'
import {
  authMethodSchema,
  captchaModeSchema,
  persistedTargetCodeSchema,
  targetAccentKeySchema,
  targetIconKeySchema,
  targetStatusSchema,
} from './target.js'
import { accountSessionStatusSchema } from './session-maintenance.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

/** A complete, consistent result set. The page slices items locally; no dynamic-state cursor is exposed. */
export const targetOverviewQuerySchema = z.object({
  targetId: entityIdSchema.optional(),
  search: z.string().trim().max(128).optional(),
  filter: z.enum(['all', 'ready', 'need_login', 'running']).default('all'),
  sort: z.enum(['created', 'name']).default('created'),
  status: targetStatusSchema.optional(),
  authMethod: authMethodSchema.optional(),
})
export type TargetOverviewQuery = z.input<typeof targetOverviewQuerySchema>
export type TargetOverviewQueryParsed = z.output<typeof targetOverviewQuerySchema>

export const targetOverviewScopedCountSchema = z.strictObject({
  value: z.number().int().nonnegative().nullable(),
  coverage: z.enum(['complete', 'partial', 'forbidden']),
  coveredTargets: z.number().int().nonnegative(),
})
export type TargetOverviewScopedCount = z.infer<typeof targetOverviewScopedCountSchema>

export function targetOverviewVisibleSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('available'), value }),
    z.strictObject({ state: z.literal('forbidden') }),
  ])
}

export const targetOverviewIdentitySchema = z.strictObject({
  id: entityIdSchema,
  code: persistedTargetCodeSchema,
  name: z.string().min(1),
  status: targetStatusSchema,
  entryUrl: z.url(),
  authMethod: authMethodSchema,
  captchaMode: captchaModeSchema,
  iconKey: targetIconKeySchema,
  accentKey: targetAccentKeySchema,
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})

export const targetOverviewReadinessStateSchema = z.enum([
  'disabled',
  'no_business_account',
  'ready',
  'need_login',
  'identity_mismatch',
  'lost',
  'needs_check',
  'busy',
  'unprepared',
  'unknown',
])
export type TargetOverviewReadinessState = z.infer<typeof targetOverviewReadinessStateSchema>

export const targetOverviewActionSchema = z
  .strictObject({
    kind: z.enum([
      'view_conditions',
      'handle_login',
      'view_login',
      'check_login',
      'view_run',
      'manage_sessions',
      'view_sessions',
      'view_target',
    ]),
    targetAccountId: entityIdSchema.optional(),
    runId: entityIdSchema.optional(),
  })
  .superRefine((action, ctx) => {
    if (['handle_login', 'view_login', 'check_login'].includes(action.kind) && !action.targetAccountId) {
      ctx.addIssue({ code: 'custom', path: ['targetAccountId'], message: '此操作需要目标账号' })
    }
    if (action.kind === 'view_run' && !action.runId) {
      ctx.addIssue({ code: 'custom', path: ['runId'], message: '此操作需要运行' })
    }
  })
export type TargetOverviewAction = z.infer<typeof targetOverviewActionSchema>

export const targetOverviewReadinessSchema = z.strictObject({
  state: targetOverviewReadinessStateSchema,
  reason: z.string().min(1).max(300),
  nextAction: targetOverviewActionSchema,
})

export const targetOverviewAccountPreviewSchema = z.strictObject({
  targetAccountId: entityIdSchema,
  displayName: z.string().min(1),
  status: accountSessionStatusSchema,
  loginMode: z.enum(['manual', 'automatic', 'unknown']),
  requiresHumanAuth: z.boolean(),
  reason: z.string().min(1).max(300),
})
export type TargetOverviewAccountPreview = z.infer<typeof targetOverviewAccountPreviewSchema>

export const targetOverviewAccountsSchema = z.strictObject({
  configuredTotal: z.number().int().nonnegative(),
  eligibleBusinessTotal: z.number().int().nonnegative(),
  readyAccounts: z.number().int().nonnegative(),
  needLoginAccounts: z.number().int().nonnegative(),
  attentionAccounts: z.number().int().nonnegative(),
  needsCheckAccounts: z.number().int().nonnegative(),
  identityMismatchAccounts: z.number().int().nonnegative(),
  lostAccounts: z.number().int().nonnegative(),
  unpreparedAccounts: z.number().int().nonnegative(),
  maintenanceAccounts: z.number().int().nonnegative(),
  occupiedAccounts: z.number().int().nonnegative(),
  preview: z.array(targetOverviewAccountPreviewSchema).max(3),
  hiddenAttentionCount: z.number().int().nonnegative(),
})

export const targetOverviewActivitySchema = z.strictObject({
  source: z.enum(['run', 'session']),
  kind: z.enum(['run_queued', 'run_started', 'run_finished', 'auth_wait', 'auth_verified', 'session_lost']),
  occurredAt: utcInstantSchema,
  title: z.string().min(1).max(256),
  runId: entityIdSchema.optional(),
  targetAccountId: entityIdSchema.optional(),
})
export type TargetOverviewActivity = z.infer<typeof targetOverviewActivitySchema>

export const targetOverviewItemSchema = z.strictObject({
  target: targetOverviewIdentitySchema,
  readiness: targetOverviewVisibleSchema(targetOverviewReadinessSchema),
  accounts: targetOverviewVisibleSchema(targetOverviewAccountsSchema),
  scenarios: targetOverviewVisibleSchema(z.strictObject({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
  })),
  knowledge: z.strictObject({ state: z.enum(['available', 'forbidden']) }),
  runs: targetOverviewVisibleSchema(z.strictObject({ running: z.number().int().nonnegative() })),
  activities: targetOverviewVisibleSchema(z.strictObject({
    sources: z.array(z.enum(['run', 'session'])),
    items: z.array(targetOverviewActivitySchema).max(3),
  })),
})
export type TargetOverviewItem = z.infer<typeof targetOverviewItemSchema>

export const targetOverviewResponseSchema = z.strictObject({
  asOf: utcInstantSchema,
  summary: z.strictObject({
    totalTargets: z.number().int().nonnegative(),
    readyTargets: targetOverviewScopedCountSchema,
    needLoginTargets: targetOverviewScopedCountSchema,
    runningTargets: targetOverviewScopedCountSchema,
  }),
  filteredTotal: z.number().int().nonnegative(),
  items: z.array(targetOverviewItemSchema),
  nextCursor: z.null(),
  snapshotToken: z.string().min(1),
})
export type TargetOverviewResponse = z.infer<typeof targetOverviewResponseSchema>
