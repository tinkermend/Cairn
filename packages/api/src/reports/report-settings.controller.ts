import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { createReportBundleBodySchema, reportProfileListQuerySchema, saveReportProfileBodySchema, saveScenarioReportDefaultsBodySchema, uploadReportAssetBodySchema, type CreateReportBundleBody, type SaveReportProfileBody, type UploadReportAssetBody } from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { ReportsService } from './reports.service'

@Controller('report-profiles')
export class ReportProfilesController {
  constructor(private readonly reports: ReportsService) {}
  @Get()
  @RequirePermissions('report:read')
  list(@Query(new ZodValidationPipe(reportProfileListQuerySchema)) query: { targetId: string; limit: number; cursor?: string }, @CurrentAccount() account: RequestAccount) { return this.reports.profiles(query, account.id) }
  @Get(':id')
  @RequirePermissions('report:read')
  get(@Param('id') id: string, @CurrentAccount() account: RequestAccount) { return this.reports.profile(id, account.id) }
  @Get(':id/versions')
  @RequirePermissions('report:read')
  versions(@Param('id') id: string, @Query('cursor') cursor: string | undefined, @CurrentAccount() account: RequestAccount) { return this.reports.profileVersions(id, cursor, account.id) }
  @Post()
  @HttpCode(200)
  create(@Body(new ZodValidationPipe(saveReportProfileBodySchema)) body: SaveReportProfileBody, @CurrentAccount() account: RequestAccount) { return this.reports.saveProfile(null, body, account) }
  @Post(':id/versions')
  @HttpCode(200)
  save(@Param('id') id: string, @Body(new ZodValidationPipe(saveReportProfileBodySchema)) body: SaveReportProfileBody, @CurrentAccount() account: RequestAccount) { return this.reports.saveProfile(id, body, account) }
}

@Controller('scenarios/:id/report-defaults')
export class ScenarioReportDefaultsController {
  constructor(private readonly reports: ReportsService) {}
  @Get()
  @RequirePermissions('workflow:read')
  get(@Param('id') id: string, @CurrentAccount() account: RequestAccount) { return this.reports.defaults(id, account.id) }
  @Post()
  @HttpCode(200)
  @RequirePermissions('workflow:write')
  save(@Param('id') id: string, @Body(new ZodValidationPipe(saveScenarioReportDefaultsBodySchema)) body: { profileId: string | null; expectedRevision: number }, @CurrentAccount() account: RequestAccount) { return this.reports.saveDefaults(id, body, account) }
}

@Controller('report-assets')
export class ReportAssetsController {
  constructor(private readonly reports: ReportsService) {}
  @Post()
  @HttpCode(200)
  upload(@Body(new ZodValidationPipe(uploadReportAssetBodySchema)) body: UploadReportAssetBody, @CurrentAccount() account: RequestAccount) { return this.reports.uploadLogo(body, account) }
}

@Controller('report-bundles')
export class ReportBundlesController {
  constructor(private readonly reports: ReportsService) {}
  @Post()
  @HttpCode(200)
  @RequirePermissions('report:export')
  create(@Body(new ZodValidationPipe(createReportBundleBodySchema)) body: CreateReportBundleBody, @CurrentAccount() account: RequestAccount) { return this.reports.bundle(body, account) }
}
