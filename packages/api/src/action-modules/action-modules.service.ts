import { Inject, Injectable } from '@nestjs/common'
import {
  createActionModule,
  getPlatformConfig,
  deleteActionModule,
  getActionModule,
  getActionModuleVersion,
  listActionModules,
  listActionModuleVersions,
  publishActionModule,
  saveActionModuleDraft,
  updateActionModuleMeta,
  prepareModuleDraftTrial,
  createTrialRunFromDraft,
  listModuleReferences,
  batchUpgradeModuleDrafts,
  updateModulePublication,
  disableAffectedScenarios,
  previewDeleteActionModule,
  resolveActionModules,
  getModuleResolution,
  closeModuleResolution,
  getActionModuleQuality,
  listModuleInvocations,
  attachModuleListHealth,
  type DbHandle,
} from '@cairn/db'
import { FACTORY_PLATFORM_CONFIG } from '@cairn/shared'
import { browserAiCapabilitiesFrom } from '../config/browser-ai.js'
import type {
  CreateModuleBody,
  DisableAffectedScenariosBody,
  ModuleBatchUpgradeBody,
  ModuleListQuery,
  ModulePublicationBody,
  ModuleReferenceListQuery,
  PublishModuleBody,
  SaveModuleDraftBody,
  UpdateModuleMetaBody,
  ModuleTrialRunBody,
  ModuleResolveRequest,
  ModuleResolveCloseBody,
  ModuleQualityQuery,
  ModuleInvocationListQuery,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import type { RequestAccount } from '../common/request-account.js'
import { DB_HANDLE } from '../db/db.module.js'

@Injectable()
export class ActionModulesService {
  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  private get db() {
    return this.dbHandle
  }

  async capabilities() {
    const config = await getPlatformConfig(this.db).catch(rethrowDomain)
    return browserAiCapabilitiesFrom(config?.document ?? FACTORY_PLATFORM_CONFIG, config?.revision ?? 1)
  }

  async list(query: ModuleListQuery, actor: RequestAccount) {
    const listed = await listActionModules(this.db, query, actor.id).catch(rethrowDomain)
    listed.items = await attachModuleListHealth(this.db, listed.items).catch(() => listed.items)
    return listed
  }

  quality(id: string, query: ModuleQualityQuery) {
    return getActionModuleQuality(this.db, id, query).catch(rethrowDomain)
  }

  invocations(id: string, query: ModuleInvocationListQuery) {
    return listModuleInvocations(this.db, id, query).catch(rethrowDomain)
  }

  get(id: string, actor: RequestAccount) {
    return getActionModule(this.db, id, actor.id).catch(rethrowDomain)
  }

  create(body: CreateModuleBody, actor: RequestAccount) {
    return createActionModule(this.db, {
      ...body,
      actor: { id: actor.id },
    }).catch(rethrowDomain)
  }

  updateMeta(id: string, body: UpdateModuleMetaBody, actor: RequestAccount) {
    return updateActionModuleMeta(this.db, id, {
      ...body,
      actor: { id: actor.id },
    }).catch(rethrowDomain)
  }

  saveDraft(id: string, body: SaveModuleDraftBody, actor: RequestAccount) {
    return saveActionModuleDraft(this.db, id, {
      ...body,
      actor: { id: actor.id },
    }).catch(rethrowDomain)
  }

  publish(id: string, body: PublishModuleBody, actor: RequestAccount) {
    return publishActionModule(this.db, id, {
      ...body,
      actor: { id: actor.id },
    }).catch(rethrowDomain)
  }

  listVersions(id: string) {
    return listActionModuleVersions(this.db, id).catch(rethrowDomain)
  }

  getVersion(id: string, versionId: string) {
    return getActionModuleVersion(this.db, id, versionId).catch(rethrowDomain)
  }

  listReferences(id: string, query: ModuleReferenceListQuery) {
    return listModuleReferences(this.db, id, query).catch(rethrowDomain)
  }

  batchUpgrade(id: string, body: ModuleBatchUpgradeBody, actor: RequestAccount) {
    return batchUpgradeModuleDrafts(this.db, id, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  updatePublication(id: string, versionId: string, body: ModulePublicationBody, actor: RequestAccount) {
    return updateModulePublication(this.db, id, versionId, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  disableAffected(id: string, body: DisableAffectedScenariosBody, actor: RequestAccount) {
    return disableAffectedScenarios(this.db, id, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  previewDelete(id: string) {
    return previewDeleteActionModule(this.db, id).catch(rethrowDomain)
  }

  resolve(body: ModuleResolveRequest, actor: RequestAccount) {
    return resolveActionModules(this.db, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  getResolution(requestId: string, actor: RequestAccount) {
    return getModuleResolution(this.db, requestId, { id: actor.id }).catch(rethrowDomain)
  }

  closeResolution(requestId: string, body: ModuleResolveCloseBody, actor: RequestAccount) {
    return closeModuleResolution(this.db, requestId, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  async delete(id: string, actor: RequestAccount) {
    return deleteActionModule(this.db, id, { id: actor.id }).catch(rethrowDomain)
  }

  async trial(id: string, body: ModuleTrialRunBody | undefined, actor: RequestAccount) {
    try {
      const prepared = await prepareModuleDraftTrial(this.db, id, {
        inputs: body?.inputs ?? body?.runInput ?? {},
        implementationKey: body?.implementationKey,
        actor: { id: actor.id },
      })
      return await createTrialRunFromDraft(this.db, prepared.scenarioId, {
        revision: prepared.revision,
        targetAccountId: body?.targetAccountId,
        input: {},
        idempotencyKey: body?.idempotencyKey,
        actor: { id: actor.id },
        debugMode: 'runThrough',
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
