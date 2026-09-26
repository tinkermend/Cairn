import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  acquireAuthControlBodySchema,
  authControlInputBodySchema,
  authControlTokenBodySchema,
  createRunBodySchema,
  debugActionSchema,
  observeOperationSchema,
  resumeAuthBodySchema,
  reviewRunBodySchema,
  deleteResourceBodySchema,
  mapDecisionListQuerySchema,
  resolutionDecisionListQuerySchema,
  runListQuerySchema,
  stepIterationListQuerySchema,
  type MapDecisionListQuery,
  type ResolutionDecisionListQuery,
  type StepIterationListQuery,
  type AcquireAuthControlBody,
  type DeleteResourceBody,
  aiTaskListQuerySchema,
  type AiTaskListQuery,
  type AuthControlInputBody,
  type AuthControlTokenBody,
  type CreateRunBody,
  type DebugAction,
  type ObserveOperation,
  type ResumeAuthBody,
  type ReviewRunBody,
  type RunListQuery,
  contentRangeHeader,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { BrowserService } from './browser.service'
import { ObserveService } from './observe.service'
import { RunsService } from './runs.service'
import { cleanupAcceptedStatus } from '../common/cleanup-status'
import { abortWhenSseClientDrops } from '../common/sse-abort'

@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly observations: ObserveService,
    private readonly browser: BrowserService,
  ) {}

  @Get()
  @RequirePermissions('run:read')
  async list(@Query(new ZodValidationPipe(runListQuerySchema)) query: RunListQuery, @CurrentAccount() account: RequestAccount) {
    const result = await this.runs.list(query, account.id)
    if (!account.permissions.includes('report:read')) {
      return {
        ...result,
        items: result.items.map(({ runReportStatus, reportId, ...item }) => item),
      }
    }
    return result
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
  async observation(@Param('runId') runId: string, @CurrentAccount() account: RequestAccount) {
    const result = await this.observations.observation(runId)
    if (!result) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
    if (!account.permissions.includes('report:read')) {
      const { runReportStatus, reportId, reportError, ...restRun } = result.run
      return {
        ...result,
        run: restRun,
      }
    }
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
    const result = await this.observations.observation(runId)
    if (!result) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
    const lastEventId = headerValue(req.headers['last-event-id'])
    await this.observations.stream({
      runId,
      lastEventId,
      authorization: headerValue(req.headers.authorization),
      account: actor,
      response: res,
      signal: abortWhenSseClientDrops(req, res),
    })
  }

  @Get(':runId/map-decisions')
  @RequirePermissions('run:read', 'target:read')
  mapDecisions(
    @Param('runId') runId: string,
    @Query(new ZodValidationPipe(mapDecisionListQuerySchema)) query: MapDecisionListQuery,
  ) {
    return this.runs.mapDecisions(runId, query)
  }

  @Get(':runId/resolution-decisions')
  @RequirePermissions('run:read', 'target:read')
  resolutionDecisions(
    @Param('runId') runId: string,
    @Query(new ZodValidationPipe(resolutionDecisionListQuerySchema)) query: ResolutionDecisionListQuery,
  ) {
    return this.runs.resolutionDecisions(runId, query)
  }

  @Get(':runId/attempts/:attemptId/ai-tasks')
  @RequirePermissions('run:read', 'target:read')
  aiTasks(
    @Param('runId') runId: string,
    @Param('attemptId') attemptId: string,
    @Query(new ZodValidationPipe(aiTaskListQuerySchema)) query: AiTaskListQuery,
  ) {
    return this.runs.aiTasks(runId, attemptId, query)
  }

  @Post(':runId/attempts/:attemptId/solidification-drafts')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:read', 'workflow:write', 'target:read')
  createSolidificationDraft(
    @Param('runId') runId: string,
    @Param('attemptId') attemptId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.runs.createSolidificationDraft(runId, attemptId, actor)
  }

  @Get(':runId/iterations')
  @RequirePermissions('run:read')
  async listIterations(
    @Param('runId') runId: string,
    @Query(new ZodValidationPipe(stepIterationListQuerySchema)) query: StepIterationListQuery,
  ) {
    const run = await this.runs.get(runId)
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
    return this.runs.iterations(runId, query)
  }

  @Get(':runId/iterations/:iterationId')
  @RequirePermissions('run:read')
  async getIteration(
    @Param('runId') runId: string,
    @Param('iterationId') iterationId: string,
  ) {
    const run = await this.runs.get(runId)
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
    const result = await this.runs.iterationDetail(runId, iterationId)
    if (!result) throw new NotFoundException({ code: 'ITERATION_NOT_FOUND', message: '迭代记录不存在' })
    return result
  }

  @Get(':runId')
  @RequirePermissions('run:read')
  async get(@Param('runId') runId: string, @CurrentAccount() account: RequestAccount) {
    const result = await this.runs.get(runId)
    if (!account.permissions.includes('report:read')) {
      const { runReportStatus, reportId, reportError, ...rest } = result
      return rest
    }
    return result
  }

  @Post(':runId/reports/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export', 'run:read')
  retryReport(
    @Param('runId') runId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.runs.retryReport(runId, actor)
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
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const header = headerValue(req.headers.range)
    const file = await this.runs.evidenceContent(runId, evidenceId, header)
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Length', String(file.byteSize))
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Accept-Ranges', 'bytes')
    if (file.range) {
      res.setHeader('Content-Range', contentRangeHeader(file.range, file.totalSize))
      res.status(HttpStatus.PARTIAL_CONTENT).send(Buffer.from(file.body))
      return
    }
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

  @Get(':runId/delete-preview')
  @RequirePermissions('run:delete')
  previewDelete(@Param('runId') runId: string) {
    return this.runs.previewDelete(runId)
  }

  @Post(':runId/delete')
  @RequirePermissions('run:delete')
  async delete(
    @Param('runId') runId: string,
    @CurrentAccount() actor: RequestAccount,
    @Body(new ZodValidationPipe(deleteResourceBodySchema.optional())) body: DeleteResourceBody | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cleanup = await this.runs.delete(runId, actor, body)
    res.status(cleanupAcceptedStatus(cleanup))
    return cleanup
  }

  @Get(':runId/cleanup')
  @RequirePermissions('run:read')
  cleanupStatus(@Param('runId') runId: string) {
    return this.runs.cleanupStatus(runId)
  }

  @Post(':runId/cleanup/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:delete')
  retryCleanup(@Param('runId') runId: string, @CurrentAccount() actor: RequestAccount) {
    return this.runs.retryCleanup(runId, actor)
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
      signal: abortWhenSseClientDrops(req, res),
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

  @Post(':runId/browser/pages/:pageId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('session:control', 'run:execute')
  closePage(
    @Param('runId') runId: string,
    @Param('pageId') pageId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.closePage(runId, pageId, actor)
  }

  @Post(':runId/observe')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:read', 'session:view', 'workflow:write')
  observe(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(observeOperationSchema)) body: ObserveOperation,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.observe(runId, body, actor)
  }

  @Post(':runId/debug')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'workflow:write')
  debug(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(debugActionSchema)) body: DebugAction,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.browser.debug(runId, body, actor)
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
