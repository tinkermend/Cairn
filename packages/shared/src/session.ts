import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { utcInstantSchema } from './wire.js'

/**
 * Browser Session / SessionLease 词表与策略。
 *
 * 生命周期、健康、认证三件事分开存（D2）；派生谓词 reusable / claimable / busy
 * 由 Repository 计算，不落库。
 */

export const SESSION_STATUSES = ['CREATING', 'OPEN', 'CLOSING', 'CLOSED', 'LOST'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]
export const sessionStatusSchema = z.enum(SESSION_STATUSES)

export const SESSION_HEALTH = ['UNKNOWN', 'HEALTHY', 'UNHEALTHY'] as const
export type SessionHealth = (typeof SESSION_HEALTH)[number]
export const sessionHealthSchema = z.enum(SESSION_HEALTH)

export const SESSION_AUTH_STATES = ['UNKNOWN', 'AUTHENTICATED', 'EXPIRED'] as const
export type SessionAuthState = (typeof SESSION_AUTH_STATES)[number]
export const sessionAuthStateSchema = z.enum(SESSION_AUTH_STATES)

export const SESSION_LEASE_STATUSES = ['ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED'] as const
export type SessionLeaseStatus = (typeof SESSION_LEASE_STATUSES)[number]
export const sessionLeaseStatusSchema = z.enum(SESSION_LEASE_STATUSES)

export const SESSION_REUSE_POLICIES = ['REUSE_PAGE', 'NEW_PAGE', 'RECREATE_SESSION'] as const
export type SessionReusePolicy = (typeof SESSION_REUSE_POLICIES)[number]
export const sessionReusePolicySchema = z.enum(SESSION_REUSE_POLICIES)

export const SESSION_ERROR_CODES = [
  'SESSION_ACCOUNT_REQUIRED',
  'SESSION_NOT_CLAIMABLE',
  'SESSION_TARGET_MISSING',
  'SESSION_POLICY_INVALID',
  'SESSION_BUSY',
  'SESSION_CAPACITY_EXCEEDED',
  'SESSION_LEASE_LOST',
  'SESSION_LEASE_UNKNOWN',
  'SESSION_AUTH_UNSUPPORTED',
  'SESSION_AUTH_TIMEOUT',
  'BROWSER_UNAVAILABLE',
  'BROWSER_LAUNCH_FAILED',
  'PROFILE_LOCKED',
] as const
export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number]
export const sessionErrorCodeSchema = z.enum(SESSION_ERROR_CODES)

/** 占不到会话：回交，不把 Run 标失败。 */
export const PLACEMENT_YIELD_CODES = [
  'SESSION_BUSY',
  'SESSION_CAPACITY_EXCEEDED',
  'SESSION_NOT_CLAIMABLE',
  'PROFILE_LOCKED',
  'BROWSER_UNAVAILABLE',
  'BROWSER_LAUNCH_FAILED',
] as const
export type PlacementYieldCode = (typeof PLACEMENT_YIELD_CODES)[number]

/** 永久性配置错误：真正失败，不回交。 */
export const SESSION_CONFIG_ERROR_CODES = [
  'SESSION_ACCOUNT_REQUIRED',
  'SESSION_TARGET_MISSING',
  'SESSION_POLICY_INVALID',
] as const
export type SessionConfigErrorCode = (typeof SESSION_CONFIG_ERROR_CODES)[number]

export function isPlacementYieldCode(code: string): code is PlacementYieldCode {
  return (PLACEMENT_YIELD_CODES as readonly string[]).includes(code)
}

export function isSessionConfigErrorCode(code: string): code is SessionConfigErrorCode {
  return (SESSION_CONFIG_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * 平台默认会话策略数值。
 *
 * 必须与 `workerEnvSchema` 中 `CAIRN_SESSION_*` 的 default 逐字对齐：
 * createRun 写快照时 API 读不到 worker 进程 env，只能用这组常量；
 * Worker 运行时续租/等待用 env，默认一致则历史 Run 与本机行为可解释。
 * 改默认值时两处一起改，并由 session.test 卡住。
 */
export const DEFAULT_SESSION_IDLE_TTL_SECONDS = 600
export const DEFAULT_SESSION_MAX_LIFETIME_SECONDS = 14_400
export const DEFAULT_SESSION_LEASE_TTL_SECONDS = 30
export const DEFAULT_SESSION_AUTH_WAIT_SECONDS = 300
export const DEFAULT_SESSION_REUSE_POLICY: SessionReusePolicy = 'NEW_PAGE'

/**
 * 落进快照的会话策略。历史 Run 必须能解释当时怎么执行。
 * 不进 executionPolicySchema：Step 不决定会话所有权。
 * 创建 Run 时 `resolveSessionPolicy` 的 platformDefault 即 `DEFAULT_SESSION_POLICY`。
 */
export const sessionPolicySchema = z
  .strictObject({
    reuse: sessionReusePolicySchema,
    idleTtlSeconds: z.number().int().positive(),
    maxLifetimeSeconds: z.number().int().positive(),
    leaseTtlSeconds: z.number().int().positive(),
    authWaitSeconds: z.number().int().positive(),
  })
  .superRefine((policy, ctx) => {
    if (policy.maxLifetimeSeconds <= policy.idleTtlSeconds) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxLifetimeSeconds'],
        message: 'maxLifetimeSeconds 必须大于 idleTtlSeconds',
      })
    }
  })
