import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  analysisJobCancelBodySchema,
  analysisJobListQuerySchema,
  type AnalysisJobCancelBody,
  type AnalysisJobListQuery,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { AnalysisJobsService } from './analysis-jobs.service'

@Controller('analysis-jobs')
export class AnalysisJobsController {
  constructor(private readonly jobs: AnalysisJobsService) {}

  @Get()
  @RequirePermissions('map:analyze')
  list(@Query(new ZodValidationPipe(analysisJobListQuerySchema)) query: AnalysisJobListQuery, @CurrentAccount() account: RequestAccount) {
    return this.jobs.list(query, account.id)
  }

  @Get(':jobId')
  @RequirePermissions('map:analyze')
  get(@Param('jobId') jobId: string, @CurrentAccount() account: RequestAccount) {
    return this.jobs.get(jobId, account.id)
  }

  @Get(':jobId/observe')
  @RequirePermissions('map:analyze')
  observe(@Param('jobId') jobId: string, @CurrentAccount() account: RequestAccount, @Req() req: Request, @Res() res: Response, @Query('after') after?: string) {
    return this.jobs.observe(jobId, account.id, req, res, Number(after ?? 0))
  }

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('map:analyze')
  cancel(
    @Param('jobId') jobId: string,
    @Body(new ZodValidationPipe(analysisJobCancelBodySchema)) body: AnalysisJobCancelBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.jobs.cancel(jobId, body, account)
  }
}
