import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { OutboundController } from './outbound.controller'
import { OutboundService } from './outbound.service'

@Module({
  imports: [AuthModule],
  controllers: [OutboundController],
  providers: [
    OutboundService,
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
  ],
})
export class OutboundModule {}
