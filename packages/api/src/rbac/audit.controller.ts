import { Controller, Get } from '@nestjs/common'
import { RequirePermissions } from './require-permission.decorator'
import { RbacService } from './rbac.service'

@Controller('console/audit')
export class AuditController {
  constructor(private readonly rbac: RbacService) {}

  @Get()
  @RequirePermissions('audit:read')
  listAudit() {
    return this.rbac.listAuditEvents()
  }
}
