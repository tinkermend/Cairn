import { Module } from '@nestjs/common'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { PlatformConfigController } from './platform-config.controller'
import { PlatformConfigService } from './platform-config.service'

@Module({
  controllers: [PlatformConfigController],
  providers: [
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
    PlatformConfigService,
  ],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
