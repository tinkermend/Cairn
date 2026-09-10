import { Module } from '@nestjs/common'
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt'
import { loadApiEnv } from '../config/env'
import { RbacModule } from '../rbac/rbac.module'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { BootstrapService } from './bootstrap.service'

@Module({
  imports: [
    RbacModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const env = loadApiEnv()
        return {
          secret: env.CAIRN_JWT_SECRET,
          signOptions: { expiresIn: env.CAIRN_JWT_EXPIRES_IN as JwtSignOptions['expiresIn'] },
        }
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, BootstrapService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
