import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  monitorAlertChannelBodySchema,
  monitorAlertListQuerySchema,
  monitorAlertRulesUpdateBodySchema,
  monitorAlertSilenceBodySchema,
  monitorProbeBodySchema,
  monitorProfileListQuerySchema,
  monitorSeriesQuerySchema,
  monitorStreamQuerySchema,
  type MonitorAlertChannelBody,
  type MonitorAlertListQuery,
  type MonitorAlertRulesUpdateBody,
  type MonitorAlertSilenceBody,
  type MonitorProbeBody,
  type MonitorProbeResponse,
  type MonitorProfileListQuery,
  type MonitorProfileListResponse,
  type MonitorSeriesQuery,
  type MonitorSeriesResponse,
  type MonitorStreamQuery,
  type MonitoringOverviewResponse,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { abortWhenSseClientDrops } from '../common/sse-abort'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { MonitoringService } from './monitoring.service'

@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  @Get('overview')
  @RequirePermissions('monitor:read')
  overview(): Promise<MonitoringOverviewResponse> {
    return this.monitoring.overview()
  }

  @Get('profiles')
  @RequirePermissions('monitor:read')
  profiles(
    @Query(new ZodValidationPipe(monitorProfileListQuerySchema)) query: MonitorProfileListQuery,
  ): Promise<MonitorProfileListResponse> {
    return this.monitoring.profiles(query)
  }

  @Get('series')
  @RequirePermissions('monitor:read')
  series(
    @Query(new ZodValidationPipe(monitorSeriesQuerySchema)) query: MonitorSeriesQuery,
  ): Promise<MonitorSeriesResponse> {
    return this.monitoring.series(query)
  }

  @Post('probe')
  @HttpCode(200)
  @RequirePermissions('monitor:operate')
  probe(
    @Body(new ZodValidationPipe(monitorProbeBodySchema)) _body: MonitorProbeBody,
    @CurrentAccount() actor: RequestAccount,
  ): Promise<MonitorProbeResponse> {
    return this.monitoring.probe(actor)
  }

  @Get('alerts')
  @RequirePermissions('monitor:read')
  alerts(
    @Query(new ZodValidationPipe(monitorAlertListQuerySchema)) query: MonitorAlertListQuery,
  ) {
    return this.monitoring.alerts(query)
  }

  @Get('alert-rules')
  @RequirePermissions('monitor:read')
  alertRules() {
    return this.monitoring.alertRules()
  }

  @Post('alert-rules')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  updateAlertRules(
    @Body(new ZodValidationPipe(monitorAlertRulesUpdateBodySchema)) body: MonitorAlertRulesUpdateBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.monitoring.updateAlertRules(body, actor)
  }

  @Post('alert-channels')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  upsertAlertChannel(
    @Body(new ZodValidationPipe(monitorAlertChannelBodySchema)) body: MonitorAlertChannelBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.monitoring.upsertAlertChannel(body, actor)
  }

  @Post('alerts/:alertId/silence')
  @HttpCode(200)
  @RequirePermissions('monitor:operate')
  silence(
    @Param('alertId') alertId: string,
    @Body(new ZodValidationPipe(monitorAlertSilenceBodySchema)) body: MonitorAlertSilenceBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.monitoring.silence(alertId, body, actor)
  }

  @Get('stream')
  @RequirePermissions('monitor:read')
  stream(
    @Query(new ZodValidationPipe(monitorStreamQuerySchema)) query: MonitorStreamQuery,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.monitoring.stream({
      intervalMs: query.intervalMs,
      lastEventId: headerValue(req.headers['last-event-id']),
      authorization: headerValue(req.headers.authorization),
      account: actor,
      response: res,
      signal: abortWhenSseClientDrops(req, res),
    })
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
