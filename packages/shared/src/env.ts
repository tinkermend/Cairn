import { z } from 'zod'
import { logLevelSchema } from './logging.js'
import {
  DEFAULT_API_HEARTBEAT_MS,
  DEFAULT_API_LOST_AFTER_SECONDS,
  DEFAULT_MONITOR_DISK_SAMPLE_MS,
  DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS,
  DEFAULT_MONITOR_SAMPLE_INTERVAL_MS,
  DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS,
  DEFAULT_MONITOR_AI_CALL_RETENTION_DAYS,
  MIN_MONITOR_SAMPLE_INTERVAL_MS,
} from './monitoring.js'
import { objectStoreDriverSchema } from './object-store.js'
import {
  DEFAULT_RUN_LEASE_TTL_SECONDS,
  DEFAULT_RUN_MAX_RECOVERIES,
  DEFAULT_WORKER_CAPACITY,
  DEFAULT_WORKER_HEARTBEAT_MS,
  DEFAULT_WORKER_LOST_AFTER_SECONDS,
} from './run-lease.js'
import {
  assertWorkerListenHostAllowed,
  parseWorkerEndpoints,
  resolveWorkerAdvertiseUrl,
} from './worker-registry.js'
import {
  DEFAULT_CREDENTIAL_REMINDER_SCAN_INTERVAL_MS,
  DEFAULT_MONITOR_OVERVIEW_CACHE_MS,
  DEFAULT_MONITOR_PURGE_INTERVAL_MS,
  DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS,
  DEFAULT_PERIODIC_SLOT_LEASE_TTL_MS,
  DEFAULT_REAPER_DRAIN_BUDGET_MS,
} from './periodic-slots.js'
import { DEFAULT_WORKER_ROLES, parseWorkerRoles } from './worker-roles.js'

/**
 * `.env` 里留空的项与未设置等价。
 *
 * dotenv 无法表达「未设置」，占位写法就是 `KEY=`。若不归一，空串会绕过默认值
 * 直接触发校验失败——本地一切正常，只有在漏配时才炸，正好是最难查的形态。
 * `.env.example` 就是照这个约定写的，所以三份 schema 都要过。
 */
function blankAsUnset(source: unknown): unknown {
  if (!source || typeof source !== 'object') return source
  return Object.fromEntries(
    Object.entries(source as Record<string, unknown>).map(([key, value]) => [
      key,
      value === '' ? undefined : value,
    ]),
  )
}

/**
 * 平台自有配置。第三方依赖自带的变量（DATABASE_URL）不在此校验。
 * Midscene 不得回落进程 MIDSCENE_*；在线探针用 CAIRN_S06_*，由适配层读入后
 * 经 modelConfig 显式传入，本期不进 schema。
 */
const serverDbShape = {
  CAIRN_DB_HOST: z.string().min(1),
  CAIRN_DB_NAME: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  CAIRN_DB_USER: z.string().min(1),
  CAIRN_DB_PASSWORD: z.string().min(1),
}
export const dbEnvSchema = z.preprocess(
  (raw) => {
    const source = blankAsUnset(raw)
    return source && typeof source === 'object'
      ? { CAIRN_DB_DRIVER: 'postgres', ...source }
      : source
  },
  z.discriminatedUnion('CAIRN_DB_DRIVER', [
    z.object({
      ...serverDbShape,
      CAIRN_DB_DRIVER: z.literal('postgres').default('postgres'),
      CAIRN_DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
      CAIRN_DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('cairn'),
    }),
    z.object({
      ...serverDbShape,
      CAIRN_DB_DRIVER: z.literal('mysql'),
      CAIRN_DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    }),
    z.object({
      CAIRN_DB_DRIVER: z.literal('sqlite'),
      CAIRN_DB_FILE: z.string().min(1).refine((v) => v !== ':memory:', '须使用本机数据库文件'),
    }),
  ]),
)

export type DbEnv = z.infer<typeof dbEnvSchema>
export type PostgresDbEnv = Extract<DbEnv, { CAIRN_DB_DRIVER: 'postgres' }>

/**
 * 签名密钥、凭据主密钥与内部 HMAC 一律必填、没有默认值。
 *
 * 曾经它们带「开发默认串」，再靠 `CAIRN_ENV !== 'development'` 在生产拒绝。
 * 那条链有个漏点：`CAIRN_ENV` 自己是有默认值的，漏配环境等于三把钥匙一起
 * 退回公开常量，且没有任何告警。现在没有环境档位，规则只剩一条——
 * 每套部署自己生成，漏配就起不来。
 */

