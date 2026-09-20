import { z } from 'zod'
import {
  evidenceCenterTabSchema,
  evidenceRetentionObjectViewSchema,
  evidenceSearchViewSchema,
  evidenceTimePresetSchema,
} from '@cairn/shared'

const optionalText = z.preprocess(
  (value) => (value === '' || value == null ? undefined : value),
  z.string().min(1).optional().catch(undefined),
)

export const evidencePageSearchSchema = z.object({
  tab: evidenceCenterTabSchema.optional().catch(undefined),
  selected: optionalText,
  asOf: optionalText,
  timePreset: evidenceTimePresetSchema.optional().catch(undefined),
  createdFrom: optionalText,
  createdTo: optionalText,
  targetId: optionalText,
  targetAccountId: optionalText,
  scenarioId: optionalText,
  scenarioVersionId: optionalText,
  isTrial: z.coerce.boolean().optional().catch(undefined),
  runId: optionalText,
  suiteId: optionalText,
  suiteRunId: optionalText,
  memberId: optionalText,
  evidenceId: optionalText,
  stepRunId: optionalText,
  attemptId: optionalText,
  types: optionalText,
  runStatuses: optionalText,
  stepRunStatuses: optionalText,
  attemptStatuses: optionalText,
  outcomeStatuses: optionalText,
  runEvidenceStatuses: optionalText,
  availability: optionalText,
  view: evidenceSearchViewSchema.optional().catch(undefined),
  columns: optionalText,
  released: z.coerce.boolean().optional().catch(undefined),
  cursor: optionalText,
  limit: z.coerce.number().int().min(1).max(100).optional().catch(undefined),
  retentionView: evidenceRetentionObjectViewSchema.optional().catch(undefined),
  retentionCursor: optionalText,
})

export type EvidencePageSearch = z.infer<typeof evidencePageSearchSchema>

export function csvList(value?: string): string[] | undefined {
  if (!value) return undefined
  const parts = value.split(',').map((item) => item.trim()).filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

export function toggleCsv(current: string | undefined, value: string): string | undefined {
  const items = new Set(csvList(current) ?? [])
  if (items.has(value)) items.delete(value)
  else items.add(value)
  return items.size > 0 ? [...items].join(',') : undefined
}
