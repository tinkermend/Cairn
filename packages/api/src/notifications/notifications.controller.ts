import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import {
  entityIdSchema,
  notificationActionSchema,
  notificationChannelStateSchema,
  notificationChannelWriteSchema,
  notificationListQuerySchema,
  notificationPolicyWriteSchema,
  notificationSettingsWriteSchema,
  notificationSmtpWriteSchema,
  type NotificationChannelWrite,
  type NotificationSmtpWrite,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { abortWhenSseClientDrops } from '../common/sse-abort'
import type { RequestAccount } from '../common/request-account'
import { CurrentAccount } from '../rbac/current-account.decorator'
import { RequirePermissions } from '../rbac/require-permission.decorator'
import { NotificationsService } from './notifications.service'

const uuid = new ZodValidationPipe(entityIdSchema)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get('channels')
  channels(
    @CurrentAccount() a: RequestAccount,
    @Query(new ZodValidationPipe(z.object({ targetId: entityIdSchema.optional() })))
    q: { targetId?: string },
  ) {
    return this.service.channels(a.id, q.targetId)
  }
  @Post('channels')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  saveChannel(
    @CurrentAccount() a: RequestAccount,
    @Body(new ZodValidationPipe(notificationChannelWriteSchema)) b: NotificationChannelWrite,
  ) {
    return this.service.saveChannel(a.id, b)
  }
  @Post('smtp')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  saveSmtp(
    @CurrentAccount() a: RequestAccount,
    @Body(new ZodValidationPipe(notificationSmtpWriteSchema)) b: NotificationSmtpWrite,
  ) {
    return this.service.saveSmtp(a.id, b)
  }
  @Post('settings')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  settings(
    @CurrentAccount() a: RequestAccount,
    @Body(new ZodValidationPipe(notificationSettingsWriteSchema))
    b: z.infer<typeof notificationSettingsWriteSchema>,
  ) {
    return this.service.settings(a.id, b)
  }
  @Post('channels/:channelId/state')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  state(
    @CurrentAccount() a: RequestAccount,
    @Param('channelId', uuid) id: string,
    @Body(new ZodValidationPipe(notificationChannelStateSchema))
    b: z.infer<typeof notificationChannelStateSchema>,
  ) {
    return this.service.state(a.id, id, b)
  }
  @Post('smtp/state')
  @HttpCode(200)
  @RequirePermissions('platform-config:write')
  smtpState(
    @CurrentAccount() a: RequestAccount,
    @Body(new ZodValidationPipe(notificationChannelStateSchema)) b: unknown,
  ) {
    return this.service.smtpState(a.id, b as Parameters<NotificationsService['smtpState']>[1])
  }
  @Post('channels/:channelId/test')
  @HttpCode(202)
  @RequirePermissions('platform-config:write')
  test(
    @CurrentAccount() a: RequestAccount,
    @Param('channelId', uuid) id: string,
    @Body(new ZodValidationPipe(notificationActionSchema)) b: unknown,
  ) {
    return this.service.test(a.id, id, b)
  }
  @Get('scenarios/:scenarioId/policy')
  @RequirePermissions('workflow:read')
  policy(@CurrentAccount() a: RequestAccount, @Param('scenarioId', uuid) id: string) {
    return this.service.policy(a.id, id)
  }
  @Post('scenarios/:scenarioId/policy')
  @HttpCode(200)
  @RequirePermissions('workflow:write', 'run:read')
  savePolicy(
    @CurrentAccount() a: RequestAccount,
    @Param('scenarioId', uuid) id: string,
    @Body(new ZodValidationPipe(notificationPolicyWriteSchema)) b: unknown,
  ) {
    return this.service.savePolicy(a.id, id, b)
  }
  @Get('events')
  @RequirePermissions('notification:read')
  list(
    @CurrentAccount() a: RequestAccount,
    @Query(new ZodValidationPipe(notificationListQuerySchema)) q: unknown,
  ) {
    return this.service.list(a.id, q)
  }
  @Get('stream')
  @RequirePermissions('notification:read')
  stream(
    @CurrentAccount() a: RequestAccount,
    @Query(new ZodValidationPipe(notificationListQuerySchema)) q: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.service.stream({
      actorId: a.id,
      query: q,
      authorization: req.headers.authorization,
      response: res,
      signal: abortWhenSseClientDrops(req, res),
    })
  }
  @Get('events/:eventId')
  @RequirePermissions('notification:read')
  detail(@CurrentAccount() a: RequestAccount, @Param('eventId', uuid) id: string) {
    return this.service.detail(a.id, id)
  }
  @Post('deliveries/:deliveryId/retry')
  @HttpCode(200)
  @RequirePermissions('notification:operate')
  retry(
    @CurrentAccount() a: RequestAccount,
    @Param('deliveryId', uuid) id: string,
    @Body(new ZodValidationPipe(notificationActionSchema)) b: unknown,
  ) {
    return this.service.operate(a.id, id, 'retry', b)
  }
  @Post('deliveries/:deliveryId/close')
  @HttpCode(200)
  @RequirePermissions('notification:operate')
  close(
    @CurrentAccount() a: RequestAccount,
    @Param('deliveryId', uuid) id: string,
    @Body(new ZodValidationPipe(notificationActionSchema)) b: unknown,
  ) {
    return this.service.operate(a.id, id, 'close', b)
  }
}