/**
 * 测试与本机夹具用的固定密钥。它们**不再是任何 schema 的默认值**——
 * 危险的从来不是「存在一个公开常量」，而是「漏配时进程悄悄用上它」。
 * 生产环境配不出这两个值：必填校验会先拦住空值，填成这里的字面量则是
 * 部署方自己的选择，不是平台替它做的决定。
 */
export const DEV_CREDENTIAL_KEY = 'Y2Fpcm4tZGV2LW9ubHktY3JlZGVudGlhbC1rZXktMDE='
export const DEV_INTERNAL_AUTH_SECRET = 'Y2Fpcm4tZGV2LW9ubHktaW50ZXJuYWwtYXV0aC1rMDE='
export const DEFAULT_WORKER_INTERNAL_HOST = '127.0.0.1'
export const DEFAULT_WORKER_INTERNAL_PORT = 8091
export const DEFAULT_WORKER_ENDPOINTS = 'local-worker=http://127.0.0.1:8091'

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/

/** 解码 `CAIRN_CREDENTIAL_KEY`。不合法或不是 32 字节则返回 undefined。 */
export function decodeCredentialKey(raw: string): Uint8Array | undefined {
  if (!BASE64_PATTERN.test(raw)) return undefined
  try {
    // 契约包同时跑在浏览器与 Node，且不带 DOM lib：用到的全局都显式声明形状，
    // 不为了让 tsc 认识 `atob` 而把整个 DOM lib 拉进来。
    const BufferCtor = (globalThis as { Buffer?: { from(value: string, enc: string): Uint8Array } })
      .Buffer
    const atobFn = (globalThis as { atob?: (data: string) => string }).atob
    const bytes = BufferCtor
      ? Uint8Array.from(BufferCtor.from(raw, 'base64'))
      : atobFn
        ? Uint8Array.from(atobFn(raw), (c: string) => c.charCodeAt(0))
        : undefined
    if (!bytes || bytes.byteLength !== 32) return undefined
    return bytes
  } catch {
    return undefined
  }
}

/**
 * 合法的 CORS origin：`scheme://host[:port]`，或单独的 `*`。
 *
 * 浏览器发出的 Origin 永远带 scheme，写成 `localhost:5173` 的白名单永远匹配不上，
 * 而这种漏写在启动阶段没有任何症状。
 */
const ORIGIN_PATTERN = /^(?:\*|[a-z][a-z0-9+.-]*:\/\/[^\s/]+)$/i

/** api 与 worker 共用：环境语义与日志级别，不各写一份。 */
const runtimeEnvShape = {
  CAIRN_LOG_LEVEL: logLevelSchema.default('info'),
  CAIRN_BUILD_VERSION: z.string().min(1).max(128).optional(),
}

const monitorTelemetryEnvShape = {
  CAIRN_MONITOR_SAMPLE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(MIN_MONITOR_SAMPLE_INTERVAL_MS)
    .default(DEFAULT_MONITOR_SAMPLE_INTERVAL_MS),
  CAIRN_MONITOR_SAMPLE_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(365)
    .default(DEFAULT_MONITOR_SAMPLE_RETENTION_DAYS),
  CAIRN_MONITOR_AI_CALL_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(365)
    .default(DEFAULT_MONITOR_AI_CALL_RETENTION_DAYS),
  CAIRN_MONITOR_DISK_SAMPLE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MONITOR_DISK_SAMPLE_MS),
  CAIRN_MONITOR_OBJECT_STORE_PROBE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MONITOR_OBJECT_STORE_PROBE_MS),
}

export const DEFAULT_OBJECT_STORE_DIR = '.data/object-store'
export const DEFAULT_OBJECT_MAX_BYTES = 33_554_432
export const DEFAULT_OBJECT_RETAIN_DAYS = 30
export const DEFAULT_OBJECT_PENDING_TTL_SECONDS = 3600
export const DEFAULT_OBJECT_CLEANUP_INTERVAL_MS = 60_000
export const DEFAULT_TRACE_MAX_BYTES = 134_217_728
export const DEFAULT_VIDEO_MAX_BYTES = 134_217_728
export const DEFAULT_EVIDENCE_UPLOAD_MAX_ATTEMPTS = 3

