import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { authorizeTargetRequest, type DbHandle } from '@cairn/db'
import { entityIdSchema } from '@cairn/shared'
import type { Request } from 'express'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { REQUIRE_PERMISSIONS } from './require-permission.decorator'

@Injectable()
export class TargetScopeGuard implements CanActivate {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle, private readonly reflector: Reflector) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>()
    if (!req.account) return true
    const permissions = this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSIONS, [context.getHandler(), context.getClass()]) ?? []
    const id = (value: unknown) => entityIdSchema.safeParse(value).success ? value as string : undefined
    try {
      await authorizeTargetRequest(this.db, req.account.id, {
        targetId: id(req.params.targetId) ?? id(req.query.targetId) ?? id(req.body?.targetId),
        sessionId: id(req.params.sessionId), operationId: id(req.params.operationId),
        runId: id(req.params.runId), scenarioId: id(req.params.scenarioId) ?? id(req.body?.scenarioId), scheduleId: id(req.params.scheduleId),
        evidenceId: id(req.params.evidenceId) ?? id(req.query.evidenceId),
        moduleId: id(req.params.moduleId),
        suiteId: id(req.params.suiteId) ?? id(req.body?.suiteId) ?? id(req.query.suiteId),
        suiteRunId: id(req.params.suiteRunId) ?? id(req.body?.suiteRunId) ?? id(req.query.suiteRunId),
        reportId: id(req.params.reportId) ?? id(req.query.reportId),
        artifactId: id(req.params.artifactId),
        permissions,
      })
    } catch (error) { rethrowDomain(error) }
    return true
  }
}
