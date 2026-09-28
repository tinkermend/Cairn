import { z } from 'zod'
import {
  recordingBindingSchema,
  recordingDraftDetailSchema,
  recordingDraftListResponseSchema,
  renameRecordingBodySchema as renameRecordingDraftBodySchema,
  recordingGeneralizationDtoSchema,
  saveGeneralizationDecisionsBodySchema,
  submitGeneralizationRoundBodySchema,
  handoffCreateScenarioBodySchema,
  scenarioAuthoringDocumentV2Schema,
  scenarioDetailSchema,
  recordingImportReceiptSchema,
  generalizationRoundSchema,
  type RecordingBindingDto,
  type RecordingDraftDetailDto,
  type RecordingDraftListQuery,
  type RecordingDraftListResponse,
  deleteResourceResultSchema,
  type DeleteResourceResult,
  type RecordingGeneralizationDto,
  type SaveGeneralizationDecisionsBody,
  type SubmitGeneralizationRoundBody,
  type HandoffCreateScenarioBody,
  type ScenarioAuthoringDocumentV2,
  type GeneralizationRound,
} from '@cairn/shared'
import { apiFetch, toQueryString } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { readSseStream } from './sse'

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

export const generalizationResponseSchema = z.object({
  generalization: recordingGeneralizationDtoSchema,
  candidateDocument: scenarioAuthoringDocumentV2Schema.optional(),
})
export type GeneralizationResponse = z.infer<typeof generalizationResponseSchema>

export const handoffCreateScenarioResponseSchema = z.object({
  scenario: scenarioDetailSchema,
  receipt: recordingImportReceiptSchema,
  generalization: recordingGeneralizationDtoSchema,
})
export type HandoffCreateScenarioResponse = z.infer<typeof handoffCreateScenarioResponseSchema>

export function fetchRecordingGeneralization(id: string): Promise<GeneralizationResponse> {
  return apiFetch(`/api/recordings/${id}/generalization`, generalizationResponseSchema)
}

export function observeRecordingGeneralization(
  id: string,
  handlers: {
    onUpdate?: (data: GeneralizationResponse) => void
    onError?: (error: Error) => void
  },
): () => void {
  const url = `/api/recordings/${id}/generalization/observe`
  const controller = new AbortController()
  const token = useAuthStore.getState().auth.accessToken

  void (async () => {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if (!res.ok || !res.body) {
        handlers.onError?.(new Error(`SSE connection failed with status ${res.status}`))
        return
      }
      await readSseStream(
        res.body,
        (frame) => {
          if (frame.event === 'generalization' || frame.event === 'snapshot') {
            try {
              const parsed = generalizationResponseSchema.parse(JSON.parse(frame.data))
              handlers.onUpdate?.(parsed)
            } catch (e) {
              handlers.onError?.(new Error(`泛化进度事件不符合契约：${e instanceof Error ? e.message : String(e)}`))
            }
          }
        },
        controller.signal,
      )
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })()

  return () => controller.abort()
}

export function saveRecordingGeneralizationDecisions(
  id: string,
  body: SaveGeneralizationDecisionsBody,
): Promise<GeneralizationResponse> {
  return apiFetch(`/api/recordings/${id}/generalization/decisions`, generalizationResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(saveGeneralizationDecisionsBodySchema.parse(body)),
  })
}

export function submitRecordingGeneralizationRound(
  id: string,
  body: SubmitGeneralizationRoundBody,
): Promise<{
  generalization: RecordingGeneralizationDto
  candidateDocument?: ScenarioAuthoringDocumentV2
  round: GeneralizationRound
}> {
  const responseSchema = z.object({
    generalization: recordingGeneralizationDtoSchema,
    candidateDocument: scenarioAuthoringDocumentV2Schema.optional(),
    round: generalizationRoundSchema,
  })
  return apiFetch(`/api/recordings/${id}/generalization/rounds`, responseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(submitGeneralizationRoundBodySchema.parse(body)),
  })
}

export function acceptRecordingGeneralizationRound(
  id: string,
  roundId: string,
): Promise<GeneralizationResponse> {
  return apiFetch(
    `/api/recordings/${id}/generalization/rounds/${roundId}/accept`,
    generalizationResponseSchema,
    {
      method: 'POST',
    },
  )
}

export function rejectRecordingGeneralizationRound(
  id: string,
  roundId: string,
): Promise<GeneralizationResponse> {
  return apiFetch(
    `/api/recordings/${id}/generalization/rounds/${roundId}/reject`,
    generalizationResponseSchema,
    {
      method: 'POST',
    },
  )
}

export function revertRecordingGeneralizationRound(
  id: string,
  roundId: string,
): Promise<GeneralizationResponse> {
  return apiFetch(
    `/api/recordings/${id}/generalization/rounds/${roundId}/revert`,
    generalizationResponseSchema,
    {
      method: 'POST',
    },
  )
}

export function handoffCreateScenario(
  id: string,
  body: HandoffCreateScenarioBody,
): Promise<HandoffCreateScenarioResponse> {
  return apiFetch(
    `/api/recordings/${id}/handoff/create-scenario`,
    handoffCreateScenarioResponseSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(handoffCreateScenarioBodySchema.parse(body)),
    },
  )
}
