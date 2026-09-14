import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  applyRecordingImport,
  createRecordingBinding,
  createScenarioWithVersion,
  createTrialRunFromDraft,
  deleteScenario,
  getPlatformConfig,
  getScenario,
  listScenarioRecordingImports,
  listScenarioVersions,
  listScenarios,
  previewRecordingImport,
  publishScenarioDraft,
  saveScenarioDraft,
  updateScenarioMeta,
  type DbHandle,
} from '@cairn/db'
import {
  FACTORY_PLATFORM_CONFIG,
  type ApplyRecordingImportBody,
  type CreateRecordingBindingBody,
  type CreateScenarioBody,
  type PlatformConfigCurrent,
  type PreviewRecordingImportBody,
  type PublishScenarioBody,
  type SaveScenarioDraftBody,
  type TrialRunBody,
  type UpdateScenarioBody,
} from '@cairn/shared'
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

  list() {
    return listScenarios(this.db)
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
      const steps = detail.draft?.document.steps ?? detail.published?.definition.steps ?? []
      assertAiExecutePermission(actor, steps)
      return await createTrialRunFromDraft(this.db, id, {
        revision: body.revision,
        targetAccountId: body.targetAccountId,
        input: body.input,
        policy: body.policy,
        sessionPolicy: body.sessionPolicy,
        evidencePolicy: body.evidencePolicy,
        idempotencyKey: body.idempotencyKey,
        actor: { id: actor.id },
        executableTypes: types,
        hangWaitMs: config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async remove(id: string, actor: RequestAccount) {
    try {
      await deleteScenario(this.db, id, { id: actor.id })
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

  async applyRecordingImport(id: string, body: ApplyRecordingImportBody, actor: RequestAccount) {
    try {
      return await applyRecordingImport(this.db, id, body, { id: actor.id }, {
        executableTypes: await this.runtimeTypes(),
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
