import { randomUUID } from 'node:crypto'
import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { REQUEST_ID_HEADER } from '@cairn/shared'

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
 * 只是 pino 未启用时的兜底。
 *
 * 事后补关联 ID 意味着回头改每一处日志调用与错误响应，所以骨架阶段
 * 就接上：同一个值出现在响应头、错误体和日志里，排障时凭它串起三者。
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    if (!req.requestId) {
      const incoming = req.headers[REQUEST_ID_HEADER]
      req.requestId = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID()
    }
    res.setHeader(REQUEST_ID_HEADER, req.requestId)
    next()
  }
}
