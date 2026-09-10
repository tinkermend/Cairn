import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common'
import {
  assignAccountRolesBodySchema,
  createAccountBodySchema,
  setPasswordBodySchema,
  updateAccountBodySchema,
  type AssignAccountRolesBody,
  type CreateAccountBody,
  type SetPasswordBody,
  type UpdateAccountBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from './current-account.decorator'
import { RequirePermissions } from './require-permission.decorator'
import { RbacService } from './rbac.service'
import type { RequestAccount } from '../common/request-account'

@Controller('console/accounts')
export class AccountsController {
  constructor(private readonly rbac: RbacService) {}

  @Get()
  @RequirePermissions('account:read')
  listAccounts() {
    return this.rbac.listAccounts()
  }

  @Post()
  @RequirePermissions('account:write')
  createAccount(
    @Body(new ZodValidationPipe(createAccountBodySchema)) body: CreateAccountBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.createAccount(body, actor)
  }

  @Get(':id')
  @RequirePermissions('account:read')
  getAccount(@Param('id') id: string) {
    return this.rbac.getAccount(id)
  }

  @Patch(':id')
  @RequirePermissions('account:write')
  updateAccount(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAccountBodySchema)) body: UpdateAccountBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.updateAccount(id, body, actor)
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('account:delete')
  deleteAccount(@Param('id') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.rbac.deleteAccount(id, actor)
  }

  @Put(':id/roles')
  @RequirePermissions('account:write')
  assignRoles(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignAccountRolesBodySchema)) body: AssignAccountRolesBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.assignAccountRoles(id, body, actor)
  }

  @Put(':id/password')
  @HttpCode(204)
  @RequirePermissions('account:write')
  setPassword(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(setPasswordBodySchema)) body: SetPasswordBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.setPassword(id, body, actor)
  }
}
