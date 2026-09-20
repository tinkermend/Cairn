import { Module } from '@nestjs/common'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { CredentialsController } from './credentials.controller'
import { CredentialsService } from './credentials.service'

@Module({
  controllers: [CredentialsController],
  providers: [
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
    CredentialsService,
  ],
})
export class CredentialsModule {}
