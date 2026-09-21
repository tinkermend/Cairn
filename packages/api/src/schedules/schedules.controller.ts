import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  scheduleEnabledBodySchema,
  scheduleEventListQuerySchema,
  scheduleListQuerySchema,
  scheduleOccurrenceListQuerySchema,
  schedulePreviewQuerySchema,
  schedulePreviewRequestSchema,
  scheduleTriggerBodySchema,
  scheduleWriteBodySchema,
  type ScheduleEnabledBody,
  type ScheduleEventListQuery,
  type ScheduleListQuery,
  type ScheduleOccurrenceListQuery,
  type SchedulePreviewQuery,
  type SchedulePreviewRequest,
  type ScheduleTriggerBody,
  type ScheduleWriteBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { SchedulesService } from './schedules.service'

@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  @RequirePermissions('schedule:read')
  list(@Query(new ZodValidationPipe(scheduleListQuerySchema)) query: ScheduleListQuery, @CurrentAccount() account: RequestAccount) {
    return this.schedules.list(query, account.id)
  }

  @Get('preview')
  @RequirePermissions('schedule:read')
  previewGet(@Query(new ZodValidationPipe(schedulePreviewQuerySchema)) query: SchedulePreviewQuery) {
    return this.schedules.previewQuery(query)
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:write')
  create(
    @Body(new ZodValidationPipe(scheduleWriteBodySchema)) body: ScheduleWriteBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.schedules.create(body, account)
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:read')
  preview(@Body(new ZodValidationPipe(schedulePreviewRequestSchema)) body: SchedulePreviewRequest) {
    return this.schedules.preview(body)
  }

  @Get(':scheduleId')
  @RequirePermissions('schedule:read')
  get(@Param('scheduleId') scheduleId: string) {
    return this.schedules.get(scheduleId)
  }

  @Post(':scheduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:write')
  update(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(scheduleWriteBodySchema)) body: ScheduleWriteBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.schedules.update(scheduleId, body, account)
  }

  @Post(':scheduleId/enabled')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:write')
  enabled(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(scheduleEnabledBodySchema)) body: ScheduleEnabledBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.schedules.enabled(scheduleId, body, account)
  }

  @Post(':scheduleId/trigger')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:write')
  trigger(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(scheduleTriggerBodySchema)) body: ScheduleTriggerBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.schedules.trigger(scheduleId, body, account)
  }

  @Get(':scheduleId/occurrences')
  @RequirePermissions('schedule:read')
  occurrences(
    @Param('scheduleId') scheduleId: string,
    @Query(new ZodValidationPipe(scheduleOccurrenceListQuerySchema)) query: ScheduleOccurrenceListQuery,
  ) {
    return this.schedules.occurrences(scheduleId, query)
  }

  @Get(':scheduleId/events')
  @RequirePermissions('schedule:read')
  events(
    @Param('scheduleId') scheduleId: string,
    @Query(new ZodValidationPipe(scheduleEventListQuerySchema)) query: ScheduleEventListQuery,
  ) {
    return this.schedules.events(scheduleId, query)
  }

  @Get(':scheduleId/observe')
  @RequirePermissions('schedule:read')
  observe(
    @Param('scheduleId') scheduleId: string,
    @CurrentAccount() account: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
    @Query('after') after?: string,
  ) {
    return this.schedules.observe(scheduleId, account.id, req, res, Number(after ?? 0) || 0)
  }
}