export const DEFAULT_BROWSER_PROFILE_DIR = '.data/browser-profiles'
export const DEFAULT_BROWSER_MAX_SESSIONS = 2
export const DEFAULT_BROWSER_HEADLESS = true
export const DEFAULT_SESSION_HEARTBEAT_MS = 5_000
export const DEFAULT_SESSION_REAPER_INTERVAL_MS = 15_000
export {
  DEFAULT_WORKER_CAPACITY,
  DEFAULT_WORKER_HEARTBEAT_MS,
  DEFAULT_RUN_LEASE_TTL_SECONDS,
  DEFAULT_WORKER_LOST_AFTER_SECONDS,
  DEFAULT_RUN_MAX_RECOVERIES,
} from './run-lease.js'

const internalAuthSecretSchema = z
  .string({ error: '必填，无默认值；须为 base64 编码的 32 字节密钥（openssl rand -base64 32）' })
  .superRefine((value, ctx) => {
    if (!decodeCredentialKey(value)) {
      ctx.addIssue({
        code: 'custom',
        message: '须为 base64 编码的 32 字节密钥',
      })
    }
  })

function refineWorkerEndpoints(
  raw: string,
  ctx: z.RefinementCtx,
): void {
  try {
    parseWorkerEndpoints(raw)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      path: ['CAIRN_WORKER_ENDPOINTS'],
      message: error instanceof Error ? error.message : 'Worker 内部地址不合法',
    })
  }
}

const optionalBoolFromEnv = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'))

const boolFromEnv = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true')

const BYTE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 * 1024,
  mb: 1024 * 1024,
  g: 1024 * 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  t: 1024 * 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
}

export function parseBytes(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new Error(`字节大小必须为正整数，收到: ${value}`)
    }
    return value
  }
  if (typeof value !== 'string') {
    throw new Error(`字节大小必须为数字或带单位的字符串，收到: ${typeof value}`)
  }
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('字节大小不能为空')
  }
  if (/^\d+$/.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10)
    if (num <= 0) throw new Error(`字节大小必须为正整数: ${trimmed}`)
    return num
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(trimmed)
  const rawNum = match?.[1]
  const rawUnit = match?.[2]
  if (!match || rawNum === undefined || rawUnit === undefined) {
    throw new Error(`无法解析字节大小格式: "${trimmed}"，支持如 "32MB", "128M", "1GB", "1024"`)
  }
  const num = Number.parseFloat(rawNum)
  const unit = rawUnit.toLowerCase()
  const multiplier = BYTE_UNITS[unit]
  if (!multiplier) {
    throw new Error(`未知字节单位: "${rawUnit}"，支持 B, KB, MB, GB, TB`)
  }
  const result = Math.round(num * multiplier)
  if (result <= 0) {
    throw new Error(`字节大小计算结果必须大于 0: "${trimmed}"`)
  }
  return result
}

const bytesSchema = z
  .union([z.number(), z.string()])
  .transform((val, ctx) => {
    try {
      return parseBytes(val)
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof Error ? err.message : '字节大小格式非法',
      })
      return z.NEVER
    }
  })

/**
 * 对象存储。api 与 worker 共用同一份片段。
 * `CAIRN_S3_FORCE_PATH_STYLE` 未写时：有 endpoint 则 true，否则 false。
 */
const objectStoreEnvShape = {
  CAIRN_OBJECT_STORE: objectStoreDriverSchema.default('local'),
  CAIRN_OBJECT_STORE_DIR: z.string().min(1).default(DEFAULT_OBJECT_STORE_DIR),
  CAIRN_OBJECT_MAX_BYTES: bytesSchema.default(DEFAULT_OBJECT_MAX_BYTES),
  CAIRN_VIDEO_MAX_BYTES: bytesSchema.default(DEFAULT_VIDEO_MAX_BYTES),
  CAIRN_OBJECT_RETAIN_DAYS: z.coerce.number().int().positive().default(DEFAULT_OBJECT_RETAIN_DAYS),
  CAIRN_OBJECT_PENDING_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OBJECT_PENDING_TTL_SECONDS),
  CAIRN_OBJECT_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OBJECT_CLEANUP_INTERVAL_MS),
  CAIRN_S3_ENDPOINT: z.string().min(1).optional(),
  CAIRN_S3_REGION: z.string().min(1).default('us-east-1'),
  CAIRN_S3_BUCKET: z.string().min(1).optional(),
  CAIRN_S3_ACCESS_KEY: z.string().min(1).optional(),
  CAIRN_S3_SECRET_KEY: z.string().min(1).optional(),
  CAIRN_S3_FORCE_PATH_STYLE: optionalBoolFromEnv,
}

