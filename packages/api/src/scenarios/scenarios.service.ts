import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  acceptKnowledgeProposal,
  applyRecordingImport,
  createRecordingBinding,
  createScenarioWithVersion,
  createTrialRunFromDraft,
  deleteScenario,
  getKnowledgeProposal,
  getPlatformConfig,
  getScenario,
  rejectKnowledgeProposal,
  listScenarioRecordingImports,
  listScenarioVersions,
  listScenarios,
  previewDeleteScenario,
  previewRecordingImport,
  publishScenarioDraft,
  saveScenarioDraft,
  updateScenarioMeta,
  previewScenarioExpansion,
  inlineScenarioModuleInvocation,
  previewScenarioModuleUpgrade,
  upgradeScenarioModuleDraft,
  extractModuleFromScenario,
  proposeExtractFromScenario,
  previewReplaceStepsWithModule,
  replaceStepsWithModule,
  acceptModuleResolution,
  type DbHandle,
} from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  type AcceptKnowledgeProposalBody,
  type ApplyRecordingImportBody,
  type CreateKnowledgeProposalBody,
  type CreateRecordingBindingBody,
  type CreateScenarioBody,
  type PlatformConfigCurrent,
  type PreviewRecordingImportBody,
  type PublishScenarioBody,
  type SaveScenarioDraftBody,
  type ScenarioListQuery,
  type DeleteResourceBody,
  type TrialRunBody,
  type UpdateScenarioBody,
  type PreviewScenarioExpansionBody,
  type InlineScenarioModuleInvocationBody,
  type ModuleExtractBody,
  type ModuleExtractPreviewBody,
  type ModuleReplaceBody,
  type ModuleReplacePreviewBody,
  type ModuleUpgradeBody,
  type ModuleUpgradePreviewBody,
  type ModuleResolveAcceptBody,
} from '@cairn/shared'
import { composeScenarioKnowledge } from './knowledge-operations'
import { requireProposalAccess } from '../map/knowledge-access'
import { publicApiOrigin } from '../recordings/recordings.service'
import {
  assertAiExecutePermission,
  browserAiCapabilitiesFrom,
  executableTypesFrom,
} from '../config/browser-ai'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'
import { PlatformConfigService } from '../platform-config/platform-config.service'

