import { Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  getSchedule,
  listScheduleEvents,
  listScheduleEventsAfter,
  listScheduleOccurrences,
  listSchedules,
  previewScheduleDefinition,
  previewScheduleQuery,
  setScheduleEnabled,
  triggerScheduleOnce,
  writeSchedule,
  type ChangeHintBus,
  type DbHandle,
} from '@cairn/db'
import type {
  ScheduleEnabledBody,
  ScheduleEventListQuery,
  ScheduleListQuery,
  ScheduleOccurrenceListQuery,
  SchedulePreviewQuery,
  SchedulePreviewRequest,
  ScheduleTriggerBody,
  ScheduleWriteBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import { observeObject } from '../common/observe-object.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(DB_HANDLE) private readonly database: DbHandle,
    @Inject(CHANGE_HINT) private readonly hints: ChangeHintBus,
  ) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  list(query: ScheduleListQuery, actorId?: string) {
    return listSchedules(this.database, query, actorId).catch(rethrowDomain)
  }

  get(scheduleId: string, actorId?: string) {
    return getSchedule(this.database, scheduleId, actorId).catch(rethrowDomain)
  }

  create(body: ScheduleWriteBody, account: RequestAccount) {
    return writeSchedule(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  update(scheduleId: string, body: ScheduleWriteBody, account: RequestAccount) {
    return writeSchedule(this.database, body, this.actor(account), scheduleId).catch(rethrowDomain)
  }

  enabled(scheduleId: string, body: ScheduleEnabledBody, account: RequestAccount) {
    return setScheduleEnabled(this.database, scheduleId, body, this.actor(account)).catch(rethrowDomain)
  }

  trigger(scheduleId: string, body: ScheduleTriggerBody, account: RequestAccount) {
    return triggerScheduleOnce(this.database, scheduleId, body, this.actor(account)).catch(rethrowDomain)
  }

  preview(body: SchedulePreviewRequest) {
    return previewScheduleDefinition(this.database, body.definition, body.asOf ? new Date(body.asOf) : undefined).catch(
      rethrowDomain,
    )
  }

  previewQuery(query: SchedulePreviewQuery) {
    return previewScheduleQuery(this.database, query).catch(rethrowDomain)
  }

  occurrences(scheduleId: string, query: ScheduleOccurrenceListQuery) {
    return listScheduleOccurrences(this.database, scheduleId, query).catch(rethrowDomain)
  }

  events(scheduleId: string, query: ScheduleEventListQuery) {
    return listScheduleEvents(this.database, scheduleId, query).catch(rethrowDomain)
  }

  async observe(scheduleId: string, actorId: string, req: Request, res: Response, after = 0) {
    return observeObject({ req, res, after, hints: this.hints, objectId: scheduleId,
      event: 'schedule', matches: hint => hint.objectType === 'schedule' && hint.objectId === scheduleId,
      snapshot: () => this.get(scheduleId, actorId),
      events: cursor => listScheduleEventsAfter(this.database, scheduleId, cursor, actorId),
    })
  }
}
