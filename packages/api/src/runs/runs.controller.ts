import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  createRunBodySchema,
  resumeAuthBodySchema,
  reviewRunBodySchema,
  type CreateRunBody,
  type ResumeAuthBody,
  type ReviewRunBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { RunsService } from './runs.service'

@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  @RequirePermissions('run:read')
  list() {
    return this.runs.list()
  }

  @Post()
  @RequirePermissions('run:execute')
  async create(
    @Body(new ZodValidationPipe(createRunBodySchema)) body: CreateRunBody,
    @CurrentAccount() actor: RequestAccount,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { detail, created } = await this.runs.create(body, actor)
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK)
    return detail
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

  @Post(':runId/resume-auth')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('run:execute')
  resumeAuth(
    @Param('runId') runId: string,
    @Body(new ZodValidationPipe(resumeAuthBodySchema)) body: ResumeAuthBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.runs.resumeAuth(runId, body, actor)
  }
}
