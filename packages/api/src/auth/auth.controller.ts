import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common'
import { loginBodySchema, type LoginBody } from '@cairn/shared'
import { Public } from '../common/public.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { AuthService } from './auth.service'
import { clientContextFromRequest } from './client-context'
import { config } from '../config/env'
import type { Request } from 'express'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Req() req: Request, @Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody) {
    return this.auth.login(
      body.email,
      body.password,
      clientContextFromRequest(req, config.CAIRN_TRUST_PROXY_HOPS),
    )
  }
}
