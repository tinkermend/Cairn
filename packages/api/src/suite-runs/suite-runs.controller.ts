import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  createSuiteRunBodySchema,
  suiteRunListQuerySchema,
  type CreateSuiteRunBody,
  type SuiteRunListQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { SuiteRunsService } from './suite-runs.service'

@Controller('suite-runs')
export class SuiteRunsController {
  constructor(private readonly suiteRuns: SuiteRunsService) {}

  @Get()
  @RequirePermissions('suite:read')
  list(@Query(new ZodValidationPipe(suiteRunListQuerySchema)) query: SuiteRunListQuery, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.list(query, account.id)
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'suite:read')
  preview(@Body(new ZodValidationPipe(createSuiteRunBodySchema)) body: CreateSuiteRunBody, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.preview(body, account.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute', 'suite:read')
  create(@Body(new ZodValidationPipe(createSuiteRunBodySchema)) body: CreateSuiteRunBody, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.create(body, account)
  }

  @Get(':suiteRunId/observation')
  @RequirePermissions('suite:read')
  observation(@Param('suiteRunId') suiteRunId: string, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.observation(suiteRunId, account.id)
  }

  @Get(':suiteRunId/events')
  @RequirePermissions('suite:read')
  events(
    @Param('suiteRunId') suiteRunId: string,
    @CurrentAccount() account: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.suiteRuns.stream(suiteRunId, account.id, req, res)
  }

  @Post(':suiteRunId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:cancel', 'suite:read')
  cancel(@Param('suiteRunId') suiteRunId: string, @CurrentAccount() account: RequestAccount) {
    return this.suiteRuns.cancel(suiteRunId, account)
  }
}
