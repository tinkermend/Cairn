import {
  recordingBindingSchema,
  recordingDraftDetailSchema,
  recordingDraftListResponseSchema,
  renameRecordingBodySchema as renameRecordingDraftBodySchema,
  type RecordingBindingDto,
  type RecordingDraftDetailDto,
  type RecordingDraftListQuery,
  type RecordingDraftListResponse,
  deleteResourceResultSchema,
  type DeleteResourceResult,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'

export function fetchRecordings(
  query?: RecordingDraftListQuery,
): Promise<RecordingDraftListResponse> {
  return apiFetch(`/api/recordings${toQueryString(query)}`, recordingDraftListResponseSchema)
}

export function fetchRecording(id: string): Promise<RecordingDraftDetailDto> {
  return apiFetch(`/api/recordings/${id}`, recordingDraftDetailSchema)
}

export function renameRecording(id: string, name: string): Promise<RecordingDraftDetailDto> {
  return apiFetch(`/api/recordings/${id}`, recordingDraftDetailSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(renameRecordingDraftBodySchema.parse({ name })),
  })
}

export function deleteRecording(id: string): Promise<DeleteResourceResult> {
  return apiFetch(`/api/recordings/${id}/delete`, deleteResourceResultSchema, {
    method: 'POST',
  })
}

export function closeRecordingBinding(id: string): Promise<RecordingBindingDto> {
  return apiFetch(`/api/recording-bindings/${id}/close`, recordingBindingSchema, {
    method: 'POST',
  })
}