function refineObjectStoreEnv(
  env: {
    CAIRN_OBJECT_STORE: 'local' | 's3'
    CAIRN_OBJECT_STORE_DIR: string
    CAIRN_S3_BUCKET?: string
    CAIRN_S3_ACCESS_KEY?: string
    CAIRN_S3_SECRET_KEY?: string
  },
  ctx: z.RefinementCtx,
): void {
  if (env.CAIRN_OBJECT_STORE === 's3') {
    if (!env.CAIRN_S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['CAIRN_S3_BUCKET'],
        message: 's3 驱动必须配置桶名',
      })
    }
    if (!env.CAIRN_S3_ACCESS_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['CAIRN_S3_ACCESS_KEY'],
        message: 's3 驱动必须配置访问密钥',
      })
    }
    if (!env.CAIRN_S3_SECRET_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['CAIRN_S3_SECRET_KEY'],
        message: 's3 驱动必须配置秘密密钥',
      })
    }
  }
  // 相对路径按仓库根解析（resolveLocalObjectStoreDir），绝对路径直用，两种都受支持。
}

/**
 * 浏览器会话与租约。只进 workerEnvSchema。
 * 到期判定一律用库钟；LEASE_TTL ≥ 3 × HEARTBEAT，连续两次丢心跳才判丢租。
 */
const browserSessionEnvShape = {
  CAIRN_BROWSER_HEADLESS: boolFromEnv(DEFAULT_BROWSER_HEADLESS),
  CAIRN_BROWSER_PROFILE_DIR: z.string().min(1).default(DEFAULT_BROWSER_PROFILE_DIR),
  CAIRN_BROWSER_MAX_SESSIONS: z.coerce.number().int().positive().default(DEFAULT_BROWSER_MAX_SESSIONS),
  CAIRN_BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
  // 下列默认必须与 session.ts 的 DEFAULT_SESSION_* 一致（快照平台默认同源）
  CAIRN_SESSION_IDLE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(600),
  CAIRN_SESSION_MAX_LIFETIME_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(14_400),
  CAIRN_SESSION_LEASE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  CAIRN_SESSION_HEARTBEAT_MS: z.coerce.number().int().positive().default(DEFAULT_SESSION_HEARTBEAT_MS),
  CAIRN_SESSION_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_SESSION_REAPER_INTERVAL_MS),
  CAIRN_SESSION_AUTH_WAIT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  CAIRN_SESSION_UNATTENDED_AUTH_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(120),
}

export const DEFAULT_BROWSER_AI_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_BROWSER_AI_HANG_WAIT_MS = 5_000
export const DEFAULT_BROWSER_AI_STEP_MAX_CALLS = 20
export const DEFAULT_BROWSER_AI_MAX_OUTPUT_TOKENS = 2048

export const CHANGE_HINT_DRIVERS = ['auto', 'postgres', 'redis', 'none'] as const
export type ChangeHintDriver = (typeof CHANGE_HINT_DRIVERS)[number]
export type ResolvedChangeHintDriver = 'postgres' | 'redis' | 'none'

export const DEFAULT_RUN_EVENT_RETAIN_DAYS = 7
export const DEFAULT_RUN_EVENT_PAGE_SIZE = 200
export const DEFAULT_SSE_BACKLOG = 256
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000
export const DEFAULT_OBSERVE_RECONCILE_MS = 15_000
export const DEFAULT_SSE_AUTH_REFRESH_MS = 15_000
export const DEFAULT_MONITOR_SSE_INTERVAL_MS = 5_000
export const DEFAULT_MONITOR_SSE_MIN_INTERVAL_MS = 5_000
export const MONITOR_SSE_INTERVAL_MAX_MS = 60_000

export function resolveChangeHintDriver(
  hint: ChangeHintDriver,
  dbDriver: 'postgres' | 'mysql' | 'sqlite',
  hasRedisUrl: boolean,
): ResolvedChangeHintDriver {
  if (hint !== 'auto') return hint
  if (dbDriver === 'postgres') return 'postgres'
  return hasRedisUrl ? 'redis' : 'none'
}

