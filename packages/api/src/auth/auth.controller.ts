import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { loginBodySchema, type LoginBody } from '@cairn/shared'
import { Public } from '../common/public.decorator'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { AuthService } from './auth.service'

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(loginBodySchema)) body: LoginBody) {
    return this.auth.login(body.email, body.password)
  }
}
