import { Module } from '@nestjs/common'
import { AuthoringController } from './authoring.controller'
import { AuthoringService } from './authoring.service'

@Module({
  controllers: [AuthoringController],
  providers: [AuthoringService],
})
export class AuthoringModule {}
