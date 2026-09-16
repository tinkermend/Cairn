import { Inject, Injectable } from '@nestjs/common'
import {
  getSchedule,
  listScheduleEvents,
  listScheduleOccurrences,
  listSchedules,
  previewScheduleDefinition,
  setScheduleEnabled,
  writeSchedule,
  type DbHandle,
} from '@cairn/db'
import type {
  ScheduleEnabledBody,
  ScheduleEventListQuery,
  ScheduleListQuery,
  ScheduleOccurrenceListQuery,
  SchedulePreviewRequest,
  ScheduleWriteBody,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class SchedulesService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  list(query: ScheduleListQuery) {
    return listSchedules(this.database, query).catch(rethrowDomain)
  }

  get(scheduleId: string) {
    return getSchedule(this.database, scheduleId).catch(rethrowDomain)
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

  preview(body: SchedulePreviewRequest) {
    return previewScheduleDefinition(this.database, body.definition, body.asOf ? new Date(body.asOf) : undefined).catch(
      rethrowDomain,
    )
  }

  occurrences(scheduleId: string, query: ScheduleOccurrenceListQuery) {
    return listScheduleOccurrences(this.database, scheduleId, query).catch(rethrowDomain)
  }

  events(scheduleId: string, query: ScheduleEventListQuery) {
    return listScheduleEvents(this.database, scheduleId, query).catch(rethrowDomain)
  }
}
