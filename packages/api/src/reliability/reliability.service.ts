import { Inject, Injectable } from '@nestjs/common'
import {
  authorizeTargetRequest,
  dismissIncident,
  executeMaintenanceBatchUpgrade,
  getIncidentDetail,
  getIncidentImpactSnapshot,
  getMaintenanceUpgradeJob,
  getReliabilityOverview,
  listAssetReliabilityItems,
  listIncidents,
  listIncidentSignals,
  mergeIncidents,
  requestReliabilityEvaluation,
  resolveIncident,
  silenceIncident,
  splitIncidents,
  type DbHandle,
} from '@cairn/db'
import type {
  AssetReliabilityQuery,
  BatchUpgradeBody,
  DismissIncidentBody,
  IncidentSignalsQuery,
  MergeIncidentBody,
  ReliabilityIncidentListQuery,
  ResolveIncidentBody,
  SilenceIncidentBody,
  SplitIncidentBody,
  TriggerEvaluationBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class ReliabilityService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  private authorizeTriage(actorId: string, incidentId: string, targetIncidentId?: string) {
    return authorizeTargetRequest(this.database, actorId, {
      incidentId,
      targetIncidentId,
      permissions: ['reliability:triage'],
    })
  }

  getOverview(targetId: string, actorId: string) {
    return getReliabilityOverview(this.database, targetId, actorId).catch(rethrowDomain)
  }

  listIncidents(query: ReliabilityIncidentListQuery, actorId?: string) {
    return listIncidents(this.database, query, actorId).catch(rethrowDomain)
  }

  getIncidentDetail(incidentId: string, actorId: string) {
    return getIncidentDetail(this.database, incidentId, actorId).catch(rethrowDomain)
  }

  requestEvaluation(targetId: string, _body: TriggerEvaluationBody, actorId: string) {
    return requestReliabilityEvaluation(this.database, targetId, actorId).catch(rethrowDomain)
  }

  mergeIncidents(incidentId: string, body: MergeIncidentBody, actorId: string) {
    return this.authorizeTriage(actorId, incidentId, body.targetIncidentId).then(() => mergeIncidents(this.database, {
      sourceIncidentIds: [incidentId],
      targetIncidentId: body.targetIncidentId,
      actorId,
    })).catch(rethrowDomain)
  }

  splitIncidents(incidentId: string, body: SplitIncidentBody, actorId: string) {
    return this.authorizeTriage(actorId, incidentId).then(() => splitIncidents(this.database, {
      incidentId,
      memberRefs: body.memberIds,
      newTitle: body.newTitle,
      actorId,
    })).catch(rethrowDomain)
  }

  dismissIncident(incidentId: string, body: DismissIncidentBody, actorId: string) {
    return this.authorizeTriage(actorId, incidentId).then(() => dismissIncident(this.database, {
      incidentId,
      reason: body.reason,
      actorId,
    })).catch(rethrowDomain)
  }

  silenceIncident(incidentId: string, body: SilenceIncidentBody, actorId: string) {
    return this.authorizeTriage(actorId, incidentId).then(() => silenceIncident(this.database, {
      incidentId,
      durationHours: body.durationHours,
      reason: body.reason,
      actorId,
    })).catch(rethrowDomain)
  }

  resolveIncident(incidentId: string, body: ResolveIncidentBody, actorId: string) {
    return this.authorizeTriage(actorId, incidentId).then(() => resolveIncident(this.database, {
      incidentId,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
      actorId,
    })).catch(rethrowDomain)
  }

  listAssets(query: AssetReliabilityQuery, actorId: string) {
    return listAssetReliabilityItems(this.database, query, actorId).catch(rethrowDomain)
  }

  listIncidentSignals(incidentId: string, query: IncidentSignalsQuery, actorId: string) {
    return listIncidentSignals(this.database, incidentId, query, actorId).catch(rethrowDomain)
  }

  getIncidentImpact(incidentId: string, actorId: string) {
    return getIncidentImpactSnapshot(this.database, incidentId, actorId).catch(rethrowDomain)
  }

  batchUpgrade(
    incidentId: string,
    body: BatchUpgradeBody,
    actor: { id: string; displayName?: string },
  ) {
    const authorize = async () => {
      await this.authorizeTriage(actor.id, incidentId)
      await authorizeTargetRequest(this.database, actor.id, { moduleId: body.moduleId, permissions: ['reliability:triage'] })
      for (const scenarioId of body.scenarioIds) {
        await authorizeTargetRequest(this.database, actor.id, { scenarioId, permissions: ['reliability:triage'] })
      }
    }
    return authorize().then(() => executeMaintenanceBatchUpgrade(this.database, {
      incidentId,
      moduleId: body.moduleId,
      toVersionId: body.toVersionId,
      scenarioIds: body.scenarioIds,
      idempotencyKey: body.idempotencyKey,
      actor: { id: actor.id, kind: 'console' },
      actorId: actor.id,
    })).catch(rethrowDomain)
  }

  getUpgradeJob(jobId: string, actorId: string) {
    return getMaintenanceUpgradeJob(this.database, jobId, actorId).catch(rethrowDomain)
  }
}