const changeHintEnvShape = {
  CAIRN_CHANGE_HINT: z.enum(CHANGE_HINT_DRIVERS).default('auto'),
  CAIRN_REDIS_URL: z.string().min(1).optional(),
  /**
   * 变更提示总线的频道隔离键。多套识途共用同一个库或同一个 Redis 时，
   * 靠它区分彼此的提示，不串台。曾经缺省借 `CAIRN_ENV` 顶，现在有自己的默认值。
   */
  CAIRN_CHANGE_HINT_NAMESPACE: z.string().min(1).max(64).default('cairn'),
  CAIRN_RUN_EVENT_RETAIN_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(365)
    .default(DEFAULT_RUN_EVENT_RETAIN_DAYS),
  CAIRN_RUN_EVENT_PAGE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1000)
    .default(DEFAULT_RUN_EVENT_PAGE_SIZE),
  CAIRN_SSE_BACKLOG: z.coerce.number().int().positive().max(4096).default(DEFAULT_SSE_BACKLOG),
  CAIRN_SSE_HEARTBEAT_MS: z.coerce.number().int().positive().default(DEFAULT_SSE_HEARTBEAT_MS),
  CAIRN_OBSERVE_RECONCILE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_OBSERVE_RECONCILE_MS),
  CAIRN_SSE_AUTH_REFRESH_MS: z.coerce.number().int().positive().default(DEFAULT_SSE_AUTH_REFRESH_MS),
  CAIRN_MONITOR_SSE_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(MONITOR_SSE_INTERVAL_MAX_MS)
    .default(DEFAULT_MONITOR_SSE_MIN_INTERVAL_MS),
  CAIRN_MONITOR_SSE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(MONITOR_SSE_INTERVAL_MAX_MS)
    .default(DEFAULT_MONITOR_SSE_INTERVAL_MS),
}

function refineChangeHintEnv(
  env: {
    CAIRN_CHANGE_HINT: ChangeHintDriver
    CAIRN_REDIS_URL?: string
    CAIRN_MONITOR_SSE_INTERVAL_MS: number
    CAIRN_MONITOR_SSE_MIN_INTERVAL_MS: number
  },
  ctx: z.RefinementCtx,
): void {
  if (env.CAIRN_CHANGE_HINT === 'redis' && !env.CAIRN_REDIS_URL) {
    ctx.addIssue({
      code: 'custom',
      path: ['CAIRN_REDIS_URL'],
      message: 'CAIRN_CHANGE_HINT=redis 必须配置 CAIRN_REDIS_URL',
    })
  }
  if (env.CAIRN_MONITOR_SSE_INTERVAL_MS < env.CAIRN_MONITOR_SSE_MIN_INTERVAL_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['CAIRN_MONITOR_SSE_INTERVAL_MS'],
      message: '须大于或等于 CAIRN_MONITOR_SSE_MIN_INTERVAL_MS',
    })
  }
}

const browserAiEnvShape = {
  CAIRN_BROWSER_AI_ENABLED: boolFromEnv(false),
  CAIRN_BROWSER_AI_BASE_URL: z.string().url().max(2048).optional(),
  CAIRN_BROWSER_AI_MODEL: z.string().min(1).max(256).optional(),
  CAIRN_BROWSER_AI_MODEL_FAMILY: z.string().min(1).max(64).optional(),
  CAIRN_BROWSER_AI_API_KEY: z.string().min(1).optional(),
  CAIRN_BROWSER_AI_API_KEY_SECRET_ID: z.string().min(1).max(128).optional(),
  CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(300_000)
    .default(DEFAULT_BROWSER_AI_REQUEST_TIMEOUT_MS),
  CAIRN_BROWSER_AI_HANG_WAIT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(DEFAULT_BROWSER_AI_HANG_WAIT_MS),
  CAIRN_BROWSER_AI_STEP_MAX_CALLS: z.coerce
    .number()
    .int()
    .positive()
    .max(200)
    .default(DEFAULT_BROWSER_AI_STEP_MAX_CALLS),
  CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(32_768)
    .default(DEFAULT_BROWSER_AI_MAX_OUTPUT_TOKENS),
}

/**
 * 控制面进程配置。
 *
 * 没有环境档位这个概念：规则对所有部署一视同仁，强度差异一律由显式的功能配置
 * 承担。`NODE_ENV` 留给工具链，不参与平台判断。
 */
