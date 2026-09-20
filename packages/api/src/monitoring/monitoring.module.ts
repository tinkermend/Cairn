import { Module } from '@nestjs/common'
import { config } from '../config/env'
import { AuthModule } from '../auth/auth.module'
import { HealthModule } from '../health/health.module'
import { ObjectsModule } from '../objects/objects.module'
import { credentialKeyFromEnv, LocalSecretProvider } from '../secrets/local-secret-provider'
import { ApiInstanceHeartbeatService } from './api-instance.service'
import { MonitoringController } from './monitoring.controller'
import { MonitoringService } from './monitoring.service'

@Module({
  imports: [AuthModule, HealthModule, ObjectsModule],
  controllers: [MonitoringController],
  providers: [
    {
      provide: LocalSecretProvider,
      useFactory: () => new LocalSecretProvider(credentialKeyFromEnv(config.CAIRN_CREDENTIAL_KEY)),
    },
    MonitoringService,
    ApiInstanceHeartbeatService,
  ],
})
export class MonitoringModule {}
