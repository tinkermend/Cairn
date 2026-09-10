import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common'
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

  @Patch('roles/:id')
  @RequirePermissions('role:write')
  updateRole(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleBodySchema)) body: UpdateRoleBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.updateRole(id, body, actor)
  }

  @Put('roles/:id/permissions')
  @RequirePermissions('role:write')
  replacePermissions(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(replaceRolePermissionsBodySchema)) body: ReplaceRolePermissionsBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.rbac.replaceRolePermissions(id, body, actor)
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermissions('role:delete')
  deleteRole(@Param('id') id: string, @CurrentAccount() actor: RequestAccount) {
    return this.rbac.deleteRole(id, actor)
  }
}
