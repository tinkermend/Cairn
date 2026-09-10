import { Module } from '@nestjs/common'
import { AccountsController } from './accounts.controller'
import { AuditController } from './audit.controller'
import { MeController } from './me.controller'
import { RbacController } from './rbac.controller'
import { RbacService } from './rbac.service'

@Module({
  controllers: [RbacController, AccountsController, AuditController, MeController],
  providers: [RbacService],
  exports: [RbacService],
})
export class RbacModule {}
