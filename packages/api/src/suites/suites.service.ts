import { Inject, Injectable } from '@nestjs/common'
import {
  createSuite,
  deleteSuite,
  getSuite,
  listSuites,
  previewDeleteSuite,
  publishSuite,
  saveSuiteDraft,
  updateSuiteEnabled,
  validateSuite,
  type DbHandle,
} from '@cairn/db'
import type {
  CreateSuiteBody,
  DeleteResourceBody,
  PublishSuiteBody,
  SaveSuiteDraftBody,
  SuiteListQuery,
  UpdateSuiteEnabledBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class SuitesService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  list(query: SuiteListQuery, actorId: string) {
    return listSuites(this.database, query, actorId).catch(rethrowDomain)
  }

  get(suiteId: string, actorId: string) {
    return getSuite(this.database, suiteId, actorId).catch(rethrowDomain)
  }

  async versions(suiteId: string, actorId: string) {
    const detail = await this.get(suiteId, actorId)
    return { items: detail.published ? [detail.published] : [] }
  }

  create(body: CreateSuiteBody, account: RequestAccount) {
    return createSuite(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  saveDraft(suiteId: string, body: SaveSuiteDraftBody, account: RequestAccount) {
    return saveSuiteDraft(this.database, suiteId, body, this.actor(account)).catch(rethrowDomain)
  }

  validate(suiteId: string, actorId: string) {
    return validateSuite(this.database, suiteId, actorId).catch(rethrowDomain)
  }

  publish(suiteId: string, body: PublishSuiteBody, account: RequestAccount) {
    return publishSuite(this.database, suiteId, body, this.actor(account)).catch(rethrowDomain)
  }

  enabled(suiteId: string, body: UpdateSuiteEnabledBody, account: RequestAccount) {
    return updateSuiteEnabled(this.database, suiteId, body.status, this.actor(account)).catch(rethrowDomain)
  }

  deletePreview(suiteId: string) {
    return previewDeleteSuite(this.database, suiteId).catch(rethrowDomain)
  }

  delete(suiteId: string, body: DeleteResourceBody, account: RequestAccount) {
    return deleteSuite(this.database, suiteId, body, this.actor(account)).catch(rethrowDomain)
  }
}
