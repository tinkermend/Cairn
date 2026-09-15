import {
  authoringObservationSubmitSchema,
  targetObservationSchema,
  type AuthoringObservationSubmit,
  type TargetObservation,
} from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'

export function submitAuthoringObservation(body: AuthoringObservationSubmit): Promise<TargetObservation> {
  return apiFetch('/api/authoring/observations', targetObservationSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(authoringObservationSubmitSchema.parse(body)),
  })
}