@Injectable()
export class ScenariosService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Optional() private readonly platformConfig?: PlatformConfigService,
  ) {}

  private get db() {
    return this.dbHandle
  }

  private async currentConfig(): Promise<PlatformConfigCurrent> {
    if (this.platformConfig) return this.platformConfig.ensure()
    return (
      (await getPlatformConfig(this.db)) ?? {
        revision: 1,
        document: FACTORY_PLATFORM_CONFIG,
        updatedAt: new Date(0).toISOString(),
        updatedByAccountId: null,
        reason: '出厂默认',
        source: 'bootstrap',
      }
    )
  }

  list(query?: ScenarioListQuery) {
    return listScenarios(this.db, query).catch(rethrowDomain)
  }

  previewDelete(id: string) {
    return previewDeleteScenario(this.db, id).catch(rethrowDomain)
  }

  async capabilities() {
    const current = await this.currentConfig()
    return browserAiCapabilitiesFrom(current.document, current.revision)
  }

  private async runtimeTypes() {
    const current = await this.currentConfig()
    return executableTypesFrom(current.document)
  }

  get(id: string) {
    return getScenario(this.db, id).catch(rethrowDomain)
  }

  versions(id: string) {
    return listScenarioVersions(this.db, id).catch(rethrowDomain)
  }

  async create(body: CreateScenarioBody, actor: RequestAccount) {
    try {
      return await createScenarioWithVersion(this.db, {
        targetId: body.targetId,
        name: body.name,
        steps: body.steps,
        inputs: body.inputs,
        status: body.status,
        actor: { id: actor.id },
        executableTypes: await this.runtimeTypes(),
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async update(id: string, body: UpdateScenarioBody, actor: RequestAccount) {
    try {
      return await updateScenarioMeta(this.db, id, {
        name: body.name,
        status: body.status,
        actor: { id: actor.id },
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async saveDraft(id: string, body: SaveScenarioDraftBody, actor: RequestAccount) {
    try {
      return await saveScenarioDraft(this.db, id, {
        revision: body.revision,
        document: body.document,
        actor: { id: actor.id },
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async publish(id: string, body: PublishScenarioBody, actor: RequestAccount) {
    try {
      return await publishScenarioDraft(this.db, id, {
        revision: body.revision,
        actor: { id: actor.id },
        executableTypes: await this.runtimeTypes(),
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async trial(id: string, body: TrialRunBody, actor: RequestAccount) {
    try {
      const current = await this.currentConfig()
      const types = executableTypesFrom(current.document)
      const detail = await getScenario(this.db, id, { executableTypes: types })
      const draftDocument = detail.draft?.document
      const steps =
        (draftDocument && 'steps' in draftDocument ? draftDocument.steps : undefined) ??
        detail.published?.definition.steps ??
        []
      assertAiExecutePermission(actor, steps)
      return await createTrialRunFromDraft(this.db, id, {
        revision: body.revision,
        targetAccountId: body.targetAccountId,
        input: body.input,
        policy: body.policy,
        sessionPolicy: body.sessionPolicy,
        evidencePolicy: body.evidencePolicy,
        mapCapturePolicy: body.mapCapturePolicy,
        idempotencyKey: body.idempotencyKey,
        debugMode: body.debugMode,
        actor: { id: actor.id },
        executableTypes: types,
        hangWaitMs: config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async remove(id: string, actor: RequestAccount, body?: DeleteResourceBody) {
    try {
      return await deleteScenario(this.db, id, { id: actor.id }, body)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async createRecordingBinding(id: string, body: CreateRecordingBindingBody, actor: RequestAccount) {
    try {
      return await createRecordingBinding(
        this.db,
        id,
        { ...body, apiOrigin: publicApiOrigin() },
        { id: actor.id },
      )
    } catch (error) {
      rethrowDomain(error)
    }
  }

  listRecordingImports(id: string, actor: RequestAccount) {
    return listScenarioRecordingImports(this.db, id, actor.id).catch(rethrowDomain)
  }

  async previewRecordingImport(id: string, body: PreviewRecordingImportBody, actor: RequestAccount) {
    try {
      return await previewRecordingImport(this.db, id, body, actor.id)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  async createKnowledgeProposal(id: string, body: CreateKnowledgeProposalBody, account: RequestAccount) {
    try { return await composeScenarioKnowledge(this.db, id, body, account, (await this.currentConfig()).revision) }
    catch (error) { rethrowDomain(error) }
  }

  async getKnowledgeProposal(id: string, proposalId: string, account: RequestAccount) {
    try { return await requireProposalAccess(this.db, await getKnowledgeProposal(this.db, id, proposalId), account) }
    catch (error) { rethrowDomain(error) }
  }

  async acceptKnowledgeProposal(id: string, proposalId: string, body: AcceptKnowledgeProposalBody, account: RequestAccount) {
    await this.getKnowledgeProposal(id, proposalId, account)
    return acceptKnowledgeProposal(this.db, id, proposalId, body, this.actor(account)).catch(rethrowDomain)
  }

  async rejectKnowledgeProposal(id: string, proposalId: string, account: RequestAccount) {
    await this.getKnowledgeProposal(id, proposalId, account)
    return rejectKnowledgeProposal(this.db, id, proposalId, this.actor(account)).catch(rethrowDomain)
  }

  async applyRecordingImport(id: string, body: ApplyRecordingImportBody, actor: RequestAccount) {
    try {
      return await applyRecordingImport(this.db, id, body, { id: actor.id }, {
        executableTypes: await this.runtimeTypes(),
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async previewModuleExpansion(id: string, body?: PreviewScenarioExpansionBody) {
    try {
      return await previewScenarioExpansion(this.db, id, body)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async inlineModuleInvocation(
    scenarioId: string,
    invocationId: string,
    body: InlineScenarioModuleInvocationBody,
    actor: RequestAccount,
  ) {
    try {
      return await inlineScenarioModuleInvocation(this.db, scenarioId, invocationId, {
        revision: body.expectedDraftLockVersion,
        actor: this.actor(actor),
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  previewModuleUpgrade(id: string, body: ModuleUpgradePreviewBody) {
    return previewScenarioModuleUpgrade(this.db, id, body).catch(rethrowDomain)
  }

  upgradeModule(id: string, body: ModuleUpgradeBody, actor: RequestAccount) {
    return upgradeScenarioModuleDraft(this.db, id, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  previewModuleExtract(id: string, body: ModuleExtractPreviewBody) {
    return proposeExtractFromScenario(this.db, id, body.stepIds).catch(rethrowDomain)
  }

  extractModule(id: string, body: ModuleExtractBody, actor: RequestAccount) {
    return extractModuleFromScenario(this.db, id, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  previewModuleReplace(id: string, body: ModuleReplacePreviewBody) {
    return previewReplaceStepsWithModule(this.db, id, body).catch(rethrowDomain)
  }

  replaceModule(id: string, body: ModuleReplaceBody, actor: RequestAccount) {
    return replaceStepsWithModule(this.db, id, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }

  acceptModuleResolution(id: string, requestId: string, body: ModuleResolveAcceptBody, actor: RequestAccount) {
    return acceptModuleResolution(this.db, id, requestId, { ...body, actor: { id: actor.id } }).catch(rethrowDomain)
  }
}
