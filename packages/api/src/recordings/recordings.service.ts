import { Inject, Injectable } from '@nestjs/common'
import { createRecordingDraft, getRecordingDraft, listRecordingDrafts, type DbHandle } from '@cairn/db'
import type { CreateRecordingBody } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class RecordingsService {
  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  private get db() {
    return this.dbHandle
  }

  list() {
    return listRecordingDrafts(this.db)
  }

  get(id: string) {
    return getRecordingDraft(this.db, id).catch(rethrowDomain)
  }

  async create(body: CreateRecordingBody, actor: RequestAccount) {
    try {
      const result = await createRecordingDraft(this.db, body, { id: actor.id })
      return result.detail
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
