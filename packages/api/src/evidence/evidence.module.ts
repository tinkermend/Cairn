import { Module } from '@nestjs/common'
import { EvidenceController, EvidenceRetentionController } from './evidence.controller'
import { EvidenceService } from './evidence.service'

@Module({
  controllers: [EvidenceController, EvidenceRetentionController],
  providers: [EvidenceService],
})
export class EvidenceModule {}
