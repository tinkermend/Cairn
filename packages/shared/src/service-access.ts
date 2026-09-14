import { z } from 'zod'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'
import { runInputSchema, runStatusSchema } from './run.js'
import { idempotencyKeySchema, stepRunDtoSchema } from './run-api.js'

export const SERVICE_SCOPES = [
  'run:execute',
  'run:read',
  'run:cancel',
  'evidence:read',
  'ai:execute',
] as const
export type ServiceScope = (typeof SERVICE_SCOPES)[number]
export const serviceScopesSchema = z
  .array(z.enum(SERVICE_SCOPES))
  .min(1)
  .max(5)
  .refine((xs) => new Set(xs).size === xs.length, '权限不得重复')
  .refine(
    (xs) => !xs.includes('evidence:read') || xs.includes('run:read'),
    '读取证据需要读取运行权限',
  )

export const serviceCallerBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  owner: z.string().trim().min(1).max(128),
  status: z.enum(['active', 'disabled']).default('active'),
  requestsPerMinute: z.number().int().min(1).max(600).default(60),
  maxOutstandingRuns: z.number().int().min(1).max(20).default(2),
  runTimeoutSeconds: z.number().int().min(1).max(3600).default(600),
})
export type ServiceCallerBody = z.infer<typeof serviceCallerBodySchema>
export const serviceCallerSchema = serviceCallerBodySchema
  .extend({
    id: entityIdSchema,
    createdAt: utcInstantSchema,
    updatedAt: utcInstantSchema,
    outstandingRuns: z.number().int().nonnegative(),
    credentialCount: z.number().int().nonnegative(),
  })
  .strip()
export type ServiceCallerDto = z.infer<typeof serviceCallerSchema>

export const serviceTargetGrantSchema = z
  .strictObject({
    targetId: entityIdSchema,
    allowAnonymous: z.boolean().default(false),
    accountIds: z.array(entityIdSchema).max(100).default([]),
  })
  .refine((x) => new Set(x.accountIds).size === x.accountIds.length, '目标账号不得重复')
export const serviceCredentialPolicySchema = z.strictObject({
  name: z.string().trim().min(1).max(128),
  scopes: serviceScopesSchema,
  grants: z
    .array(serviceTargetGrantSchema)
    .max(100)
    .refine((xs) => new Set(xs.map((x) => x.targetId)).size === xs.length, '目标系统不得重复'),
})
export const issueServiceCredentialSchema = serviceCredentialPolicySchema.extend({
  expiresInDays: z.number().int().min(1).max(365).default(90),
})
export type ServiceCredentialPolicy = z.infer<typeof serviceCredentialPolicySchema>
export type IssueServiceCredential = z.infer<typeof issueServiceCredentialSchema>
export const serviceCredentialSchema = serviceCredentialPolicySchema
  .extend({
    id: entityIdSchema,
    callerId: entityIdSchema,
    revision: z.number().int().positive(),
    status: z.enum(['active', 'expired', 'revoked']),
    expiresAt: utcInstantSchema,
    revokedAt: utcInstantSchema.nullable(),
    lastUsedAt: utcInstantSchema.nullable(),
    createdAt: utcInstantSchema,
  })
  .strip()
export type ServiceCredentialDto = z.infer<typeof serviceCredentialSchema>
export const serviceCallerDetailSchema = z.object({
  caller: serviceCallerSchema,
  credentials: z.array(serviceCredentialSchema),
})
export const serviceCallerListSchema = z.object({
  items: z.array(serviceCallerSchema),
  nextCursor: z.string().optional(),
})
export const issuedServiceCredentialSchema = z.object({
  credential: serviceCredentialSchema,
  token: z.string(),
})

export const servicePrincipalSchema = z.strictObject({
  kind: z.literal('service'),
  requestId: z.string().min(1).max(128).optional(),
  id: entityIdSchema,
  credentialId: entityIdSchema,
  scopes: serviceScopesSchema,
})
export type ServicePrincipal = z.infer<typeof servicePrincipalSchema>
export const executionActorSchema = z.union([
  z.object({ kind: z.literal('console').optional(), id: entityIdSchema }),
  servicePrincipalSchema,
])
export type ExecutionActor = z.infer<typeof executionActorSchema>
export const serviceAdmissionSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.string().min(1).max(128),
  credentialRevision: z.number().int().positive(),
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  scopes: serviceScopesSchema,
  maxOutstandingRuns: z.number().int().positive(),
  runTimeoutSeconds: z.number().int().positive(),
})
export type ServiceAdmission = z.infer<typeof serviceAdmissionSchema>

// Bound depth before the recursive JSON schema is invoked at this trust boundary.
const boundedInputSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    const pending: [unknown, number][] = [[value, 0]]
    while (pending.length) {
      const [item, depth] = pending.pop()!
      if (depth > 8) {
        ctx.addIssue({ code: 'custom', message: '输入嵌套最多 8 层' })
        return
      }
      if (item && typeof item === 'object') {
        for (const child of Object.values(item)) pending.push([child, depth + 1])
      }
    }
  })
  .pipe(runInputSchema)
export const externalRunBodySchema = z.strictObject({
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  targetAccountId: entityIdSchema.optional(),
  input: boundedInputSchema.default({}),
  idempotencyKey: idempotencyKeySchema,
})
export type ExternalRunBody = z.infer<typeof externalRunBodySchema>
export const servicePageQuerySchema = z.strictObject({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ServicePageQuery = z.infer<typeof servicePageQuerySchema>
export const externalRunSchema = z.object({
  id: entityIdSchema,
  status: runStatusSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema.nullable(),
  scenarioId: entityIdSchema,
  scenarioVersionId: entityIdSchema,
  createdAt: utcInstantSchema,
  startedAt: utcInstantSchema.nullable(),
  finishedAt: utcInstantSchema.nullable(),
  cancelRequested: z.boolean(),
  cancelReason: z.string().nullable(),
  evidenceStatus: z.enum(['PENDING', 'COMPLETE', 'INCOMPLETE']),
  stepRuns: z.array(
    stepRunDtoSchema.omit({ attempts: true }).extend({
      attempts: z.array(
        z.object({
          id: entityIdSchema,
          attemptNo: z.number().int(),
          status: z.string(),
          startedAt: utcInstantSchema,
          finishedAt: utcInstantSchema.nullable(),
          errorCode: z.string().nullable(),
          output: jsonValueSchema.nullable(),
        }),
      ),
    }),
  ),
})
export type ExternalRunDto = z.infer<typeof externalRunSchema>
export const evidenceReleaseBodySchema = z.strictObject({ allowed: z.boolean() })
