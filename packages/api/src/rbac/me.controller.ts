import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import {
  changePasswordBodySchema,
  updateMeBodySchema,
  type ChangePasswordBody,
  type UpdateMeBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from './current-account.decorator'
import { RbacService } from './rbac.service'
import type { RequestAccount } from '../common/request-account'

@Controller('me')
export class MeController {
  constructor(private readonly rbac: RbacService) {}

  /** 当前主体。只需通过认证，不额外要权限。 */
  @Get()
  me(@CurrentAccount() account: RequestAccount) {
    return this.rbac.getMe(account.id)
  }

  @Get('events')
  async events(@CurrentAccount() account: RequestAccount, @Res() response: Response) {
    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-store')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders()
    let previous = ''
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = Date.now() + 60_000
    const stop = () => { stopped = true; clearTimeout(timer); if (!response.writableEnded) response.end() }
    response.once('close', stop)
    const tick = async () => {
      if (stopped) return
      try {
        const value = await this.rbac.getMe(account.id)
        if (value.account.status !== 'active' || Date.now() >= deadline) { stop(); return }
        const next = JSON.stringify(value)
        if (next !== previous) { response.write(`event: authorization\ndata: ${next}\n\n`); previous = next }
        else response.write(': keepalive\n\n')
      } catch { stop(); return }
      if (!stopped) { timer = setTimeout(() => void tick(), 3000); timer.unref() }
    }
    await tick()
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  updateMe(
    @CurrentAccount() account: RequestAccount,
    @Body(new ZodValidationPipe(updateMeBodySchema)) body: UpdateMeBody,
  ) {
    return this.rbac.updateMe(account.id, body)
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(
    @CurrentAccount() account: RequestAccount,
    @Body(new ZodValidationPipe(changePasswordBodySchema)) body: ChangePasswordBody,
  ) {
    return this.rbac.changePassword(account.id, body)
  }
}
