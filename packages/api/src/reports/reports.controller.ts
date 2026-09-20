import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  contentDispositionAttachment,
  createReportBodySchema,
  createReportRevisionBodySchema,
  exportReportBodySchema,
  reportListQuerySchema,
  type CreateReportBody,
  type CreateReportRevisionBody,
  type ExportReportBody,
  type ReportListQuery,
  reportSubjectSchema, deriveMemberReportBodySchema, retryExportJobBodySchema,
  type ReportSubject, type DeriveMemberReportBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ReportsService } from './reports.service'

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @RequirePermissions('report:read')
  list(@Query(new ZodValidationPipe(reportListQuerySchema)) query: ReportListQuery, @CurrentAccount() account: RequestAccount) {
    return this.reports.list(query, account.id)
  }

  @Get('source-options')
  @RequirePermissions('report:read')
  options(@Query(new ZodValidationPipe(reportSubjectSchema)) subject: ReportSubject, @CurrentAccount() account: RequestAccount) { return this.reports.sourceOptions(subject, account.id) }

  @Get(':reportId/revisions')
  @RequirePermissions('report:read')
  revisions(@Param('reportId') id: string, @Query('cursor') cursor: string | undefined, @CurrentAccount() account: RequestAccount) { return this.reports.revisions(id, account.id, cursor) }

  @Get(':reportId/export-jobs')
  @RequirePermissions('report:read')
  jobs(@Param('reportId') id: string, @Query('cursor') cursor: string | undefined, @CurrentAccount() account: RequestAccount) { return this.reports.jobs(id, account.id, cursor) }

  @Post(':reportId/revisions/:revisionId/members')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  async derive(@Param('reportId') id: string, @Param('revisionId') revision: string, @Body(new ZodValidationPipe(deriveMemberReportBodySchema)) body: DeriveMemberReportBody, @CurrentAccount() account: RequestAccount) {
    await this.reports.revision(id, revision, account.id)
    return this.reports.derive(revision, body, account)
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:read')
  preview(@Body(new ZodValidationPipe(createReportBodySchema)) body: CreateReportBody, @CurrentAccount() account: RequestAccount) {
    return this.reports.preview(body, account.id)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  create(@Body(new ZodValidationPipe(createReportBodySchema)) body: CreateReportBody, @CurrentAccount() account: RequestAccount) {
    return this.reports.create(body, account)
  }

  @Get(':reportId')
  @RequirePermissions('report:read')
  get(@Param('reportId') reportId: string, @CurrentAccount() account: RequestAccount) {
    return this.reports.get(reportId, account.id)
  }

  @Get(':reportId/revisions/:revisionId')
  @RequirePermissions('report:read')
  revision(
    @Param('reportId') reportId: string,
    @Param('revisionId') revisionId: string,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.reports.revision(reportId, revisionId, account.id)
  }

  @Post(':reportId/revisions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  addRevision(
    @Param('reportId') reportId: string,
    @Body(new ZodValidationPipe(createReportRevisionBodySchema)) body: CreateReportRevisionBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.reports.addRevision(reportId, body, account)
  }

  @Post(':reportId/revisions/:revisionId/export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  export(
    @Param('reportId') reportId: string,
    @Param('revisionId') revisionId: string,
    @Body(new ZodValidationPipe(exportReportBodySchema)) body: ExportReportBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.reports.export(reportId, revisionId, body, account)
  }

  @Post(':reportId/delete-preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:delete')
  deletePreview(@Param('reportId') reportId: string, @CurrentAccount() account: RequestAccount) {
    return this.reports.deletePreview(reportId, account.id)
  }

  @Post(':reportId/delete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:delete')
  delete(@Param('reportId') reportId: string, @CurrentAccount() account: RequestAccount) {
    return this.reports.delete(reportId, account)
  }
}

@Controller('export-jobs')
export class ExportJobsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':jobId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  cancel(@Param('jobId') id: string, @CurrentAccount() account: RequestAccount) { return this.reports.cancelJob(id, account) }

  @Post(':jobId/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('report:export')
  retry(@Param('jobId') id: string, @Body(new ZodValidationPipe(retryExportJobBodySchema)) body: { idempotencyKey: string }, @CurrentAccount() account: RequestAccount) { return this.reports.retryJob(id, body.idempotencyKey, account) }

  @Get(':jobId')
  @RequirePermissions('report:read')
  get(@Param('jobId') jobId: string, @CurrentAccount() account: RequestAccount) {
    return this.reports.job(jobId, account.id)
  }

  @Get(':jobId/events')
  @RequirePermissions('report:read')
  events(@Param('jobId') jobId: string, @CurrentAccount() account: RequestAccount, @Req() req: Request, @Res() res: Response) {
    return this.reports.streamJob(jobId, account.id, req, res)
  }
}

@Controller('artifacts')
export class ArtifactsController {
  constructor(private readonly reports: ReportsService) {}

  @Get(':artifactId/content')
  @RequirePermissions('report:export')
  async content(
    @Param('artifactId') artifactId: string,
    @CurrentAccount() account: RequestAccount,
    @Res() res: Response,
  ) {
    const file = await this.reports.artifactStream(artifactId, account.id)
    res.setHeader('Content-Type', file.contentType)
    if (file.byteSize != null) res.setHeader('Content-Length', String(file.byteSize))
    res.setHeader('Content-Disposition', contentDispositionAttachment(file.fileName))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.status(HttpStatus.OK)
    await pipeline(Readable.from(file.chunks), res)
  }
}
