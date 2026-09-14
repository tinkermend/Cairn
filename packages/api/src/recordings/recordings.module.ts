import { Module } from '@nestjs/common'
import { RecordingBindingsController, RecordingsController } from './recordings.controller'
import { RecordingsService } from './recordings.service'

@Module({
  controllers: [RecordingsController, RecordingBindingsController],
  providers: [RecordingsService],
  exports: [RecordingsService],
})
export class RecordingsModule {}
