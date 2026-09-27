import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { authorizeTargetRequest, type DbHandle } from '@cairn/db'
import { entityIdSchema, quoteTargetSystemId } from '@cairn/shared'
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
    const pc = req.body?.pageContext
    const quote = pc?.quote
    const quoteTargetId = quote ? id(quoteTargetSystemId(quote)) : undefined
    const quoteRunId = quote?.objectRef?.kind === 'run' ? id(quote.objectRef.id) : undefined
    const quoteScenarioId = quote?.objectRef?.kind === 'scenario' ? id(quote.objectRef.id) : undefined

    try {
      await authorizeTargetRequest(this.db, req.account.id, {
        targetId: id(req.params.targetId) ?? id(req.query.targetId) ?? id(req.body?.targetId) ?? id(pc?.targetId) ?? quoteTargetId,
        sessionId: id(req.params.sessionId), operationId: id(req.params.operationId),
        runId: id(req.params.runId) ?? id(pc?.runId) ?? quoteRunId,
        scenarioId: id(req.params.scenarioId) ?? id(req.body?.scenarioId) ?? id(pc?.scenarioId) ?? quoteScenarioId,
        scheduleId: id(req.params.scheduleId),
        evidenceId: id(req.params.evidenceId) ?? id(req.query.evidenceId),
        moduleId: id(req.params.moduleId),
        suiteId: id(req.params.suiteId) ?? id(req.body?.suiteId) ?? id(req.query.suiteId),
        suiteRunId: id(req.params.suiteRunId) ?? id(req.body?.suiteRunId) ?? id(req.query.suiteRunId),
        reportId: id(req.params.reportId) ?? id(req.query.reportId),
        artifactId: id(req.params.artifactId),
        incidentId: id(req.params.incidentId),
        targetIncidentId: id(req.body?.targetIncidentId),
        permissions,
      })
    } catch (error) { rethrowDomain(error) }
    return true
  }
}
