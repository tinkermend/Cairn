import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common'
import {
  createRoleBodySchema,
  replaceRolePermissionsBodySchema,
  updateRoleBodySchema,
  type CreateRoleBody,
  type ReplaceRolePermissionsBody,
  type UpdateRoleBody,
} from '@cairn/shared'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentAccount } from './current-account.decorator'
import { RequirePermissions } from './require-permission.decorator'
import { RbacService } from './rbac.service'
import type { RequestAccount } from '../common/request-account'

@Controller('rbac')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('permissions')
  @RequirePermissions('role:read')
  listPermissions() {
    return this.rbac.listPermissions()
  }

  @Get('roles')
  @RequirePermissions('role:read')
  listRoles() {
    return this.rbac.listRoles()
  }

  @Post('roles')
  @RequirePermissions('role:write')
  createRole(
    @Body(new ZodValidationPipe(createRoleBodySchema)) body: CreateRoleBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.createRole(body, actor)
  }

  @Get('roles/:id')
  @RequirePermissions('role:read')
  getRole(@Param('id') id: string) {
    return this.rbac.getRole(id)
  }

  @Post('roles/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('role:write')
  updateRole(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleBodySchema)) body: UpdateRoleBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.updateRole(id, body, actor)
  }

  @Post('roles/:id/permissions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('role:write')
  replacePermissions(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replaceRolePermissionsBodySchema)) body: ReplaceRolePermissionsBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.replaceRolePermissions(id, body, actor)
  }

  @Post('roles/:id/delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('role:delete')
  deleteRole(@Param('id') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.rbac.deleteRole(id, actor)
  }
}
