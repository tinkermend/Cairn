import { Inject, Injectable } from '@nestjs/common'
import {
  appendScenarioVersion,
  createScenarioWithVersion,
  deleteScenario,
  getScenario,
  listScenarioVersions,
  listScenarios,
  updateScenarioMeta,
  type DbHandle,
} from '@cairn/db'
import type { CreateScenarioBody, UpdateScenarioBody } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class ScenariosService {
  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  private get db() {
    return this.dbHandle.db
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
        status: body.status,
        actor: { id: actor.id },
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async update(id: string, body: UpdateScenarioBody, actor: RequestAccount) {
    try {
      if (body.name !== undefined || body.status !== undefined) {
        await updateScenarioMeta(this.db, id, {
          name: body.name,
          status: body.status,
          actor: { id: actor.id },
        })
      }
      if (body.steps) {
        return await appendScenarioVersion(this.db, id, { steps: body.steps, actor: { id: actor.id } })
      }
      return await getScenario(this.db, id)
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
