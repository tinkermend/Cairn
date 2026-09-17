import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  entityIdSchema,
  hasPermission,
  isSessionIdleOnlyKind,
  acquireAuthControlBodySchema,
  authControlInputBodySchema,
  authControlTokenBodySchema,
  browserSessionListQuerySchema,
  disposeSessionBodySchema,
  requestSessionOperationBodySchema,
  sessionObserveQuerySchema,
  sessionOverviewQuerySchema,
  sessionRetentionBodySchema,
  sessionSystemOverviewQuerySchema,
  type AcquireAuthControlBody,
  type AuthControlInputBody,
  type AuthControlTokenBody,
  type BrowserSessionListQuery,
  type DisposeSessionBody,
  type RequestSessionOperationBody,
  type SessionObserveQuery,
  type SessionOverviewQuery,
  type SessionRetentionBody,
  type SessionSystemOverviewQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { abortWhenSseClientDrops } from '../common/sse-abort'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { BrowserSessionsService } from './browser-sessions.service'

@Controller('browser-sessions')
export class BrowserSessionsController {
  constructor(private readonly sessions: BrowserSessionsService) {}

  @Get()
  @RequirePermissions('session:read')
  list(@Query(new ZodValidationPipe(browserSessionListQuerySchema)) query: BrowserSessionListQuery) {
    return this.sessions.list(query)
  }

  @Get('overview')
  @RequirePermissions('session:read')
  overview(@Query(new ZodValidationPipe(sessionOverviewQuerySchema)) query: SessionOverviewQuery) {
    return this.sessions.overview(query)
  }

  @Get('systems')
  @RequirePermissions('session:read')
  systems(@Query(new ZodValidationPipe(sessionSystemOverviewQuerySchema)) query: SessionSystemOverviewQuery) {
    return this.sessions.systemOverview(query)
  }

  @Get('observe')
  @RequirePermissions('session:read')
  observe(
    @Query(new ZodValidationPipe(sessionObserveQuerySchema)) query: SessionObserveQuery,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.sessions.streamObserve({
      query,
      account: actor,
      authorization: headerValue(req.headers.authorization),
      response: res,
      signal: abortWhenSseClientDrops(req, res),
    })
  }

  @Get(':sessionId')
  @RequirePermissions('session:read')
  get(@Param('sessionId', new ZodValidationPipe(entityIdSchema)) sessionId: string) {
    return this.sessions.get(sessionId)
  }

  @Get(':sessionId/events')
  @RequirePermissions('session:read')
  events(@Param('sessionId', new ZodValidationPipe(entityIdSchema)) sessionId: string, @Query('cursor') cursor?: string) {
    return this.sessions.events(sessionId, cursor)
  }

  @Get(':sessionId/browser')
  @RequirePermissions('session:read', 'session:view')
  browserMeta(
    @Param('sessionId', new ZodValidationPipe(entityIdSchema)) sessionId: string,
    @CurrentAccount() actor: RequestAccount,
    @Query('pageId') pageId?: string,
  ) {
    return this.sessions.browserMeta(sessionId, actor, pageId)
  }

  @Get(':sessionId/browser/frames')
  @RequirePermissions('session:read', 'session:view')
  browserFrames(
    @Param('sessionId', new ZodValidationPipe(entityIdSchema)) sessionId: string,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.sessions.streamFrames({
      ownerId: sessionId,
      pageId: typeof req.query.pageId === 'string' ? req.query.pageId : undefined,
      actor,
      authorization: headerValue(req.headers.authorization),
      response: res,
      signal: abortWhenSseClientDrops(req, res),
    })
  }

  @Post(':sessionId/dispose')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:dispose')
  dispose(
    @Param('sessionId', new ZodValidationPipe(entityIdSchema)) sessionId: string,
    @Body(new ZodValidationPipe(disposeSessionBodySchema)) body: DisposeSessionBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.dispose(sessionId, body, actor)
  }
}

@Controller('session-operations')
export class SessionOperationsController {
  constructor(private readonly sessions: BrowserSessionsService) {}

