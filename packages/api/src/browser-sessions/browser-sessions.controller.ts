import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  browserSessionListQuerySchema,
  disposeSessionBodySchema,
  type BrowserSessionListQuery,
  type DisposeSessionBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { BrowserSessionsService } from './browser-sessions.service'

/**
 * Browser Session 控制面。
 *
 * 只读元数据 + 人工处置。API 不持有会话、不驱动浏览器（宪法「执行分层」）；
 * 处置只改持久化状态，把卡死的 Target + TargetAccount 键放回去。
 */
@Controller('browser-sessions')
export class BrowserSessionsController {
  constructor(private readonly sessions: BrowserSessionsService) {}

  @Get()
  @RequirePermissions('session:read')
  list(@Query(new ZodValidationPipe(browserSessionListQuerySchema)) query: BrowserSessionListQuery) {
    return this.sessions.list(query)
  }

  @Post(':sessionId/dispose')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:dispose')
  dispose(
    @Param('sessionId') sessionId: string,
    @Body(new ZodValidationPipe(disposeSessionBodySchema)) body: DisposeSessionBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.dispose(sessionId, body, actor)
  }
}
