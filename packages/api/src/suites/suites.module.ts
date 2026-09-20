import { Module } from '@nestjs/common'
import { SuitesController } from './suites.controller'
import { SuitesService } from './suites.service'

@Module({
  controllers: [SuitesController],
  providers: [SuitesService],
})
export class SuitesModule {}
