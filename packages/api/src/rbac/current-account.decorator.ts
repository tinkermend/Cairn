import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { RequestAccount } from '../common/request-account'

export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestAccount => {
    const req = ctx.switchToHttp().getRequest<Request>()
    if (!req.account) {
      throw new UnauthorizedException('未认证')
    }
    return req.account
  },
)
