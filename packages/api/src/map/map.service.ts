import { knowledgeAccess, visibleKnowledgeSources } from './knowledge-access'
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
  listMapJobCandidateAssets,
  listMapChanges,
  loadMapImpactSource,
  conflict,
  listMapReferences,
  listMapReleases,
  loadMapQueryView,
  loadRunMapClues,
  getMapConsumptionPolicy,
  updateMapConsumptionPolicy,
  getMapJobPolicy,
  updateMapJobPolicy,
  getExplorationPolicy,
  updateExplorationPolicy,
  forbidden,
  listMapSafeEntries,
  createMapSafeEntry,
  getMapSafeEntry,
  getMapJob,
  createMapJob,
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
  compileMapJobSlice,
  seedUrlsForExploration,
  evaluateCondition,
  gradeMapImpact,
  groupMapDiagnosisClues,
  queryMap,
  selectMapJobAssets,
  toMapJobCompileAssets,
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
  type MapMatchQuery,
  type MapPublicationBody,
  type MapScenarioBindingBody,
  type MapSealPublishBody,
  type MapConsumptionPolicyUpdateBody,
  type MapJobPolicyUpdateBody,
  type MapSafeEntryCreateBody,
  type MapJobPreviewRequest,
  type MapJobCreateBody,
  type ExplorationPolicyUpdateBody,
  type ExplorationPreviewRequest,
  type ExplorationCreateBody,
  mapJobPreviewResponseSchema,
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
        const summary = await getMapSummary(this.database, targetId, { limit: 20 })
        if (summary.view.viewRef.kind === 'projection' && summary.projectionStatus !== 'missing') {
          projectionId = summary.view.viewRef.projectionId
        } else {
          return {
            matchResult: 'MISS' as const,
            candidates: [],
            usedRefs: [],
            viewRef: summary.view.viewRef,
          }
        }
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
      const view = await loadMapQueryView(this.database, request)
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
      return { ...result, items: await Promise.all(result.items.map(async item => ({ ...item, sources: await visibleKnowledgeSources(this.database, targetId, item.sources, account) }))) }
    } catch (error) { rethrowDomain(error) }
  }

  async matchTerms(targetId: string, alias: string, account: RequestAccount) {
    try {
      const result = await matchTerminology(this.database, targetId, { alias })
      return { ...result, items: await Promise.all(result.items.map(async item => ({ ...item, sources: await visibleKnowledgeSources(this.database, targetId, item.sources, account) }))) }
    } catch (error) { rethrowDomain(error) }
  }

  async getTerm(targetId: string, termId: string, account: RequestAccount) {
    try { const item = await getTerminology(this.database, targetId, termId); return { ...item, sources: await visibleKnowledgeSources(this.database, targetId, item.sources, account) } }
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
      await validateKnowledgeSources(this.database, targetId, body.sources ?? prior.sources, knowledgeAccess(account))
      return await updateTerminology(this.database, targetId, termId, { ...body, canonicalName: body.canonicalName ? redactKnowledgeQuestion(body.canonicalName) : undefined, aliases: body.aliases?.map(redactKnowledgeQuestion), meaning: body.meaning ? redactKnowledgeQuestion(body.meaning) : undefined }, this.actor(account))
    } catch (error) { rethrowDomain(error) }
  }

  async retireTerm(targetId: string, termId: string, body: RetireTerminologyBody, account: RequestAccount) {
    try {
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

  jobPolicy(targetId: string) {
    return getMapJobPolicy(this.database, targetId).catch(rethrowDomain)
  }

  updateJobPolicy(targetId: string, body: MapJobPolicyUpdateBody, account: RequestAccount) {
    return updateMapJobPolicy(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  listSafeEntries(targetId: string) {
    return listMapSafeEntries(this.database, targetId).catch(rethrowDomain)
  }

  createSafeEntry(targetId: string, body: MapSafeEntryCreateBody, account: RequestAccount) {
    return createMapSafeEntry(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  explorationPolicy(targetId: string) {
    return getExplorationPolicy(this.database, targetId).catch(rethrowDomain)
  }

  updateExplorationPolicy(targetId: string, body: ExplorationPolicyUpdateBody, account: RequestAccount) {
    return updateExplorationPolicy(this.database, targetId, body, this.actor(account)).catch(rethrowDomain)
  }

  async previewJob(targetId: string, body: MapJobPreviewRequest) {
    try {
      const policy = await getMapJobPolicy(this.database, targetId)
      const entry = await getMapSafeEntry(this.database, targetId, body.entryId)
      const assets = toMapJobCompileAssets(await listMapJobCandidateAssets(this.database, targetId))
      const items = selectMapJobAssets(body.jobKind, policy.policy, assets, body.selectedAssetRefs)
      return mapJobPreviewResponseSchema.parse({
        jobKind: body.jobKind,
        entryId: body.entryId,
        items,
        estimatedActions: items.filter((item) => item.included).length + 2,
        estimatedSeconds: policy.policy.sliceWorkSeconds,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async createJob(targetId: string, body: MapJobCreateBody, account: RequestAccount) {
    try {
      if (body.jobKind === 'map_explore' && !hasPermission(account.permissions, 'map:explore')) {
        throw forbidden('MAP_FORBIDDEN', '需要探索权限')
      }
      const policy = await getMapJobPolicy(this.database, targetId)
      const entry = await getMapSafeEntry(this.database, targetId, body.entryId)
      const assets = toMapJobCompileAssets(await listMapJobCandidateAssets(this.database, targetId))
      const items = selectMapJobAssets(body.jobKind, policy.policy, assets, body.selectedAssetRefs)
      const included = assets.filter((asset) =>)
        items.some(
          (item) =>
            item.included &&
            (item.assetRef.objectId ?? item.assetRef.pageId) === (asset.assetRef.objectId ?? asset.assetRef.pageId),
        ),
      )
      const exploration = body.jobKind === 'map_explore' ? await getExplorationPolicy(this.database, targetId) : null
      const compiled = compileMapJobSlice({
        jobKind: body.jobKind,
        entry: {
          entryId: entry.entryId,
          version: entry.version,
          name: entry.name,
          url: entry.url,
          arrivalName: entry.arrivalName,
          arrivalTarget: entry.arrivalTarget,
          safetyBasis: entry.safetyBasis,
          jobKinds: entry.jobKinds,
        },
        included,
        policy: policy.policy,
        exploration: exploration?.policy,
        seedUrls: exploration ? seedUrlsForExploration(entry.url) : undefined,
      })
      if (!compiled.ok) {
        throw conflict(
          compiled.reason === 'entry_precondition_unknown' ? 'ENTRY_PRECONDITION_UNKNOWN' : 'COMPILE_REJECTED',
          compiled.message,
        )
      }
      const summary = await getMapSummary(this.database, targetId, { limit: 1 })
      return await createMapJob(this.database, targetId, body, this.actor(account), {
        steps: compiled.steps,
        releaseId: summary.publishedReleaseId,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async previewExploration(targetId: string, body: ExplorationPreviewRequest) {
    try {
      const exploration = await getExplorationPolicy(this.database, targetId)
      const entry = await getMapSafeEntry(this.database, targetId, body.entryId)
      const seedUrls = seedUrlsForExploration(entry.url)
      const items = [
        ...exploration.policy.allowlist.map((item) => ({
          assetRef: { targetId },
          name: item.pathPrefix ? `${item.origin}${item.pathPrefix}` : item.origin,
          included: true,
          reason: exploration.policy.exploreEnabled ? 'allowlist 内只读范围' : '政策仍关闭，仅预览',
        })),
        ...seedUrls.map((url) => ({
          assetRef: { targetId },
          name: url,
          included: exploration.policy.allowlist.length === 0 ? false : true,
          reason: '安全进入或种子 URL',
        })),
      ]
      return mapJobPreviewResponseSchema.parse({
        jobKind: 'map_explore',
        entryId: body.entryId,
        items: items.slice(0, 32),
        estimatedActions: 6,
        estimatedSeconds: exploration.policy.sliceWorkSeconds,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async createExploration(targetId: string, body: ExplorationCreateBody, account: RequestAccount) {
    const jobPolicy = await getMapJobPolicy(this.database, targetId).catch(rethrowDomain)
    return this.createJob(
      targetId,
      {
        source: 'explore',
        manualId: body.manualId,
        expectedPolicyRevision: jobPolicy.revision,
        expectedExplorationRevision: body.expectedExplorationRevision,
        jobKind: 'map_explore',
        targetAccountId: body.targetAccountId,
        entryId: body.entryId,
        selectedAssetRefs: body.selectedAssetRefs,
      },
      account,
    )
  }

  getJob(jobId: string) {
    return getMapJob(this.database, jobId).catch(rethrowDomain)
  }

  cancelJob(jobId: string, account: RequestAccount) {
    return cancelMapJob(this.database, jobId, this.actor(account)).catch(rethrowDomain)
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
