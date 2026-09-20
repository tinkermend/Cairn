import { Module } from '@nestjs/common'
import { RecordingBindingsController, RecordingsController } from './recordings.controller'
import { RecordingsService } from './recordings.service'
import { RecordingArtifactsService } from './artifacts.service'
import { ObjectsModule } from '../objects/objects.module'

@Module({
  imports: [ObjectsModule],
  controllers: [RecordingsController, RecordingBindingsController],
  providers: [RecordingsService, RecordingArtifactsService],
  exports: [RecordingsService],
})
export class RecordingsModule {}
