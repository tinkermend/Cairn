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
