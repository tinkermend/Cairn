import { Inject, Injectable } from '@nestjs/common'
import {
  createScenarioWithVersion,
  createTrialRunFromDraft,
  deleteScenario,
  getScenario,
  listScenarioVersions,
  listScenarios,
  publishScenarioDraft,
  saveScenarioDraft,
  updateScenarioMeta,
  type DbHandle,
} from '@cairn/db'
import type {
  CreateScenarioBody,
  PublishScenarioBody,
  SaveScenarioDraftBody,
  TrialRunBody,
  UpdateScenarioBody,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class ScenariosService {
  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  private get db() {
    return this.dbHandle
  }

  list() {
    return listScenarios(this.db)
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
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async trial(id: string, body: TrialRunBody, actor: RequestAccount) {
    try {
      return await createTrialRunFromDraft(this.db, id, {
        revision: body.revision,
        targetAccountId: body.targetAccountId,
        input: body.input,
        policy: body.policy,
        sessionPolicy: body.sessionPolicy,
        evidencePolicy: body.evidencePolicy,
        idempotencyKey: body.idempotencyKey,
        actor: { id: actor.id },
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
}
