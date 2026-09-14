import { Controller, Get, Query } from '@nestjs/common'
import {
  loginAuditQuerySchema,
  operationAuditQuerySchema,
  type LoginAuditQuery,
  type OperationAuditQuery,
} from '@cairn/shared'
import { RequirePermissions } from './require-permission.decorator'
import { RbacService } from './rbac.service'
import { ZodValidationPipe } from '../common/zod-validation.pipe'

@Controller('console/audit')
export class AuditController {
  constructor(private readonly rbac: RbacService) {}

  @Get('operations')
  @RequirePermissions('audit:read')
  listOperations(@Query(new ZodValidationPipe(operationAuditQuerySchema)) query: OperationAuditQuery) {
    return this.rbac.listAuditEvents(query)
  }

  @Get('logins')
  @RequirePermissions('audit:login')
  listLogins(@Query(new ZodValidationPipe(loginAuditQuerySchema)) query: LoginAuditQuery) {
    return this.rbac.listLoginAuditEvents(query)
  }

  @Get()
  @RequirePermissions('audit:read')
  listAudit(@Query(new ZodValidationPipe(operationAuditQuerySchema)) query: OperationAuditQuery) {
    return this.rbac.listAuditEvents(query)
  }
}
