import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common'
import {
  scheduleEnabledBodySchema,
  scheduleEventListQuerySchema,
  scheduleListQuerySchema,
  scheduleOccurrenceListQuerySchema,
  schedulePreviewRequestSchema,
  scheduleWriteBodySchema,
  type ScheduleEnabledBody,
  type ScheduleEventListQuery,
  type ScheduleListQuery,
  type ScheduleOccurrenceListQuery,
  type SchedulePreviewRequest,
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

  @Post()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:write', 'map:maintain')
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
  @RequirePermissions('schedule:write', 'map:maintain')
  update(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(scheduleWriteBodySchema)) body: ScheduleWriteBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.schedules.update(scheduleId, body, account)
  }

  @Post(':scheduleId/enabled')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('schedule:write', 'map:maintain')
  enabled(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(scheduleEnabledBodySchema)) body: ScheduleEnabledBody,
    @CurrentAccount() account: RequestAccount,
  ) {
    return this.schedules.enabled(scheduleId, body, account)
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
}
