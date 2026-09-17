import { z } from 'zod'

/**
 * 日志跨进程约定。
 *
 * api 与 worker 的 LoggerModule 必须用同一份脱敏清单——各写一份的结局是
 * 一边补了新字段另一边没补，而凭证泄露只要漏一处就成立。
 */

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const logLevelSchema = z.enum(LOG_LEVELS)

/** 脱敏后的占位，保持字段存在但值不可重放。 */
export const LOGGING_CENSOR = '[redacted]'

/**
 * pino `redact` 的基线清单，只增不减。
 *
 * 前提是「默认序列化器不可信」：pino-http 的 req 序列化器会把整份 headers
 * 写进日志，已认证请求因此会把可重放的 Bearer 令牌与 Cookie 明文落盘。
 * 新增日志中间件、customProps 或 error 序列化时，先确认它不会把
 * headers / body / env 整个倒出来，再决定是否往这里加路径。
 */
export const LOGGING_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // 目标账号设密走请求体。默认序列化器不写 body，但一旦有人打开 body
  // 日志或把 req 整份倒进 customProps，这条路径必须已经在清单里。
  'req.body.password',
  'res.body.token',
  'res.body.secretDigest',
  'token',
  'secretDigest',
  'req.body.account.password',
  'CAIRN_BROWSER_AI_API_KEY',
  'env.CAIRN_BROWSER_AI_API_KEY',
]

export const PROCESS_LOG_EVENTS = {
  runStarted: 'run.started',
  runFinished: 'run.finished',
  attemptStarted: 'attempt.started',
  attemptFinished: 'attempt.finished',
  runHolding: 'run.holding',
  aiModelCall: 'ai.model_call',
  aiModelCallFailed: 'ai.model_call_failed',
} as const

export type ProcessLogEvent = (typeof PROCESS_LOG_EVENTS)[keyof typeof PROCESS_LOG_EVENTS]

export const PROCESS_LOG_EXITS = [
  'completed',
  'failed',
  'cancelled',
  'held',
  'yielded',
  'stopped',
] as const

export type ProcessLogExit = (typeof PROCESS_LOG_EXITS)[number]

export const processLogServiceSchema = z.enum(['cairn-api', 'cairn-worker'])
export type ProcessLogService = z.infer<typeof processLogServiceSchema>

/** 去掉 undefined，禁止调用方用 "unknown" 冒充缺失字段。 */
export function bindLogFields(
  fields: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const bound: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (value === 'unknown') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      bound[key] = value
    }
  }
  return bound
}

/** api / worker 共用的 level、base、redact。HTTP 相关项仍只属于 api。 */
export function buildProcessLoggerBindings(input: {
  service: ProcessLogService
  level: LogLevel
  workerId?: string
}): {
  level: LogLevel
  base: Record<string, string>
  redact: { paths: string[]; censor: string }
} {
  return {
    level: input.level,
    base: bindLogFields({ service: input.service, workerId: input.workerId }) as Record<string, string>,
    redact: { paths: [...LOGGING_REDACT_PATHS], censor: LOGGING_CENSOR },
  }
}