  @Get(':operationId')
  @RequirePermissions('session:read')
  get(@Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string) {
    return this.sessions.getOperation(operationId)
  }

  @Post(':operationId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  cancel(@Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string, @CurrentAccount() actor: RequestAccount) {
    return this.sessions.cancelOperation(operationId, actor)
  }

  @Post(':operationId/complete-auth')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  completeAuth(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @CurrentAccount() actor: RequestAccount,
    @Body(new ZodValidationPipe(authControlTokenBodySchema)) body: AuthControlTokenBody,
  ) {
    return this.sessions.completeAuth(operationId, actor, body)
  }

  @Post(':operationId/auth-control/acquire')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  acquire(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @Body(new ZodValidationPipe(acquireAuthControlBodySchema)) body: AcquireAuthControlBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.acquireAuth(operationId, body, actor)
  }

  @Post(':operationId/auth-control/heartbeat')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  heartbeat(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @Body(new ZodValidationPipe(authControlTokenBodySchema)) body: AuthControlTokenBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.heartbeatAuth(operationId, body, actor)
  }

  @Post(':operationId/auth-control/input')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  input(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @Body(new ZodValidationPipe(authControlInputBodySchema)) body: AuthControlInputBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.inputAuth(operationId, body, actor)
  }

  @Post(':operationId/auth-control/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  release(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @Body(new ZodValidationPipe(authControlTokenBodySchema)) body: AuthControlTokenBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.releaseAuth(operationId, body, actor)
  }

  @Get(':operationId/browser')
  @RequirePermissions('session:read', 'session:view')
  browserMeta(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @CurrentAccount() actor: RequestAccount,
    @Query('pageId') pageId?: string,
  ) {
    return this.sessions.browserMeta(operationId, actor, pageId)
  }

  @Get(':operationId/browser/frames')
  @RequirePermissions('session:read', 'session:view')
  browserFrames(
    @Param('operationId', new ZodValidationPipe(entityIdSchema)) operationId: string,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.sessions.streamFrames({
      ownerId: operationId,
      pageId: typeof req.query.pageId === 'string' ? req.query.pageId : undefined,
      actor,
      authorization: headerValue(req.headers.authorization),
      response: res,
      signal: abortWhenSseClientDrops(req, res),
    })
  }
}

@Controller('targets/:targetId/accounts/:accountId/session')
export class AccountSessionController {
  constructor(private readonly sessions: BrowserSessionsService) {}

  @Get()
  @RequirePermissions('session:read')
  detail(@Param('targetId', new ZodValidationPipe(entityIdSchema)) targetId: string, @Param('accountId', new ZodValidationPipe(entityIdSchema)) accountId: string) {
    return this.sessions.accountDetail(targetId, accountId)
  }

  @Get('events')
  @RequirePermissions('session:read')
  events(
    @Param('targetId', new ZodValidationPipe(entityIdSchema)) targetId: string,
    @Param('accountId', new ZodValidationPipe(entityIdSchema)) accountId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.sessions.accountEvents(targetId, accountId, cursor)
  }

  @Post('operations')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('session:control')
  requestOperation(
    @Param('targetId', new ZodValidationPipe(entityIdSchema)) targetId: string,
    @Param('accountId', new ZodValidationPipe(entityIdSchema)) accountId: string,
    @Body(new ZodValidationPipe(requestSessionOperationBodySchema)) body: RequestSessionOperationBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    if (isSessionIdleOnlyKind(body.kind) && !hasPermission(actor.permissions, 'session:manage')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: '关闭、重启或清除会话需要 session:manage' })
    }
    return this.sessions.requestAccountOperation(targetId, accountId, body, actor)
  }

  @Post('retention')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control')
  retention(
    @Param('targetId', new ZodValidationPipe(entityIdSchema)) targetId: string,
    @Param('accountId', new ZodValidationPipe(entityIdSchema)) accountId: string,
    @Body(new ZodValidationPipe(sessionRetentionBodySchema)) body: SessionRetentionBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.sessions.setRetention(targetId, accountId, body, actor)
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
