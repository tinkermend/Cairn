import { randomUUID } from 'node:crypto'
import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { REQUEST_ID_HEADER, resolveRequestId } from '@cairn/shared'

declare module 'express' {
  interface Request {
    requestId?: string
  }
}

/**
 * 把 requestId 回写到响应头。
 *
 * 值本身由 pino-http 的 genReqId 确定——它在 Nest 中间件之前执行，
 * 若在此处才生成，日志里的 req.id 会先于赋值被取走。这里的生成分支
 * 只是 pino 未启用时的兜底，取值优先级与 genReqId 保持一致。
 *
 * 出站只写平台私有头 `x-cairn-request-id`：入站可以接住网关的
 * `x-request-id`，但回写两个头会让「谁是事实源」再次含糊。
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (!req.requestId) req.requestId = resolveRequestId(req.headers) ?? randomUUID()
    res.setHeader(REQUEST_ID_HEADER, req.requestId)
    next()
  }
}