export type SessionPolicy = z.infer<typeof sessionPolicySchema>

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  reuse: DEFAULT_SESSION_REUSE_POLICY,
  idleTtlSeconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
  maxLifetimeSeconds: DEFAULT_SESSION_MAX_LIFETIME_SECONDS,
  leaseTtlSeconds: DEFAULT_SESSION_LEASE_TTL_SECONDS,
  authWaitSeconds: DEFAULT_SESSION_AUTH_WAIT_SECONDS,
}

/** POST /runs 可只覆盖部分字段；解析后写完整值进快照。 */
export const sessionPolicyOverrideSchema = z.strictObject({
  reuse: sessionReusePolicySchema.optional(),
  idleTtlSeconds: z.number().int().positive().optional(),
  maxLifetimeSeconds: z.number().int().positive().optional(),
  leaseTtlSeconds: z.number().int().positive().optional(),
  authWaitSeconds: z.number().int().positive().optional(),
})
export type SessionPolicyOverride = z.infer<typeof sessionPolicyOverrideSchema>

export function resolveSessionPolicy(
  override?: SessionPolicyOverride | null,
  platformDefault: SessionPolicy = DEFAULT_SESSION_POLICY,
): SessionPolicy {
  return sessionPolicySchema.parse({
    ...platformDefault,
    ...stripUndefined(override ?? undefined),
  })
}

function stripUndefined<T extends Record<string, unknown>>(
  value: T | undefined,
): Partial<T> {
  if (!value) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>
}

/**
 * 进程内命令面 guard 的租约副本。四元组 + 到期时间任一不符即拒绝命令。
 * 事实源仍是库；guard 是本进程有效副本，续租失败即撤销。
 */
export const sessionGrantSchema = z.strictObject({
  sessionId: z.uuid(),
  leaseId: z.uuid(),
  generation: z.number().int().positive(),
  sessionFencingToken: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
})
export type SessionGrant = z.infer<typeof sessionGrantSchema>

/**
 * 控制面会话视图。只给元数据：没有 Cookie、没有 profile 绝对路径，
 * 也没有任何可用于驱动浏览器的句柄（宪法「执行分层」：API 不持有正式 Browser Session）。
 */
export const sessionDtoSchema = z.object({
  id: z.uuid(),
  targetId: z.uuid(),
  targetAccountId: z.uuid(),
  status: sessionStatusSchema,
  health: sessionHealthSchema,
  authState: sessionAuthStateSchema,
  ownerWorkerId: z.string().min(1),
  ownerWorkerInstanceId: z.uuid().nullable(),
  generation: z.number().int().positive(),
  reusePolicy: sessionReusePolicySchema,
  profileKey: z.string().min(1),
  idleTtlSeconds: z.number().int().positive(),
  /** 空闲回收的判定基准。 */
  lastUsedAt: utcInstantSchema,
  /** 最大生命周期的到期时刻（快照策略的值）。 */
  expiresAt: utcInstantSchema,
    authHold: z
    .object({
      workerId: z.string().min(1),
      expiresAt: utcInstantSchema,
      runId: z.uuid().nullable(),
      bound: z.boolean(),
    })
    .nullable(),
  authControl: z
    .object({
      epoch: z.number().int().nonnegative(),
      actorId: z.uuid().nullable(),
      expiresAt: utcInstantSchema.nullable(),
    })
    .nullable(),
  closeReason: z.string().min(1).nullable(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  /** 当前 `ACTIVE` 租约；没有则为 null。 */
  activeLease: z
    .object({
      id: z.uuid(),
      runId: z.uuid(),
      holderWorkerId: z.string().min(1),
      acquiredAt: utcInstantSchema,
      expiresAt: utcInstantSchema,
    })
    .nullable(),
  /** 是否能被人工处置：`OPEN` 是活会话，必须由 owner 自己回收。 */
  disposable: z.boolean(),
})
export type SessionDto = z.infer<typeof sessionDtoSchema>

export const sessionListResponseSchema = z.object({
  items: z.array(sessionDtoSchema),
  nextCursor: nextCursorSchema,
})
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>

export const disposeSessionBodySchema = z.strictObject({
  /** 操作者确认「旧浏览器已停止或已隔离」的说明，进审计。 */
  note: z.string().trim().min(1).max(512).optional(),
})
export type DisposeSessionBody = z.infer<typeof disposeSessionBodySchema>

