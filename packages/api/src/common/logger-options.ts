import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import type { Options } from 'pino-http'
import {
  LOGGING_CENSOR,
  LOGGING_REDACT_PATHS,
  resolveRequestId,
  type LogLevel,
} from '@cairn/shared'

/** pino 记录里的请求关联 ID 字段。`runId` 属于 Run，不得由请求 ID 冒充。 */
export interface RequestWithId extends Request {
  requestId?: string
}

export interface LoggerOptionsInput {
  service: 'cairn-api' | 'cairn-worker'
  level: LogLevel
}

/**
 * api 进程的 pino 配置。
 *
 * 脱敏清单与级别枚举来自 `@cairn/shared`，worker 用同一份常量自行装配——
 * 安全相关的清单必须单一来源，而 pino 本身不该被拖进浏览器侧依赖图。
 */
export function buildApiLoggerOptions({ service, level }: LoggerOptionsInput): Options<Request, Response> {
  return {
    level,
    base: { service },
    // pino-http 在 Nest 中间件之前执行，值在这里确定，
    // RequestIdMiddleware 只负责把它镜像到响应头。
    genReqId: (req) => {
      const id = resolveRequestId(req.headers) ?? randomUUID()
      ;(req as RequestWithId).requestId = id
      return id
    },
    // 字段名与 apiErrorSchema.requestId、响应头 x-cairn-request-id 三者同义
    customProps: (req) => ({ requestId: (req as RequestWithId).requestId }),
    // 默认序列化器不可信：pino-http 的 req 序列化器会把整份 headers 写出，
    // 已认证请求因此把可重放的 Bearer 令牌与 Cookie 明文落盘。
    redact: { paths: [...LOGGING_REDACT_PATHS], censor: LOGGING_CENSOR },
    autoLogging: { ignore: (req) => req.url === '/health' },
  }
}
