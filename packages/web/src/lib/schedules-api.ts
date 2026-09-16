import {
  scheduleDtoSchema,
  scheduleEventListResponseSchema,
  scheduleListResponseSchema,
  scheduleOccurrenceListResponseSchema,
  schedulePreviewResponseSchema,
  scheduleWriteResponseSchema,
  type ScheduleEnabledBody,
  type ScheduleEventListQuery,
  type ScheduleOccurrenceListQuery,
  type SchedulePreviewRequest,
  type ScheduleWriteBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchSchedules(
  query: {
    targetId?: string
    enabled?: boolean
    cursor?: string
    limit?: number
  } = {},
) {
  return apiFetch(`/api/schedules${toQueryString(query)}`, scheduleListResponseSchema)
}

export function fetchSchedule(scheduleId: string) {
  return apiFetch(`/api/schedules/${scheduleId}`, scheduleDtoSchema)
}

export function createSchedule(body: ScheduleWriteBody) {
  return apiFetch('/api/schedules', scheduleWriteResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function updateSchedule(scheduleId: string, body: ScheduleWriteBody) {
  return apiFetch(`/api/schedules/${scheduleId}`, scheduleWriteResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function setScheduleEnabled(scheduleId: string, body: ScheduleEnabledBody) {
  return apiFetch(`/api/schedules/${scheduleId}/enabled`, scheduleDtoSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function previewSchedule(body: SchedulePreviewRequest) {
  return apiFetch('/api/schedules/preview', schedulePreviewResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function fetchScheduleOccurrences(scheduleId: string, query: Partial<ScheduleOccurrenceListQuery> = {}) {
  return apiFetch(
    `/api/schedules/${scheduleId}/occurrences${toQueryString(query)}`,
    scheduleOccurrenceListResponseSchema,
  )
}

export function fetchScheduleEvents(scheduleId: string, query: Partial<ScheduleEventListQuery> = {}) {
  return apiFetch(`/api/schedules/${scheduleId}/events${toQueryString(query)}`, scheduleEventListResponseSchema)
}
