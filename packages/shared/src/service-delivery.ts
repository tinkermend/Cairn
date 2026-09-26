import { z } from 'zod'
import { jsonValueSchema } from './wire.js'
import {
  findingSeveritySchema,
  metricValueSchema,
  outputStatusSchema,
  MAX_RUN_OUTPUT_BYTES,
  type RunOutput,
  type ScenarioOutputDecl,
} from './run-output.js'

export const serviceDeliveryPolicySchema = z.strictObject({
  runOutput: z.boolean(),
  finalScreenshot: z.boolean(),
  failureScreenshot: z.boolean(),
})
export type ServiceDeliveryPolicy = z.infer<typeof serviceDeliveryPolicySchema>

export const DEFAULT_SERVICE_DELIVERY_POLICY: ServiceDeliveryPolicy = Object.freeze({
  runOutput: true,
  finalScreenshot: false,
  failureScreenshot: false,
})

export const LEGACY_SERVICE_DELIVERY_POLICY: ServiceDeliveryPolicy = Object.freeze({
  runOutput: false,
  finalScreenshot: false,
  failureScreenshot: false,
})

export const externalRunFindingSchema = z.strictObject({
  id: z.string().min(1).max(64),
  severity: findingSeveritySchema,
  title: z.string().trim().min(1).max(128),
  stepOrdinal: z.number().int().nonnegative().optional(),
})
export type ExternalRunFinding = z.infer<typeof externalRunFindingSchema>

export const externalRunOutputSchema = z.strictObject({
  status: outputStatusSchema,
  summary: z.string().trim().max(500).nullable(),
  metrics: z.record(z.string().max(64), metricValueSchema).default({}),
  findings: z.array(externalRunFindingSchema).max(50).default([]),
  dataRow: z.record(z.string().max(64), jsonValueSchema).default({}),
  assembledAt: z.string(),
})
export type ExternalRunOutput = z.infer<typeof externalRunOutputSchema>

export function projectExternalRunOutput(
  output: RunOutput | null | undefined,
  decl: ScenarioOutputDecl | null | undefined,
): ExternalRunOutput | null {
  if (!output) return null
  const hasOutputsDecl = Boolean(
    decl &&
      ((decl.metrics && decl.metrics.length > 0) ||
        (decl.dataRowFields && decl.dataRowFields.length > 0) ||
        decl.summaryTemplate ||
        decl.summaryFromContextKey),
  )
  if (!hasOutputsDecl) return null

  const summary =
    decl?.summaryTemplate || decl?.summaryFromContextKey ? output.summary : null

  const declaredMetricKeys = new Set(decl?.metrics?.map((m) => m.key) ?? [])
  const metrics: Record<string, any> = {}
  for (const [k, v] of Object.entries(output.metrics ?? {})) {
    if (declaredMetricKeys.has(k)) {
      metrics[k] = v
    }
  }

  const declaredDataRowKeys = new Set(
    decl?.dataRowFields?.map((f) => f.columnKey) ?? [],
  )
  const dataRow: Record<string, any> = {}
  for (const [k, v] of Object.entries(output.dataRow ?? {})) {
    if (declaredDataRowKeys.has(k)) {
      dataRow[k] = v
    }
  }

  const findings = (output.findings ?? []).map((f) => ({
    id: f.id,
    severity: f.severity,
    title: f.title,
    stepOrdinal: f.stepOrdinal,
  }))

  const parsed = externalRunOutputSchema.parse({
    status: output.status,
    summary,
    metrics,
    dataRow,
    findings,
    assembledAt: output.assembledAt,
  })

  const bytes = new TextEncoder().encode(JSON.stringify(parsed)).length
  if (bytes > MAX_RUN_OUTPUT_BYTES) {
    return null
  }
  return parsed
}
