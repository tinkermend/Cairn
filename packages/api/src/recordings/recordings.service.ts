import { Inject, Injectable } from '@nestjs/common'
import {
  claimRecordingBinding,
  closeRecordingBinding,
  createRecordingBinding,
  createRecordingDraft,
  getOpenRecordingBinding,
  getRecordingDraft,
  listRecordingDrafts,
  type DbHandle,
} from '@cairn/db'
import type {
  ClaimRecordingBindingBody,
  CreateRecordingBindingBody,
  CreateRecordingBody,
} from '@cairn/shared'
import { hasPermission } from '@cairn/shared'
import { forbidden } from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'
import { config } from '../config/env'

@Injectable()
export class RecordingsService {
  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  private get db() {
    return this.dbHandle
  }

  list(actor: RequestAccount) {
    return listRecordingDrafts(this.db, actor.id)
  }

  get(id: string, actor: RequestAccount) {
    return getRecordingDraft(this.db, id, actor.id).catch(rethrowDomain)
  }

  async create(body: CreateRecordingBody, actor: RequestAccount) {
    if (body.bindingId && !hasPermission(actor.permissions, 'target:read')) {
      rethrowDomain(forbidden('FORBIDDEN', '绑定上传需要 target:read'))
    }
    try {
      const result = await createRecordingDraft(this.db, body, { id: actor.id })
      return result.detail
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async createBinding(
    scenarioId: string,
    body: CreateRecordingBindingBody,
    actor: RequestAccount,
  ) {
    try {
      return await createRecordingBinding(
        this.db,
        scenarioId,
        { ...body, apiOrigin: publicApiOrigin() },
        { id: actor.id },
      )
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async claim(body: ClaimRecordingBindingBody, actor: RequestAccount) {
    try {
      return await claimRecordingBinding(this.db, body, { id: actor.id })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async close(bindingId: string, actor: RequestAccount) {
    try {
      return await closeRecordingBinding(this.db, bindingId, { id: actor.id })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async open(actor: RequestAccount) {
    try {
      return { binding: await getOpenRecordingBinding(this.db, actor.id) }
    } catch (error) {
      rethrowDomain(error)
    }
  }
}

export function publicApiOrigin(): string {
  return `http://localhost:${config.CAIRN_API_PORT}`
}
