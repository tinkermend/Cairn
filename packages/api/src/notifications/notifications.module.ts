import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { config } from '../config/env'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { NotificationsController } from './notifications.controller'
import { NotificationsService } from './notifications.service'
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
  ],
})
export class NotificationsModule {}
