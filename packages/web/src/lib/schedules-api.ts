import {
  analysisJobDtoSchema,
  scheduleDtoSchema,
  scheduleEventListResponseSchema,
  scheduleListResponseSchema,
  scheduleOccurrenceListResponseSchema,
  schedulePreviewResponseSchema,
  scheduleTriggerResponseSchema,
  scheduleWriteResponseSchema,
  type ScheduleEnabledBody,
  type ScheduleEventListQuery,
  type ScheduleListQuery,
  type ScheduleOccurrenceListQuery,
  type SchedulePreviewQuery,
  type SchedulePreviewRequest,
  type ScheduleTriggerBody,
  type ScheduleWriteBody,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchAnalysisJob(jobId: string) {
  return apiFetch(`/api/analysis-jobs/${jobId}`, analysisJobDtoSchema)
}

export function cancelAnalysisJob(jobId: string) {
  return apiFetch(`/api/analysis-jobs/${jobId}/cancel`, analysisJobDtoSchema, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: `cancel-analysis-${jobId}-${Date.now()}` }) })
}

export function fetchSchedules(query: Partial<ScheduleListQuery> = {}) {
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

export function triggerSchedule(scheduleId: string, body: ScheduleTriggerBody) {
  return apiFetch(`/api/schedules/${scheduleId}/trigger`, scheduleTriggerResponseSchema, {
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

export function previewScheduleWindows(query: SchedulePreviewQuery) {
  return apiFetch(`/api/schedules/preview${toQueryString(query)}`, schedulePreviewResponseSchema)
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
