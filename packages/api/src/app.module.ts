import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { TargetScopeGuard } from "./rbac/target-scope.guard";
import { LoggerModule } from "nestjs-pino";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { AuthGuard } from "./common/auth.guard";
import { buildApiLoggerOptions } from "./common/logger-options";
import { NotFoundModule } from "./common/not-found.module";
import { RequestIdMiddleware } from "./common/request-id.middleware";
import { ServiceRequestLogMiddleware } from "./services/service-request-log.middleware";
import { config } from "./config/env";
import { DbModule } from "./db/db.module";
import { ChangeHintModule } from "./observe/change-hint.module";
import { AuthModule } from "./auth/auth.module";
import { BrowserSessionsModule } from "./browser-sessions/browser-sessions.module";
import { WorkersModule } from "./workers/workers.module";
import { HealthModule } from "./health/health.module";
import { PermissionsGuard } from "./rbac/permissions.guard";
import { RbacModule } from "./rbac/rbac.module";
import { RecordingsModule } from "./recordings/recordings.module";
import { ServicesModule } from "./services/services.module";
import { AuthoringModule } from "./authoring/authoring.module";
import { AssistantModule } from "./assistant/assistant.module";
import { PlatformConfigModule } from "./platform-config/platform-config.module";
import { RunsModule } from "./runs/runs.module";
import { ScenariosModule } from "./scenarios/scenarios.module";
import { ActionModulesModule } from "./action-modules/action-modules.module";
import { TargetsModule } from "./targets/targets.module";
import { MapModule } from "./map/map.module";
import { SchedulesModule } from "./schedules/schedules.module";
import { MonitoringModule } from "./monitoring/monitoring.module";
import { CredentialsModule } from "./credentials/credentials.module";
import { EvidenceModule } from "./evidence/evidence.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { SuitesModule } from "./suites/suites.module";
import { SuiteRunsModule } from "./suite-runs/suite-runs.module";
import { ReportsModule } from "./reports/reports.module";
import { OverviewModule } from "./overview/overview.module";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: buildApiLoggerOptions({
        service: "cairn-api",
        level: config.CAIRN_LOG_LEVEL,
      }),
    }),
    DbModule,
    ChangeHintModule,
    HealthModule,
    AuthModule,
    RbacModule,
    OverviewModule,
    TargetsModule,
    MapModule,
    SchedulesModule,
    ScenariosModule,
    ActionModulesModule,
    AuthoringModule,
    RecordingsModule,
    RunsModule,
    ServicesModule,
    PlatformConfigModule,
    AssistantModule,
    BrowserSessionsModule,
    WorkersModule,
    MonitoringModule,
    CredentialsModule,
    EvidenceModule,
    NotificationsModule,
    SuitesModule,
    SuiteRunsModule,
    ReportsModule,
    // 必须放在最后：兜底路由要在所有业务路由之后注册
    NotFoundModule,
  ],
  providers: [
    // 全局默认拒绝，白名单靠 @Public() 显式放行
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: TargetScopeGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ServiceRequestLogMiddleware,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 必须最先执行：后续的日志、Guard、过滤器都依赖 req.requestId
    consumer
      .apply(RequestIdMiddleware, ServiceRequestLogMiddleware)
      .forRoutes("*");
  }
}
