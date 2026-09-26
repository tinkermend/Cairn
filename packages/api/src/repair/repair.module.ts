import { Module } from '@nestjs/common'
import { RepairController } from './repair.controller'
import { RepairService } from './repair.service'

import { PlatformConfigModule } from '../platform-config/platform-config.module'

@Module({
  imports: [PlatformConfigModule],
  controllers: [RepairController],
  providers: [RepairService],
  exports: [RepairService],
})
export class RepairModule {}
