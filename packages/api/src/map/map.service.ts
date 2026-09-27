import { knowledgeAccess, visibleTerms } from './knowledge-access'
import { redactKnowledgeQuestion } from '@cairn/map'
import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import {
  applyMapGovernanceCommand,
  getMapAssetDetail,
  getMapFact,
  getMapGovernanceCommand,
  getMapReleasePublication,
  notFound,
  getMapSummary,
  listMapAssets,
  listMapAtlasPages,
  listMapChanges,
  loadMapImpactSource,
  conflict,
  listMapReferences,
  listMapReleases,
  loadMapQueryView,
  resolveMapView,
  loadRunMapClues,
  getMapConsumptionPolicy,
  grantMapConsumptionEligibility,
  updateMapConsumptionPolicy,
  getMapJobPolicy,
  updateMapJobPolicy,
  getTargetStateRuleConfig,
  updateTargetStateRuleQueryParams,
  getMapJob,
  listMapIngestJobs,
  createMapIngestJob,
  listMapMenuEntries,
  createMapMenuEntry,
  updateMapMenuEntry,
  archiveMapMenuEntry,
  reorderMapMenuEntries,
  getTargetKnowledgeContext,
  getMapIngestSurface,
  cancelMapJob,
  previewMapGovernance,
  publishMapRelease,
  removeMapScenarioBinding,
  sealAndPublishMapRelease,
  requestMapProjectionRebuild,
  startMapReferenceScan,
  upsertMapScenarioBinding,
  withdrawMapRelease,
  createTerminology,
  validateKnowledgeSources,
  getTerminology,
  listTerminology,
  matchTerminology,
  retireTerminology,
  updateTerminology,
  type DbHandle,
} from '@cairn/db'
import {
  applyDetailApplicability,
  evaluateCondition,
  gradeMapImpact,
  groupMapDiagnosisClues,
  classifyRoute,
  queryMap,
} from '@cairn/map'
import {
  hasPermission,
  canonicalJson,
  mapImpactListResponseSchema,
  mapFactViewSchema,
  mapQueryRequestSchema,
  mapRebuildResponseSchema,
  mapRunCluesResponseSchema,
  type MapGovernanceCommandBody,
  type MapGovernancePreviewBody,
  type MapImpactQuery,
  type MapListQuery,
  type MapAtlasPagesQuery,
  type MapAtlasPagesResponse,
  type MapMatchQuery,
  type MapPublicationBody,
  type MapScenarioBindingBody,
  type MapSealPublishBody,
  type MapConsumptionEligibilityGrantBody,
  type MapConsumptionPolicyUpdateBody,
  type MapJobPolicyUpdateBody,
  type TargetStateRuleQueryParamsUpdateBody,
  type MapIngestCreateBody,
  type MapIngestJobListQuery,
  type TargetKnowledgeContextQuery,
  type MapMenuEntryCreateBody,
  type MapMenuEntryUpdateBody,
  type MapMenuEntryArchiveBody,
  type MapMenuEntryReorderBody,
  type CreateTerminologyBody,
  type RetireTerminologyBody,
  type TerminologyListQuery,
  type UpdateTerminologyBody,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import type { RequestAccount } from '../common/request-account'

@Injectable()
export class MapService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  summary(targetId: string, query: MapListQuery) {
    return getMapSummary(this.database, targetId, query, evaluateCondition).catch(rethrowDomain)
  }

  listAtlasPages(targetId: string, query: MapAtlasPagesQuery): Promise<MapAtlasPagesResponse> {
    return listMapAtlasPages(this.database, targetId, query).catch(rethrowDomain)
  }

  listPages(targetId: string, query: MapListQuery) {
    return listMapAssets(this.database, targetId, 'pages', query, evaluateCondition).catch(rethrowDomain)
  }

  listObjects(targetId: string, query: MapListQuery) {
    return listMapAssets(this.database, targetId, 'objects', query, evaluateCondition).catch(rethrowDomain)
  }

  async getObject(targetId: string, objectId: string, query: MapListQuery) {
    try {
      const detail = await getMapAssetDetail(this.database, targetId, objectId, query)
      return applyDetailApplicability(detail, query.conditionSnapshot)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async match(targetId: string, query: MapMatchQuery) {
    try {
      let projectionId = query.projectionId
      let releaseId = query.releaseId
      let manifestDigest = query.manifestDigest
      if (!projectionId && !releaseId) {
        const resolved = await resolveMapView(this.database, targetId, {})
        if (!resolved.projectionId || resolved.status === 'missing') {
          return {
            matchResult: 'MISS' as const,
            candidates: [],
            usedRefs: [],
            viewRef: { kind: 'missing' as const },
          }
        }
        projectionId = resolved.projectionId
      }
      if (releaseId && !manifestDigest) {
        const publication = await getMapReleasePublication(this.database, targetId, releaseId)
        manifestDigest = publication.release.manifestDigest
      }
      const request = mapQueryRequestSchema.parse({
        targetId,
        view: releaseId
          ? { kind: 'release', releaseId, manifestDigest }
          : { kind: 'projection', projectionId },
        intent: query.intent,
        assetRef:
          query.pageId || query.objectId
            ? { targetId, pageId: query.pageId, objectId: query.objectId, implementationKey: query.implementationKey }
            : undefined,
        condition: query.conditionSnapshot,
        clues: query.clues,
        limit: query.limit,
      })
      const view = await loadMapQueryView(this.database, request, {
        routeTemplate: query.clues?.url ? classifyRoute({ url: query.clues.url }).routeTemplate : undefined,
      })
      return queryMap(view, request)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async getFact(targetId: string, factType: 'observation' | 'verification', factId: string, account: RequestAccount) {
    try {
      const fact = await getMapFact(this.database, { targetId, factType, factId })
      const observations = fact.type === 'observation'
        ? [fact.observation]
        : await Promise.all(fact.verification.observationIds.map(async (id) => {
            const source = await getMapFact(this.database, { targetId, factType: 'observation', factId: id })
            if (source.type !== 'observation') throw notFound('MAP_NOT_FOUND', '地图事实不存在')
            return source.observation
          }))
      if (fact.type === 'verification' && 'runId' in fact.verification.verificationSource && !hasPermission(account.permissions, 'run:read')) {
        throw notFound('MAP_NOT_FOUND', '地图事实不存在')
      }
      for (const observation of observations) {
        const required = observation.sourceType === 'recorder' ? 'workflow:read' : 'run:read'
        if (!hasPermission(account.permissions, required)) throw notFound('MAP_NOT_FOUND', '地图事实不存在')
      }
      const sourceType = fact.type === 'observation' ? fact.observation.sourceType : undefined
      const payload = fact.type === 'observation' ? fact.observation : fact.verification
      // ObjectStore keys are internal; authorized readers use evidence/object ids.
      const publicPayload = { ...payload, evidenceRefs: payload.evidenceRefs.map(ref => {
        if (ref.kind !== 'object') return ref
        const { objectKey: _key, ...publicRef } = ref
        return publicRef
      }) }
      return mapFactViewSchema.parse({
        factType: fact.type,
        factId,
        ingestSeq: fact.ingestSeq,
        contentAvailability: fact.contentAvailability,
        sourceAvailability: fact.sourceAvailability,
        sourceType,
        payload:
          fact.contentAvailability === 'available'
            ? publicPayload
            : undefined,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  listChanges(targetId: string, query: MapListQuery) {
    return listMapChanges(this.database, targetId, query, evaluateCondition).catch(rethrowDomain)
  }

  async getCommand(targetId: string, commandId: string, account: RequestAccount) {
    const result = await getMapGovernanceCommand(this.database, targetId, commandId).catch(rethrowDomain)
    const payload = result.payload as { evidenceRefs?: Array<{ kind: string; objectKey?: string }> }
    return { ...result, payload: { ...payload, evidenceRefs: hasPermission(account.permissions, 'run:read') && hasPermission(account.permissions, 'workflow:read') ? payload.evidenceRefs?.map(({ objectKey: _key, ...ref }) => ref) : [] } }
  }

  preview(targetId: string, body: MapGovernancePreviewBody, account: RequestAccount) {
    return previewMapGovernance(this.database, targetId, body, hasPermission(account.permissions, 'workflow:read')).catch(
      rethrowDomain,
    )
  }

  command(targetId: string, body: MapGovernanceCommandBody, account: RequestAccount) {
    return applyMapGovernanceCommand(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  async rebuild(targetId: string, account: RequestAccount) {
    try {
      const projection = await requestMapProjectionRebuild(this.database, targetId, this.actor(account))
      return mapRebuildResponseSchema.parse({
        projectionId: projection.id,
        status: projection.status,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  listReleases(targetId: string, query: { cursor?: string; limit?: number }) {
    return listMapReleases(this.database, targetId, { cursor: query.cursor, limit: query.limit ?? 20 }).catch(rethrowDomain)
  }

  getRelease(targetId: string, releaseId: string) {
    return getMapReleasePublication(this.database, targetId, releaseId).catch(rethrowDomain)
  }

  sealAndPublish(targetId: string, body: MapSealPublishBody, account: RequestAccount) {
    return sealAndPublishMapRelease(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  publish(targetId: string, releaseId: string, body: MapPublicationBody, account: RequestAccount) {
    return publishMapRelease(this.database, targetId, releaseId, body, this.actor(account)).catch(rethrowDomain)
  }

  withdraw(targetId: string, releaseId: string, body: MapPublicationBody, account: RequestAccount) {
    return withdrawMapRelease(this.database, targetId, releaseId, body, this.actor(account)).catch(rethrowDomain)
  }

  listReferences(targetId: string, query: MapListQuery, account: RequestAccount) {
    return listMapReferences(this.database, targetId, {
      ...query,
      visible: hasPermission(account.permissions, 'workflow:read'),
    }).catch(rethrowDomain)
  }

  async listImpacts(targetId: string, query: MapImpactQuery, account: RequestAccount) {
    try {
      const source = await loadMapImpactSource(this.database, targetId, query, hasPermission(account.permissions, 'workflow:read'))
      if (source.restricted) return mapImpactListResponseSchema.parse({ items: [], restricted: true, notes: ['结果受权限限制'] })
      const graded = gradeMapImpact(source)
      const items = query.fromReleaseId && !source.changedAssetKeys.length ? [] : graded.items
      const keyed = items.map(item => ({ ...item, scenarioName: source.scenarioNames[item.scenarioId!], key: `${item.grade}:${item.scenarioId}:${item.bindingId ?? item.stepId ?? ''}:${item.assetRefKey ?? ''}` }))
        .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      const digest = createHash('sha256').update(canonicalJson({ targetId, assetRefKey: query.assetRefKey, fromReleaseId: query.fromReleaseId, toReleaseId: query.toReleaseId })).digest('hex')
      let after: string | undefined
      if (query.cursor) {
        try {
          const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
          if (cursor.d !== digest || typeof cursor.k !== 'string') (() => { throw conflict('MAP_CURSOR_EXPIRED', '地图游标已过期，请重新查询') })()
          after = cursor.k
        } catch { (() => { throw conflict('MAP_CURSOR_EXPIRED', '地图游标已过期，请重新查询') })() }
      }
      const page = keyed.filter(item => !after || item.key > after).slice(0, query.limit + 1)
      const shown = page.slice(0, query.limit)
      return mapImpactListResponseSchema.parse({
        items: shown.map(({ key: _key, ...item }) => item),
        restricted: false,
        nextCursor: page.length > query.limit ? Buffer.from(JSON.stringify({ d: digest, k: shown.at(-1)!.key })).toString('base64url') : undefined,
        notes: graded.notes,
      })
    } catch (error) { rethrowDomain(error) }
  }

  bind(targetId: string, body: MapScenarioBindingBody, account: RequestAccount) {
    return upsertMapScenarioBinding(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  unbind(targetId: string, bindingId: string, body: unknown, account: RequestAccount) {
    return removeMapScenarioBinding(this.database, targetId, bindingId, body, this.actor(account)).catch(rethrowDomain)
  }

  startScan(targetId: string, account: RequestAccount) {
    return startMapReferenceScan(this.database, targetId, this.actor(account)).catch(rethrowDomain)
  }

  async listTerms(targetId: string, query: TerminologyListQuery, account: RequestAccount) {
    try {
      const result = await listTerminology(this.database, targetId, query)
      return { ...result, items: await visibleTerms(this.database, targetId, result.items, account) }
    } catch (error) { rethrowDomain(error) }
  }

  async matchTerms(targetId: string, alias: string, account: RequestAccount) {
    try {
      const result = await matchTerminology(this.database, targetId, { alias })
      return { ...result, items: await visibleTerms(this.database, targetId, result.items, account) }
    } catch (error) { rethrowDomain(error) }
  }

  async getTerm(targetId: string, termId: string, account: RequestAccount) {
    try {
      const item = await getTerminology(this.database, targetId, termId)
      const [visible] = await visibleTerms(this.database, targetId, [item], account)
      if (!visible) throw notFound('KNOWLEDGE_NOT_FOUND', '术语不存在')
      return visible
    }
    catch (error) { rethrowDomain(error) }
  }

  async createTerm(targetId: string, body: CreateTerminologyBody, account: RequestAccount) {
    try {
      await validateKnowledgeSources(this.database, targetId, body.sources ?? [], knowledgeAccess(account))
      return await createTerminology(this.database, targetId, { ...body, canonicalName: redactKnowledgeQuestion(body.canonicalName), aliases: body.aliases?.map(redactKnowledgeQuestion), meaning: redactKnowledgeQuestion(body.meaning) }, this.actor(account))
    } catch (error) { rethrowDomain(error) }
  }

  async updateTerm(targetId: string, termId: string, body: UpdateTerminologyBody, account: RequestAccount) {
    try {
      const prior = await getTerminology(this.database, targetId, termId)
      await validateKnowledgeSources(this.database, targetId, prior.sources.filter(source => source.kind === 'analysis_candidate'), knowledgeAccess(account))
      await validateKnowledgeSources(this.database, targetId, body.sources ?? prior.sources, knowledgeAccess(account))
      return await updateTerminology(this.database, targetId, termId, { ...body, canonicalName: body.canonicalName ? redactKnowledgeQuestion(body.canonicalName) : undefined, aliases: body.aliases?.map(redactKnowledgeQuestion), meaning: body.meaning ? redactKnowledgeQuestion(body.meaning) : undefined }, this.actor(account))
    } catch (error) { rethrowDomain(error) }
  }

  async retireTerm(targetId: string, termId: string, body: RetireTerminologyBody, account: RequestAccount) {
    try {
      const prior = await getTerminology(this.database, targetId, termId)
      await validateKnowledgeSources(this.database, targetId, prior.sources.filter(source => source.kind === 'analysis_candidate'), knowledgeAccess(account))
      await retireTerminology(this.database, targetId, termId, { ...body, reason: redactKnowledgeQuestion(body.reason) }, this.actor(account))
      return await this.getTerm(targetId, termId, account)
    } catch (error) { rethrowDomain(error) }
  }

  consumptionPolicy(targetId: string) {
    return getMapConsumptionPolicy(this.database, targetId).catch(rethrowDomain)
  }

  updateConsumptionPolicy(targetId: string, body: MapConsumptionPolicyUpdateBody, account: RequestAccount) {
    return updateMapConsumptionPolicy(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  async grantConsumptionEligibility(
    targetId: string,
    body: MapConsumptionEligibilityGrantBody,
    account: RequestAccount,
  ) {
    try {
      await grantMapConsumptionEligibility(this.database, {
        targetId,
        reportId: body.reportId,
        eligibleStepTypes: body.eligibleStepTypes,
        reason: body.reason,
        actor: this.actor(account),
      })
      return await getMapConsumptionPolicy(this.database, targetId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  jobPolicy(targetId: string) {
    return getMapJobPolicy(this.database, targetId).catch(rethrowDomain)
  }

  updateJobPolicy(targetId: string, body: MapJobPolicyUpdateBody, account: RequestAccount) {
    return updateMapJobPolicy(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  stateRule(targetId: string) {
    return getTargetStateRuleConfig(this.database, targetId).catch(rethrowDomain)
  }

  updateStateRuleQueryParams(targetId: string, body: TargetStateRuleQueryParamsUpdateBody, account: RequestAccount) {
    return updateTargetStateRuleQueryParams(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  menuEntries(targetId: string) {
    return listMapMenuEntries(this.database, targetId).catch(rethrowDomain)
  }

  createMenuEntry(targetId: string, body: MapMenuEntryCreateBody, account: RequestAccount) {
    return createMapMenuEntry(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  updateMenuEntry(targetId: string, entryId: string, body: MapMenuEntryUpdateBody, account: RequestAccount) {
    return updateMapMenuEntry(this.database, targetId, entryId, body, this.actor(account)).catch(rethrowDomain)
  }

  archiveMenuEntry(targetId: string, entryId: string, body: MapMenuEntryArchiveBody, account: RequestAccount) {
    return archiveMapMenuEntry(this.database, targetId, entryId, body, this.actor(account)).catch(rethrowDomain)
  }

  reorderMenuEntries(targetId: string, body: MapMenuEntryReorderBody, account: RequestAccount) {
    return reorderMapMenuEntries(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  ingestions(targetId: string, query: MapIngestJobListQuery) {
    return listMapIngestJobs(this.database, targetId, query).catch(rethrowDomain)
  }

  createIngestion(targetId: string, body: MapIngestCreateBody, account: RequestAccount) {
    return createMapIngestJob(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  async ingestion(targetId: string, jobId: string) {
    try {
      const job = await getMapJob(this.database, jobId)
      if (job.targetId !== targetId) throw notFound('MAP_JOB_NOT_FOUND', '采集作业不存在')
      return job
    } catch (error) { rethrowDomain(error) }
  }

  async cancelIngestion(targetId: string, jobId: string, account: RequestAccount) {
    await this.ingestion(targetId, jobId)
    return cancelMapJob(this.database, jobId, this.actor(account), account.id).catch(rethrowDomain)
  }

  knowledgeContext(targetId: string, query: TargetKnowledgeContextQuery) {
    return getTargetKnowledgeContext(this.database, targetId, query).catch(rethrowDomain)
  }

  ingestSurface(targetId: string, query: import('@cairn/shared').MapIngestSurfaceQuery) {
    return getMapIngestSurface(this.database, targetId, query).catch(rethrowDomain)
  }

  getJob(jobId: string, account: RequestAccount) {
    return getMapJob(this.database, jobId, account.id).catch(rethrowDomain)
  }

  cancelJob(jobId: string, account: RequestAccount) {
    return cancelMapJob(this.database, jobId, this.actor(account), account.id).catch(rethrowDomain)
  }

  async runClues(targetId: string, runId: string) {
    try {
      const loaded = await loadRunMapClues(this.database, targetId, runId)
      const grouped = groupMapDiagnosisClues(loaded.rows)
      return mapRunCluesResponseSchema.parse({
        runId: loaded.runId,
        targetId: loaded.targetId,
        ...grouped,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
