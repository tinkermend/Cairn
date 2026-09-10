import { randomUUID } from 'node:crypto'
import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { LoggerModule } from 'nestjs-pino'
import type { Request } from 'express'
import { REQUEST_ID_HEADER } from '@cairn/shared'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { AuthGuard } from './common/auth.guard'
import { NotFoundModule } from './common/not-found.module'
import { RequestIdMiddleware } from './common/request-id.middleware'
import { DbModule } from './db/db.module'
import { AuthModule } from './auth/auth.module'
import { HealthModule } from './health/health.module'
import { PermissionsGuard } from './rbac/permissions.guard'
import { RbacModule } from './rbac/rbac.module'

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        base: { service: 'cairn-api' },
        // pino-http 在 Nest 中间件之前执行，所以 requestId 在这里确定，
        // 之后由 RequestIdMiddleware 镜像到响应头。三者共用同一个值。
        genReqId: (req) => {
          const incoming = req.headers[REQUEST_ID_HEADER]
          const id = (Array.isArray(incoming) ? incoming[0] : incoming) || randomUUID()
          ;(req as Request).requestId = id
          return id
        },
        customProps: (req) => ({ runId: (req as Request).requestId }),
        autoLogging: { ignore: (req) => req.url === '/health' },
      },
    }),
    DbModule,
    HealthModule,
    AuthModule,
    RbacModule,
    // 必须放在最后：兜底路由要在所有业务路由之后注册
    NotFoundModule,
  ],
  providers: [
    // 全局默认拒绝，白名单靠 @Public() 显式放行
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 必须最先执行：后续的日志、Guard、过滤器都依赖 req.requestId
    consumer.apply(RequestIdMiddleware).forRoutes('*')
  }
}
