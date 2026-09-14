import {
  recordingBindingSchema,
  recordingDraftDetailSchema,
  recordingDraftListResponseSchema,
  type RecordingBindingDto,
  type RecordingDraftDetailDto,
  type RecordingDraftListResponse,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function fetchRecordings(): Promise<RecordingDraftListResponse> {
  return apiFetch('/api/recordings', recordingDraftListResponseSchema)
}

export function fetchRecording(id: string): Promise<RecordingDraftDetailDto> {
  return apiFetch(`/api/recordings/${id}`, recordingDraftDetailSchema)
}

export function closeRecordingBinding(id: string): Promise<RecordingBindingDto> {
  return apiFetch(`/api/recording-bindings/${id}/close`, recordingBindingSchema, {
    method: 'POST',
  })
}
