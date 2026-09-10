import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common'
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

  @Patch()
  updateMe(
    @CurrentAccount() account: RequestAccount,
    @Body(new ZodValidationPipe(updateMeBodySchema)) body: UpdateMeBody,
  ) {
    return this.rbac.updateMe(account.id, body)
  }

  @Post('password')
  @HttpCode(204)
  changePassword(
    @CurrentAccount() account: RequestAccount,
    @Body(new ZodValidationPipe(changePasswordBodySchema)) body: ChangePasswordBody,
  ) {
    return this.rbac.changePassword(account.id, body)
  }
}
