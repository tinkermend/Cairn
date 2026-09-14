import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  acquireAuthControlBodySchema,
  authControlInputBodySchema,
  authControlTokenBodySchema,
  createRunBodySchema,
  resumeAuthBodySchema,
  reviewRunBodySchema,
  type AcquireAuthControlBody,
  type AuthControlInputBody,
  type AuthControlTokenBody,
  type CreateRunBody,
  type ResumeAuthBody,
  type ReviewRunBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { BrowserService } from './browser.service'
import { ObserveService } from './observe.service'
import { RunsService } from './runs.service'

@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly observe: ObserveService,
    private readonly browser: BrowserService,
  ) {}

  @Get()
  @RequirePermissions('run:read')
  list() {
    return this.runs.list()
  }

  @Post()
  @RequirePermissions('run:execute', 'target:read', 'workflow:read')
  async create(
    @Body(new ZodValidationPipe(createRunBodySchema)) body: CreateRunBody,
    @CurrentAccount() actor: RequestAccount,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { detail, created } = await this.runs.create(body, actor)
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK)
    return detail
  }

  @Get(':runId/observation')
  @RequirePermissions('run:read')
  async observation(@Param('runId') runId: string) {
    const result = await this.observe.observation(runId)
    if (!result) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
    return result
  }

  @Get(':runId/events')
  @RequirePermissions('run:read')
  async events(
    @Param('runId') runId: string,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.observe.observation(runId)
    if (!result) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
    const lastEventId = headerValue(req.headers['last-event-id'])
    await this.observe.stream({
      runId,
      lastEventId,
      authorization: headerValue(req.headers.authorization),
      account: actor,
      response: res,
      signal: abortFrom(req),
    })
  }

  @Get(':runId')
  @RequirePermissions('run:read')
  get(@Param('runId') runId: string) {
    return this.runs.get(runId)
  }

  @Get(':runId/evidence')
  @RequirePermissions('run:read')
  evidence(@Param('runId') runId: string) {
    return this.runs.evidence(runId)
  }

  @Get(':runId/evidence/:evidenceId/content')
  @RequirePermissions('run:read')
  async evidenceContent(
    @Param('runId') runId: string,
    @Param('evidenceId') evidenceId: string,
    @Res() res: Response,
  ) {
    const file = await this.runs.evidenceContent(runId, evidenceId)
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Length', String(file.byteSize))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.status(HttpStatus.OK).send(Buffer.from(file.body))
  }

  @Post(':runId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:cancel')
  cancel(@Param('runId') runId: string, @CurrentAccount() actor: RequestAccount) {
    return this.runs.cancel(runId, actor)
  }

  @Post(':runId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:review')
  review(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(reviewRunBodySchema)) body: ReviewRunBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.runs.review(runId, body, actor)
  }

  @Get(':runId/browser')
  @RequirePermissions('run:read', 'session:view')
  browserMeta(@Param('runId') runId: string, @CurrentAccount() actor: RequestAccount, @Req() req: Request) {
    return this.browser.meta(runId, actor, queryValue(req.query.pageId))
  }

  @Get(':runId/browser/frames')
  @RequirePermissions('run:read', 'session:view')
  async browserFrames(
    @Param('runId') runId: string,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.browser.streamFrames({
      runId,
      pageId: queryValue(req.query.pageId),
      actor,
      authorization: headerValue(req.headers.authorization),
      response: res,
      signal: abortFrom(req),
    })
  }

  @Post(':runId/browser/auth-control/acquire')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control', 'run:execute')
  acquireAuthControl(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(acquireAuthControlBodySchema)) body: AcquireAuthControlBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.acquire(runId, body, actor)
  }

  @Post(':runId/browser/auth-control/heartbeat')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control', 'run:execute')
  heartbeatAuthControl(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(authControlTokenBodySchema)) body: AuthControlTokenBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.heartbeat(runId, body, actor)
  }

  @Post(':runId/browser/auth-control/input')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control', 'run:execute')
  inputAuthControl(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(authControlInputBodySchema)) body: AuthControlInputBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.input(runId, body, actor)
  }

  @Post(':runId/browser/auth-control/release')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control', 'run:execute')
  releaseAuthControl(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(authControlTokenBodySchema)) body: AuthControlTokenBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.release(runId, body, actor)
  }

  @Post(':runId/resume-auth')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control', 'run:execute')
  resumeAuth(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(resumeAuthBodySchema)) body: ResumeAuthBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.resumeAuth(runId, body, actor)
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function queryValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function abortFrom(req: Request): AbortSignal {
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  return controller.signal
}
