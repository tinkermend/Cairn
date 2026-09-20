import { Module } from '@nestjs/common'
import { ObjectsModule } from '../objects/objects.module'
import { PlatformConfigModule } from '../platform-config/platform-config.module'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { OpenExecutionController, ServicesController } from './services.controller'
import { ServicesService } from './services.service'
@Module({
  imports: [ObjectsModule, PlatformConfigModule],
  controllers: [ServicesController, OpenExecutionController],
  providers: [
    ServicesService,
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
  ],
  exports: [ServicesService],
})
export class ServicesModule {}
