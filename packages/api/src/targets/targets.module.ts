import { Module } from '@nestjs/common'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { WorkerInternalClient } from '../runs/worker-internal.client'
import { TargetsController } from './targets.controller'
import { TargetsService } from './targets.service'
import { BusinessSourcesController } from './business-sources.controller'
import { BusinessSourcesService } from './business-sources.service'

@Module({
  controllers: [TargetsController, BusinessSourcesController],
  providers: [
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
    WorkerInternalClient,
    TargetsService,
    BusinessSourcesService,
  ],
  exports: [TargetsService, BusinessSourcesService],
})
export class TargetsModule {}

