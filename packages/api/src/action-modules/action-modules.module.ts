import { Module } from '@nestjs/common'
import { ActionModulesController } from './action-modules.controller.js'
import { ActionModulesService } from './action-modules.service.js'

@Module({
  controllers: [ActionModulesController],
  providers: [ActionModulesService],
  exports: [ActionModulesService],
})
export class ActionModulesModule {}