export const apiEnvSchema = z.preprocess(
  blankAsUnset,
  z
    .object({
      CAIRN_API_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
      CAIRN_DEMONSTRATION_ENABLED: boolFromEnv(true),
      /**
       * 逗号分隔的 origin 白名单，schema 直接拆成数组交给 enableCors。
       *
       * 拆分不能留在 `main.ts`：那样 schema 只能校验「非空字符串」，`CAIRN_CORS_ORIGINS=,`
       * 这类取值可以通过校验却拆出空白名单——进程正常启动、日志干干净净，而浏览器侧
       * 每一个跨源调用都被拒。校验必须落在真正决定行为的那一步上。
       */
      CAIRN_CORS_ORIGINS: z
        .string()
        .min(1)
        .default('http://localhost:5173')
        .transform((raw) =>
          raw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        )
        .pipe(
          z
            .array(z.string().regex(ORIGIN_PATTERN, 'origin 须形如 https://host[:port]，或单独的 *'))
            .min(1, '至少要配置一个 origin'),
        ),
      CAIRN_JWT_SECRET: z
        .string({ error: '必填，无默认值；至少 16 字符（openssl rand -base64 48）' })
        .min(16, '至少 16 字符'),
      CAIRN_JWT_EXPIRES_IN: z.string().min(1).default('12h'),
      /**
       * 信任的反向代理跳数。0（默认）只用套接字对端地址，忽略
       * X-Forwarded-For。反代后的部署按可信跳数填写。
       */
      CAIRN_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(9).default(0),
      /**
       * 本地 SecretProvider 的 AES-256-GCM 主密钥：base64 编码的恰好 32 字节。
       * 不做 hex 兼容。解码失败或长度不对则进程拒绝启动。
       */
      CAIRN_CREDENTIAL_KEY: z
        .string({ error: '必填，无默认值；须为 base64 编码的 32 字节密钥（openssl rand -base64 32）' })
        .superRefine((value, ctx) => {
          if (!decodeCredentialKey(value)) {
            ctx.addIssue({
              code: 'custom',
              message: '须为 base64 编码的 32 字节密钥',
            })
          }
        }),
      CAIRN_INTERNAL_AUTH_SECRET: internalAuthSecretSchema,
      CAIRN_WORKER_ENDPOINTS: z.string().optional(),
      CAIRN_API_ID: z.string().min(1).max(256).optional(),
      CAIRN_API_HEARTBEAT_MS: z.coerce.number().int().positive().default(DEFAULT_API_HEARTBEAT_MS),
      CAIRN_API_LOST_AFTER_SECONDS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_API_LOST_AFTER_SECONDS),
      CAIRN_MONITOR_OVERVIEW_CACHE_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_MONITOR_OVERVIEW_CACHE_MS),
      ...runtimeEnvShape,
      ...monitorTelemetryEnvShape,
      ...objectStoreEnvShape,
      ...browserAiEnvShape,
      ...changeHintEnvShape,
    })
    .superRefine((env, ctx) => {
      // 「默认值方便本地」与「生产不得裸奔」由同一个 schema 同时成立，
      // 不依赖部署清单上的一行提醒。
      refineWorkerEndpoints(env.CAIRN_WORKER_ENDPOINTS ?? DEFAULT_WORKER_ENDPOINTS, ctx)
      refineObjectStoreEnv(env, ctx)
      refineChangeHintEnv(env, ctx)
      if (env.CAIRN_MONITOR_OVERVIEW_CACHE_MS > env.CAIRN_MONITOR_SSE_MIN_INTERVAL_MS) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_MONITOR_OVERVIEW_CACHE_MS'],
          message: '须小于或等于 CAIRN_MONITOR_SSE_MIN_INTERVAL_MS',
        })
      }
    })
    .transform((env) => ({
      ...env,
      CAIRN_WORKER_ENDPOINTS: env.CAIRN_WORKER_ENDPOINTS ?? DEFAULT_WORKER_ENDPOINTS,
      CAIRN_S3_FORCE_PATH_STYLE: env.CAIRN_S3_FORCE_PATH_STYLE ?? Boolean(env.CAIRN_S3_ENDPOINT),
    })),
)

export type ApiEnv = z.infer<typeof apiEnvSchema>

/**
 * 对象存储配置的独立入口：只解析对象存储自己的变量，不牵连别的必填项。
 *
 * 库迁移这类不启动 API / Worker 的运维工具要访问对象存储校验证据，却用不到 JWT、
 * 凭据主密钥、内部 HMAC。此前它拿整个 apiEnvSchema 去解析，靠那三把钥匙有默认值才能跑；
 * 钥匙改成必填后，灾备 / 搬迁窗口里只带库与存储连接信息就会被无关的必填项挡住。
 * 行为与 api / worker 里的对象存储部分一致（同一片段、同一条校验、同一个 path-style 默认）。
 */
