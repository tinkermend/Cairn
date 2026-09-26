import { Inject, Injectable } from '@nestjs/common'
import {
  claimRecordingBinding,
  closeRecordingBinding,
  createRecordingBinding,
  createRecordingDraft,
  createDemonstration,
  getDemonstration,
  deleteRecordingDraft,
  getOpenRecordingBinding,
  getRecordingDraft,
  listRecordingDrafts,
  renameRecordingDraft,
  getOrCreateRecordingGeneralization,
  saveRecordingGeneralizationDecisions,
  submitRecordingGeneralizationRound,
  updateRecordingGeneralizationRoundStatus,
  handoffCreateScenario,
  type DbHandle,
  type ChangeHintBus,
} from '@cairn/db'
import type {
  ClaimRecordingBindingBody,
  CreateRecordingBindingBody,
  CreateRecordingBody,
  CreateDemonstrationBody,
  RecordingDraftListQuery,
  SaveGeneralizationDecisionsBody,
  SubmitGeneralizationRoundBody,
  HandoffCreateScenarioBody,
} from '@cairn/shared'
import { hasPermission } from '@cairn/shared'
import { forbidden } from '@cairn/db'
import type { Request, Response } from 'express'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { observeObject } from '../common/observe-object.js'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'
import { config } from '../config/env'
import { assertDemonstrationEnabled } from './demonstration-feature'

@Injectable()
export class RecordingsService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Inject(CHANGE_HINT) private readonly hints: ChangeHintBus,
  ) {}

  private get db() {
    return this.dbHandle
  }

  list(actor: RequestAccount, query?: RecordingDraftListQuery) {
    return listRecordingDrafts(this.db, actor.id, query).catch(rethrowDomain)
  }

  createDemonstration(body: CreateDemonstrationBody, actor: RequestAccount) {
    assertDemonstrationEnabled()
    return createDemonstration(this.db, body, actor).catch(rethrowDomain)
  }

  demonstration(id: string, actor: RequestAccount) {
    return getDemonstration(this.db, id, actor.id).catch(rethrowDomain)
  }

  get(id: string, actor: RequestAccount) {
    return getRecordingDraft(this.db, id, actor.id).catch(rethrowDomain)
  }

  rename(id: string, name: string, actor: RequestAccount) {
    return renameRecordingDraft(this.db, id, name, actor).catch(rethrowDomain)
  }

  remove(id: string, actor: RequestAccount) {
    return deleteRecordingDraft(this.db, id, actor).catch(rethrowDomain)
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

  async getGeneralization(recordingDraftId: string, actorId: string) {
    try {
      return await getOrCreateRecordingGeneralization(this.db, recordingDraftId, actorId)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async observeGeneralization(recordingDraftId: string, actorId: string, req: Request, res: Response, after = 0) {
    return observeObject({
      req,
      res,
      after,
      hints: this.hints,
      objectId: recordingDraftId,
      event: 'generalization',
      matches: (hint) => hint.objectType === 'recording_draft' && hint.objectId === recordingDraftId,
      snapshot: () => this.getGeneralization(recordingDraftId, actorId),
      events: async () => [],
    })
  }

  private async publishHint(recordingDraftId: string) {
    await this.hints
      .publish({
        namespace: this.hints.namespace,
        eventSeq: Date.now(),
        objectType: 'recording_draft',
        objectId: recordingDraftId,
      })
      .catch(() => undefined)
  }

  async saveGeneralizationDecisions(
    recordingDraftId: string,
    body: SaveGeneralizationDecisionsBody,
    actor: RequestAccount,
  ) {
    try {
      const result = await saveRecordingGeneralizationDecisions(this.db, recordingDraftId, body, actor)
      await this.publishHint(recordingDraftId)
      return result
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async submitGeneralizationRound(
    recordingDraftId: string,
    body: SubmitGeneralizationRoundBody,
    actor: RequestAccount,
  ) {
    try {
      const result = await submitRecordingGeneralizationRound(this.db, recordingDraftId, body, actor)
      await this.publishHint(recordingDraftId)
      return result
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async updateGeneralizationRoundStatus(
    recordingDraftId: string,
    roundId: string,
    action: 'accept' | 'reject' | 'revert',
    actor: RequestAccount,
  ) {
    try {
      const result = await updateRecordingGeneralizationRoundStatus(this.db, recordingDraftId, roundId, action, actor)
      await this.publishHint(recordingDraftId)
      return result
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async handoffCreateScenario(
    recordingDraftId: string,
    body: HandoffCreateScenarioBody,
    actor: RequestAccount,
  ) {
    try {
      const result = await handoffCreateScenario(this.db, recordingDraftId, body, actor)
      await this.publishHint(recordingDraftId)
      return result
    } catch (error) {
      rethrowDomain(error)
    }
  }
}

export function publicApiOrigin(): string {
  return `http://localhost:${config.CAIRN_API_PORT}`
}
