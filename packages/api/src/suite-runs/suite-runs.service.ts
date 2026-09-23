import { Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  cancelSuiteRun,
  createSuiteRun,
  getSuiteRunObservation,
  listSuiteRunEventsAfter,
  listSuiteRuns,
  previewSuiteRun,
  rerunSuiteItem,
  type DbHandle,
  type ChangeHintBus,
} from '@cairn/db'
import type { CreateSuiteRunBody, RerunSuiteItemBody, SuiteRunListQuery } from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import { observeObject } from '../common/observe-object.js'
import { CHANGE_HINT } from '../observe/change-hint.module.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class SuiteRunsService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle, @Inject(CHANGE_HINT) private readonly hints: ChangeHintBus) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  list(query: SuiteRunListQuery, actorId: string) {
    return listSuiteRuns(this.database, query, actorId).catch(rethrowDomain)
  }

  preview(body: CreateSuiteRunBody, actorId: string) {
    return previewSuiteRun(this.database, body, actorId).catch(rethrowDomain)
  }

  create(body: CreateSuiteRunBody, account: RequestAccount) {
    return createSuiteRun(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  observation(suiteRunId: string, actorId: string) {
    return getSuiteRunObservation(this.database, suiteRunId, actorId).catch(rethrowDomain)
  }

  cancel(suiteRunId: string, account: RequestAccount) {
    return cancelSuiteRun(this.database, suiteRunId, this.actor(account)).catch(rethrowDomain)
  }

  rerunItem(suiteRunId: string, body: RerunSuiteItemBody, account: RequestAccount) {
    return rerunSuiteItem(this.database, { suiteRunId, memberId: body.memberId }, this.actor(account)).catch(rethrowDomain)
  }

  async stream(suiteRunId: string, actorId: string, req: Request, res: Response) {
    return observeObject({ req, res, after: 0, hints: this.hints, objectId: suiteRunId, event: 'observation',
      matches: hint => hint.objectType === 'suite_run' && hint.objectId === suiteRunId,
      snapshot: () => this.observation(suiteRunId, actorId),
      events: cursor => listSuiteRunEventsAfter(this.database, suiteRunId, cursor),
      finished: observation => ['COMPLETED', 'CANCELLED', 'FAILED'].includes(observation.status) && observation.evidenceStatus !== 'PENDING' && observation.automaticReport?.status !== 'pending',
    })
  }
}
