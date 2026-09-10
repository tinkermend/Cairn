import { z } from 'zod'
import { logLevelSchema } from './logging.js'

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
 * 平台自有配置。第三方依赖自带的变量（MIDSCENE_*、DATABASE_URL）
 * 不在此校验——它们由外部库直接读取。
 */
export const dbEnvSchema = z.preprocess(
  blankAsUnset,
  z.object({
    CAIRN_DB_HOST: z.string().min(1),
    CAIRN_DB_PORT: z.coerce.number().int().positive().default(5432),
    CAIRN_DB_NAME: z.string().min(1),
    CAIRN_DB_USER: z.string().min(1),
    CAIRN_DB_PASSWORD: z.string().min(1),
    CAIRN_DB_SCHEMA: z.string().min(1).default('cairn'),
  }),
)

export type DbEnv = z.infer<typeof dbEnvSchema>

/**
 * 开发默认值。它们让本地与测试不必先配一屏环境变量，代价是
 * 「私有化交付漏配」的后果不是少个功能，而是签名密钥与管理员口令双双已知。
 * 因此默认串在此声明一次，schema 默认值与非 development 环境下的拒绝
 * 共用同一个常量——改默认值的人必然看到检查。
 */
export const DEV_JWT_SECRET = 'dev-only-change-me-jwt-secret'
export const DEV_ADMIN_PASSWORD = 'cairn-admin'

/**
 * 开发默认凭据主密钥：`cairn-dev-only-credential-key-01` 的 32 字节 ASCII，再 base64。
 * 字面量只存在这里，schema 默认值与非 development 拒绝共用。
 */
export const DEV_CREDENTIAL_KEY = 'Y2Fpcm4tZGV2LW9ubHktY3JlZGVudGlhbC1rZXktMDE='

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/

/** 解码 `CAIRN_CREDENTIAL_KEY`。不合法或不是 32 字节则返回 undefined。 */
export function decodeCredentialKey(raw: string): Uint8Array | undefined {
  if (!BASE64_PATTERN.test(raw)) return undefined
  try {
    const BufferCtor = (globalThis as { Buffer?: { from(value: string, enc: string): Uint8Array } })
      .Buffer
    const bytes = BufferCtor
      ? Uint8Array.from(BufferCtor.from(raw, 'base64'))
      : Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
    if (bytes.byteLength !== 32) return undefined
    return bytes
  } catch {
    return undefined
  }
}

const CAIRN_ENVS = ['development', 'staging', 'production'] as const

/**
 * 合法的 CORS origin：`scheme://host[:port]`，或单独的 `*`。
 *
 * 浏览器发出的 Origin 永远带 scheme，写成 `localhost:5173` 的白名单永远匹配不上，
 * 而这种漏写在启动阶段没有任何症状。
 */
const ORIGIN_PATTERN = /^(?:\*|[a-z][a-z0-9+.-]*:\/\/[^\s/]+)$/i

/** api 与 worker 共用：环境语义与日志级别，不各写一份。 */
const runtimeEnvShape = {
  CAIRN_ENV: z.enum(CAIRN_ENVS).default('development'),
  CAIRN_LOG_LEVEL: logLevelSchema.default('info'),
}

/**
 * 控制面进程配置。
 *
 * `CAIRN_ENV` 只承担「环境相关的强度差异」，不承担业务分支；业务判断仍看
 * 显式的功能配置。`NODE_ENV` 留给工具链，不参与平台判断，避免两套环境概念。
 */
export const apiEnvSchema = z.preprocess(
  blankAsUnset,
  z
    .object({
      CAIRN_API_PORT: z.coerce.number().int().min(1).max(65535).default(3030),
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
      CAIRN_JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
      CAIRN_JWT_EXPIRES_IN: z.string().min(1).default('12h'),
      CAIRN_BOOTSTRAP_ADMIN_EMAIL: z.email().default('admin@cairn.dev'),
      CAIRN_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default(DEV_ADMIN_PASSWORD),
      CAIRN_BOOTSTRAP_ADMIN_NAME: z.string().min(1).default('Administrator'),
      /**
       * 本地 SecretProvider 的 AES-256-GCM 主密钥：base64 编码的恰好 32 字节。
       * 不做 hex 兼容。解码失败或长度不对则进程拒绝启动。
       */
      CAIRN_CREDENTIAL_KEY: z
        .string()
        .default(DEV_CREDENTIAL_KEY)
        .superRefine((value, ctx) => {
          if (!decodeCredentialKey(value)) {
            ctx.addIssue({
              code: 'custom',
              message: '须为 base64 编码的 32 字节密钥',
            })
          }
        }),
      ...runtimeEnvShape,
    })
    .superRefine((env, ctx) => {
      // 「默认值方便本地」与「生产不得裸奔」由同一个 schema 同时成立，
      // 不依赖部署清单上的一行提醒。
      if (env.CAIRN_ENV === 'development') return
      if (env.CAIRN_JWT_SECRET === DEV_JWT_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_JWT_SECRET'],
          message: '非 development 环境不得沿用开发默认密钥，必须在环境中覆盖',
        })
      }
      if (env.CAIRN_BOOTSTRAP_ADMIN_PASSWORD === DEV_ADMIN_PASSWORD) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_BOOTSTRAP_ADMIN_PASSWORD'],
          message: '非 development 环境不得沿用默认管理员口令，必须在环境中覆盖',
        })
      }
      if (env.CAIRN_CREDENTIAL_KEY === DEV_CREDENTIAL_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['CAIRN_CREDENTIAL_KEY'],
          message: '非 development 环境不得沿用开发默认凭据主密钥，必须在环境中覆盖',
        })
      }
    }),
)

export type ApiEnv = z.infer<typeof apiEnvSchema>

/**
 * 执行面进程配置。
 *
 * `CAIRN_WORKER_ID` 在 Lease / 多 Worker 落地前允许本地默认；正式部署必须
 * 每实例唯一，唯一性由部署或后续的注册检查保证，不在这里做。
 */
export const workerEnvSchema = z.preprocess(
  blankAsUnset,
  z.object({
    CAIRN_WORKER_ID: z.string().min(1).default('local-worker'),
    ...runtimeEnvShape,
  }),
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
