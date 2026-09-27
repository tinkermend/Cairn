import { Inject, Injectable } from '@nestjs/common'
import {
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

  getOverview(targetId: string) {
    return getReliabilityOverview(this.database, targetId).catch(rethrowDomain)
  }

  listIncidents(query: ReliabilityIncidentListQuery, actorId?: string) {
    return listIncidents(this.database, query, actorId).catch(rethrowDomain)
  }

  getIncidentDetail(incidentId: string) {
    return getIncidentDetail(this.database, incidentId).catch(rethrowDomain)
  }

  requestEvaluation(targetId: string, _body?: TriggerEvaluationBody) {
    return requestReliabilityEvaluation(this.database, targetId).catch(rethrowDomain)
  }

  mergeIncidents(incidentId: string, body: MergeIncidentBody) {
    return mergeIncidents(this.database, {
      sourceIncidentIds: [incidentId],
      targetIncidentId: body.targetIncidentId,
    }).catch(rethrowDomain)
  }

  splitIncidents(incidentId: string, body: SplitIncidentBody) {
    return splitIncidents(this.database, {
      incidentId,
      memberRefs: body.memberIds,
      newTitle: body.newTitle,
    }).catch(rethrowDomain)
  }

  dismissIncident(incidentId: string, body: DismissIncidentBody) {
    return dismissIncident(this.database, {
      incidentId,
      reason: body.reason,
    }).catch(rethrowDomain)
  }

  silenceIncident(incidentId: string, body: SilenceIncidentBody) {
    return silenceIncident(this.database, {
      incidentId,
      durationHours: body.durationHours,
      reason: body.reason,
    }).catch(rethrowDomain)
  }

  resolveIncident(incidentId: string, body: ResolveIncidentBody) {
    return resolveIncident(this.database, {
      incidentId,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
    }).catch(rethrowDomain)
  }

  listAssets(query: AssetReliabilityQuery) {
    return listAssetReliabilityItems(this.database, query).catch(rethrowDomain)
  }

  listIncidentSignals(incidentId: string, query?: IncidentSignalsQuery) {
    return listIncidentSignals(this.database, incidentId, query).catch(rethrowDomain)
  }

  getIncidentImpact(incidentId: string) {
    return getIncidentImpactSnapshot(this.database, incidentId).catch(rethrowDomain)
  }

  batchUpgrade(
    incidentId: string,
    body: BatchUpgradeBody,
    actor: { id: string; displayName?: string },
  ) {
    return executeMaintenanceBatchUpgrade(this.database, {
      incidentId,
      moduleId: body.moduleId,
      toVersionId: body.toVersionId,
      scenarioIds: body.scenarioIds,
      idempotencyKey: body.idempotencyKey,
      actor: { id: actor.id, kind: 'console' },
    }).catch(rethrowDomain)
  }

  getUpgradeJob(jobId: string) {
    return getMaintenanceUpgradeJob(this.database, jobId).catch(rethrowDomain)
  }
}

