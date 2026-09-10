import { Module } from '@nestjs/common'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { TargetsController } from './targets.controller'
import { TargetsService } from './targets.service'

@Module({
  controllers: [TargetsController],
  providers: [
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
    TargetsService,
  ],
})
export class TargetsModule {}