export const objectStoreEnvSchema = z.preprocess(
  blankAsUnset,
  z
    .object(objectStoreEnvShape)
    .superRefine((env, ctx) => refineObjectStoreEnv(env, ctx))
    .transform((env) => ({
      ...env,
      CAIRN_S3_FORCE_PATH_STYLE: env.CAIRN_S3_FORCE_PATH_STYLE ?? Boolean(env.CAIRN_S3_ENDPOINT),
    })),
)
export type ObjectStoreEnv = z.infer<typeof objectStoreEnvSchema>

/**
 * 执行面进程配置。
 *
 * `CAIRN_WORKER_ID` 必须每实例唯一：默认值 `local-worker` 只够单进程，同 ID
 * 第二个实例会在注册时被新鲜心跳挡住、启动失败。唯一性由注册检查卡住，不在这里做——
 * schema 看不见别的进程。
 */
export const workerEnvSchema = z.preprocess(
  blankAsUnset,
  z
    .object({
      CAIRN_WORKER_ID: z.string().min(1).default('local-worker'),
      CAIRN_WORKER_ROLES: z
        .string()
        .default(DEFAULT_WORKER_ROLES)
        .superRefine((value, ctx) => {
          try {
            parseWorkerRoles(value)
          } catch (error) {
            ctx.addIssue({
              code: 'custom',
              message: error instanceof Error ? error.message : 'CAIRN_WORKER_ROLES 不合法',
            })
          }
        }),
      CAIRN_WORKER_CAPACITY: z.coerce.number().int().positive().default(DEFAULT_WORKER_CAPACITY),
      CAIRN_WORKER_HEARTBEAT_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_WORKER_HEARTBEAT_MS),
      CAIRN_RUN_LEASE_TTL_SECONDS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_RUN_LEASE_TTL_SECONDS),
      CAIRN_WORKER_LOST_AFTER_SECONDS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_WORKER_LOST_AFTER_SECONDS),
      CAIRN_RUN_MAX_RECOVERIES: z.coerce.number().int().positive().default(DEFAULT_RUN_MAX_RECOVERIES),
      CAIRN_TRACE_MAX_BYTES: bytesSchema.default(DEFAULT_TRACE_MAX_BYTES),
      CAIRN_EVIDENCE_UPLOAD_MAX_ATTEMPTS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_EVIDENCE_UPLOAD_MAX_ATTEMPTS),
      /**
       * 自动登录解密 TargetAccount 凭据。与 api 同源约定：必填，无默认值，
       * 且两个进程必须配同一把，否则 Worker 解不开控制面写进去的密文。
       */
      CAIRN_CREDENTIAL_KEY: z
        .string({ error: '必填，无默认值；须为 base64 编码的 32 字节密钥（openssl rand -base64 32）' })
        .superRefine((value, ctx) => {
          if (!decodeCredentialKey(value)) {
            ctx.addIssue({
              code: 'custom',
              message: '须为 base64 编码的 32 字节密钥',
            })
          }
        }),
      CAIRN_INTERNAL_AUTH_SECRET: internalAuthSecretSchema,
      CAIRN_WORKER_ADVERTISE_URL: z.string().optional(),
      CAIRN_WORKER_INTERNAL_HOST: z.string().min(1).default(DEFAULT_WORKER_INTERNAL_HOST),
      CAIRN_WORKER_INTERNAL_PORT: z.coerce
        .number()
        .int()
        .min(0)
        .max(65535)
        .default(DEFAULT_WORKER_INTERNAL_PORT),
      CAIRN_DEBUG_HOLD_TIMEOUT_MS: z.coerce.number().int().positive().max(3_600_000).default(900_000),
      CAIRN_PERIODIC_SLOT_LEASE_TTL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_PERIODIC_SLOT_LEASE_TTL_MS),
      CAIRN_PERIODIC_SLOT_FAILURE_RETRY_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS),
      CAIRN_REAPER_DRAIN_BUDGET_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_REAPER_DRAIN_BUDGET_MS),
      CAIRN_MONITOR_PURGE_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_MONITOR_PURGE_INTERVAL_MS),
      CAIRN_CREDENTIAL_REMINDER_SCAN_INTERVAL_MS: z.coerce
        .number()
        .int()
        .positive()
        .default(DEFAULT_CREDENTIAL_REMINDER_SCAN_INTERVAL_MS),
      ...runtimeEnvShape,
      ...monitorTelemetryEnvShape,
      ...objectStoreEnvShape,
      ...browserSessionEnvShape,
      ...browserAiEnvShape,
      ...changeHintEnvShape,
    })
    .superRefine((env, ctx) => {
      if (env.CAIRN_WORKER_INTERNAL_PORT > 0) {
        try {
          assertWorkerListenHostAllowed(env.CAIRN_WORKER_INTERNAL_HOST)
        } catch (error) {
          ctx.addIssue({
            code: 'custom',
            path: ['CAIRN_WORKER_INTERNAL_HOST'],
            message: error instanceof Error ? error.message : '内部监听地址不合法',
          })
        }
      }
      try {
        resolveWorkerAdvertiseUrl({
          advertiseUrl: env.CAIRN_WORKER_ADVERTISE_URL,
          internalPort: env.CAIRN_WORKER_INTERNAL_PORT,
        })
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_WORKER_ADVERTISE_URL'],
          message: error instanceof Error ? error.message : '广告 URL 不合法',
        })
      }
      refineObjectStoreEnv(env, ctx)
      if (env.CAIRN_BROWSER_MAX_SESSIONS < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_BROWSER_MAX_SESSIONS'],
          message: 'CAIRN_BROWSER_MAX_SESSIONS 至少为 1',
        })
      }
      if (env.CAIRN_SESSION_MAX_LIFETIME_SECONDS <= env.CAIRN_SESSION_IDLE_TTL_SECONDS) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_SESSION_MAX_LIFETIME_SECONDS'],
          message: 'CAIRN_SESSION_MAX_LIFETIME_SECONDS 必须大于 CAIRN_SESSION_IDLE_TTL_SECONDS',
        })
      }
      const heartbeatSeconds = env.CAIRN_SESSION_HEARTBEAT_MS / 1000
      if (env.CAIRN_SESSION_LEASE_TTL_SECONDS < 3 * heartbeatSeconds) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_SESSION_LEASE_TTL_SECONDS'],
          message: `CAIRN_SESSION_LEASE_TTL_SECONDS (当前 ${env.CAIRN_SESSION_LEASE_TTL_SECONDS}s) 须 ≥ 3 × 会话心跳 (${3 * heartbeatSeconds}s)`,
        })
      }
      const workerHeartbeatSeconds = env.CAIRN_WORKER_HEARTBEAT_MS / 1000
      if (env.CAIRN_RUN_LEASE_TTL_SECONDS < 3 * workerHeartbeatSeconds) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_RUN_LEASE_TTL_SECONDS'],
          message: `CAIRN_RUN_LEASE_TTL_SECONDS (当前 ${env.CAIRN_RUN_LEASE_TTL_SECONDS}s) 须 ≥ 3 × Worker心跳 (${3 * workerHeartbeatSeconds}s)`,
        })
      }
      if (env.CAIRN_WORKER_LOST_AFTER_SECONDS <= env.CAIRN_RUN_LEASE_TTL_SECONDS) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_WORKER_LOST_AFTER_SECONDS'],
          message: `CAIRN_WORKER_LOST_AFTER_SECONDS (当前 ${env.CAIRN_WORKER_LOST_AFTER_SECONDS}s) 必须严格大于 CAIRN_RUN_LEASE_TTL_SECONDS (${env.CAIRN_RUN_LEASE_TTL_SECONDS}s)`,
        })
      }
      refineChangeHintEnv(env, ctx)
      if (env.CAIRN_REAPER_DRAIN_BUDGET_MS >= env.CAIRN_SESSION_REAPER_INTERVAL_MS) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_REAPER_DRAIN_BUDGET_MS'],
          message: '须小于 CAIRN_SESSION_REAPER_INTERVAL_MS',
        })
      }
    })
    .transform((env) => ({
      ...env,
      CAIRN_S3_FORCE_PATH_STYLE: env.CAIRN_S3_FORCE_PATH_STYLE ?? Boolean(env.CAIRN_S3_ENDPOINT),
    })),
)

export type WorkerEnv = z.infer<typeof workerEnvSchema>

/**
 * 配置校验失败的错误类型。以别名导出，使调用方不必为了标注一个参数
 * 就把 zod 声明成自己的依赖——校验逻辑与 schema 都住在 shared。
 */
export type EnvValidationError = z.ZodError

/**
 * 配置校验失败的逐行说明：只有变量名与规则，不带变量值——
 * 这条路径可能正在打印密钥类配置。
 */
export function formatEnvIssues(error: EnvValidationError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

export function parseDurationSeconds(raw: string): number {
  const match = /^(\d+)([smhd])$/.exec(raw.trim())
  if (!match) return 12 * 3600
  const n = Number(match[1])
  const unit = match[2]
  if (unit === 's') return n
  if (unit === 'm') return n * 60
  if (unit === 'h') return n * 3600
  return n * 86400
}
