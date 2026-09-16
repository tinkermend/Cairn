import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { apiErrorSchema, errorCodeForStatus, type ApiError } from '@cairn/shared'

/**
 * 把任何抛出物收敛为 @cairn/shared 的 apiErrorSchema 形状。
 *
 * 两条原则：
 * 1. 5xx 不向外泄露内部细节（堆栈、SQL、连接串），只给 requestId，
 *    真实原因进服务端日志。4xx 是调用方能改的，可以说清楚。
 * 2. 出站错误体也过一遍 schema——契约由 shared 单向拥有，
 *    这里若不匹配应当立刻暴露而不是让前端解析失败。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const req = ctx.getRequest<Request>()
    const res = ctx.getResponse<Response>()
    const requestId = req.requestId ?? 'unknown'

    if (req.aborted || res.destroyed || res.writableEnded) return
    if (res.headersSent) {
      this.logger.warn({ requestId, path: req.originalUrl, err: exception }, '流式响应中断')
      res.end()
      return
    }

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR

    let message = '服务器内部错误'
    let issues: ApiError['issues']
    /** handler 显式给出的领域码；没有才回落状态码映射 */
    let explicitCode: string | undefined
    let details: unknown | undefined

    if (exception instanceof HttpException) {
      const body = exception.getResponse()
      if (typeof body === 'string') {
        message = body
      } else if (body && typeof body === 'object') {
        const b = body as {
          message?: unknown
          issues?: ApiError['issues']
          code?: unknown
          details?: unknown
        }
        message = Array.isArray(b.message)
          ? b.message.join('; ')
          : typeof b.message === 'string'
            ? b.message
            : exception.message
        issues = b.issues
        if (typeof b.code === 'string' && b.code.length > 0) explicitCode = b.code
        if (b.details !== undefined) details = b.details
      }
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // 内部错误的真实原因只进日志，不出网。领域码在这里同样被强制覆盖——
      // 否则它就成了绕过「5xx 不泄露细节」的新通道。
      this.logger.error(
        { requestId, path: req.originalUrl, err: exception },
        '未处理的异常',
      )
      message = '服务器内部错误'
      issues = undefined
      explicitCode = undefined
      details = undefined
    }

    const payload = apiErrorSchema.parse({
      code: explicitCode ?? errorCodeForStatus(status),
      message,
      requestId,
      ...(issues ? { issues } : {}),
      ...(details !== undefined ? { details } : {}),
    })

    if (status === 429 && details && typeof details === 'object' && 'retryAfter' in details) {
      const retry = Number(details.retryAfter)
      if (Number.isFinite(retry) && retry > 0) res.setHeader('Retry-After', String(Math.ceil(retry)))
    }
    res.status(status).json(payload)
  }
}
