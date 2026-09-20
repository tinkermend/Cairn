import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { runEvidenceStatusSchema } from './evidence.js'
import { outcomeStatusSchema } from './outcome.js'
import { suiteVerdictSchema } from './suites.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema } from './wire.js'

export const EXPORT_ARTIFACTS_PROTOCOL = 'export-artifacts@2' as const
export const REPORT_RENDER_VERSION = 'report-render@7' as const
export const REPORT_TEMPLATE_VERSION = 'report-template@1' as const

export const REPORT_LIMITS = Object.freeze({
  screenshots: 200,
  materialBytes: 512 * 1024 * 1024,
  imageBytes: 8 * 1024 * 1024,
  logoBytes: 2 * 1024 * 1024,
  imagePixels: 16_000_000,
  fileBytes: 100 * 1024 * 1024,
  bundleBytes: 1024 * 1024 * 1024,
  taskMs: 10 * 60_000,
  retries: 3,
  retentionDays: 30,
  bundleRetentionHours: 24,
})

export const REPORT_SUBJECTS = ['RUN', 'SUITE_RUN'] as const
export type ReportSubjectKind = (typeof REPORT_SUBJECTS)[number]
export const reportSubjectKindSchema = z.enum(REPORT_SUBJECTS)

export const REPORT_SCOPES = ['run', 'suite_summary', 'suite_bundle'] as const
export type ReportScope = (typeof REPORT_SCOPES)[number]
export const reportScopeSchema = z.enum(REPORT_SCOPES)

export const REPORT_FORMATS = ['docx', 'pdf'] as const
export type ReportFormat = (typeof REPORT_FORMATS)[number]
export const reportFormatSchema = z.enum(REPORT_FORMATS)

export const REPORT_STAGES = ['final', 'phase'] as const
export type ReportStage = (typeof REPORT_STAGES)[number]
export const reportStageSchema = z.enum(REPORT_STAGES)

export const EXPORT_JOB_KINDS = ['report_materialize', 'report_render', 'report_bundle'] as const
export type ExportJobKind = (typeof EXPORT_JOB_KINDS)[number]
export const exportJobKindSchema = z.enum(EXPORT_JOB_KINDS)

export const EXPORT_JOB_STATUSES = ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled'] as const
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number]
export const exportJobStatusSchema = z.enum(EXPORT_JOB_STATUSES)

export const ARTIFACT_KINDS = ['brand_logo', 'report_material', 'report_docx', 'report_pdf', 'report_bundle'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]
export const artifactKindSchema = z.enum(ARTIFACT_KINDS)

export const OBJECT_OWNER_KINDS = ['run', 'artifact'] as const
export type ObjectOwnerKind = (typeof OBJECT_OWNER_KINDS)[number]
export const objectOwnerKindSchema = z.enum(OBJECT_OWNER_KINDS)

export const REPORT_TITLE_VARIABLES = [
  'systemName',
  'scenarioName',
  'suiteName',
  'executedDate',
  'executedRange',
  'runNumber',
] as const
export type ReportTitleVariable = (typeof REPORT_TITLE_VARIABLES)[number]

export const SCREENSHOT_SCOPES = ['anomalies', 'selected', 'none'] as const
export type ScreenshotScope = (typeof SCREENSHOT_SCOPES)[number]
export const screenshotScopeSchema = z.enum(SCREENSHOT_SCOPES)

export const reportConfigSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(200).optional(),
  organization: z.string().trim().max(128).optional(),
  authorDisplayName: z.string().trim().max(64).optional(),
  logoArtifactId: entityIdSchema.nullable().optional(),
  timeZone: z.string().trim().min(1).max(64).refine((value) => {
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: value }); return true } catch { return false }
  }, '请输入有效的时区').default('Asia/Shanghai'),
  detailLevel: z.enum(['summary', 'detailed']).default('detailed'),
  screenshotScope: screenshotScopeSchema.default('anomalies'),
  selectedEvidenceIds: z.array(entityIdSchema).max(REPORT_LIMITS.screenshots).optional(),
  includeSuccessDetails: z.boolean().default(true),
  includeEvidenceIndex: z.boolean().default(true),
  includeAttemptHistory: z.boolean().default(true),
})
export type ReportConfig = z.infer<typeof reportConfigSchema>

// Optional overrides must not inject defaults and erase the configuration frozen at Run creation.
export const reportConfigOverrideSchema = reportConfigSchema.partial().extend({
  timeZone: reportConfigSchema.shape.timeZone.removeDefault().optional(),
  detailLevel: reportConfigSchema.shape.detailLevel.removeDefault().optional(),
  screenshotScope: reportConfigSchema.shape.screenshotScope.removeDefault().optional(),
  includeSuccessDetails: reportConfigSchema.shape.includeSuccessDetails.removeDefault().optional(),
  includeEvidenceIndex: reportConfigSchema.shape.includeEvidenceIndex.removeDefault().optional(),
  includeAttemptHistory: reportConfigSchema.shape.includeAttemptHistory.removeDefault().optional(),
})

export const DEFAULT_REPORT_CONFIG: ReportConfig = reportConfigSchema.parse({
  title: '{systemName} {executedDate} 运行报告',
})

export function substituteReportTitle(template: string, vars: Partial<Record<ReportTitleVariable, string>>): string {
  const unknown = [...template.matchAll(/\{([^{}]+)\}/g)]
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name) && !REPORT_TITLE_VARIABLES.includes(name as ReportTitleVariable))
  if (unknown.length) throw new Error(`未知标题变量：${unknown.join(', ')}`)
  return template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => vars[name as ReportTitleVariable] ?? `{${name}}`)
}

export function sanitizeReportFileName(input: string): string {
  const cleaned = input.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim()
  return Array.from(cleaned).slice(0, 80).join('') || 'report'
}

export function contentDispositionAttachment(fileName: string): string {
  const extension = fileName.match(/\.(?:docx|pdf|zip)$/i)?.[0] ?? ''
  const safe = extension
    ? `${Array.from(sanitizeReportFileName(fileName.slice(0, -extension.length))).slice(0, 80 - extension.length).join('')}${extension}`
    : sanitizeReportFileName(fileName)
  const ext = safe.includes('.') ? `.${safe.split('.').pop()}` : ''
  const ascii = /^[\x20-\x7e]+$/.test(safe) ? safe.replace(/\\/g, '_') : `report${ext.replace(/[^\x20-\x7e]/g, '')}`
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export const reportSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('RUN'), runId: entityIdSchema }),
  z.strictObject({ kind: z.literal('SUITE_RUN'), suiteRunId: entityIdSchema }),
])
export type ReportSubject = z.infer<typeof reportSubjectSchema>

export const reportRevisionDtoSchema = z.object({
  id: entityIdSchema,
  revisionNo: z.number().int().positive(),
  stage: reportStageSchema,
  scope: reportScopeSchema,
  title: z.string(),
  config: reportConfigSchema,
  templateVersion: z.string(),
  renderVersion: z.string(),
  sourceSnapshotId: entityIdSchema,
  parentReportRevisionId: entityIdSchema.nullable(),
  contentCompleteness: z.enum(['complete', 'partial']),
  sealedAt: utcInstantSchema.nullable(),
  preparationError: z.string().nullable().optional(),
  materialJobId: entityIdSchema.nullable().optional(),
  createdAt: utcInstantSchema,
})
export type ReportRevisionDto = z.infer<typeof reportRevisionDtoSchema>

export const reportDtoSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  subject: reportSubjectSchema,
  currentRevision: reportRevisionDtoSchema.nullable(),
  createdAt: utcInstantSchema,
})
export type ReportDto = z.infer<typeof reportDtoSchema>

export const reportListQuerySchema = z.object({
  targetId: entityIdSchema.optional(),
  suiteId: entityIdSchema.optional(),
  runId: entityIdSchema.optional(),
  suiteRunId: entityIdSchema.optional(),
  scope: reportScopeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type ReportListQuery = z.infer<typeof reportListQuerySchema>

export const reportListResponseSchema = z.object({
  items: z.array(reportDtoSchema),
  nextCursor: nextCursorSchema,
})
export type ReportListResponse = z.infer<typeof reportListResponseSchema>

export const createReportBodySchema = z.strictObject({
  subject: reportSubjectSchema,
  stage: reportStageSchema.default('final'),
  scope: reportScopeSchema.default('run'),
  config: reportConfigOverrideSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type CreateReportBody = z.infer<typeof createReportBodySchema>

export const createReportRevisionBodySchema = z.strictObject({
  stage: reportStageSchema.optional(),
  config: reportConfigOverrideSchema.optional(),
  reason: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type CreateReportRevisionBody = z.infer<typeof createReportRevisionBodySchema>

export const exportReportBodySchema = z.strictObject({
  formats: z.array(reportFormatSchema).min(1).max(2),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type ExportReportBody = z.infer<typeof exportReportBodySchema>

export const createReportBundleBodySchema = z.strictObject({
  reportRevisionId: entityIdSchema,
  formats: z.array(reportFormatSchema).min(1).max(2),
  includeChildReports: z.boolean().default(false),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type CreateReportBundleBody = z.infer<typeof createReportBundleBodySchema>

export const deriveMemberReportBodySchema = z.strictObject({
  memberId: z.string().min(1).max(64),
  config: reportConfigOverrideSchema.optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type DeriveMemberReportBody = z.infer<typeof deriveMemberReportBodySchema>

export const reportPreviewResponseSchema = z.object({
  subject: reportSubjectSchema,
  stage: reportStageSchema,
  scope: reportScopeSchema,
  title: z.string(),
  canGenerateFinal: z.boolean(),
  evidencePending: z.boolean(),
  issues: z.array(z.string()),
})
export type ReportPreviewResponse = z.infer<typeof reportPreviewResponseSchema>

export const exportJobDtoSchema = z.object({
  id: entityIdSchema,
  kind: exportJobKindSchema,
  status: exportJobStatusSchema,
  contentCompleteness: z.enum(['complete', 'partial']).nullable(),
  progress: z.string().nullable(),
  error: z.string().nullable(),
  artifactIds: z.array(entityIdSchema),
  artifacts: z.array(z.lazy(() => artifactDtoSchema)).optional(),
  reportId: entityIdSchema.nullable().optional(),
  reportRevisionId: entityIdSchema.nullable().optional(),
  retryCount: z.number().int().nonnegative().optional(),
  deadlineAt: utcInstantSchema.nullable().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ExportJobDto = z.infer<typeof exportJobDtoSchema>

export const artifactDtoSchema = z.object({
  id: entityIdSchema,
  kind: artifactKindSchema,
  fileName: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative().nullable(),
  digest: z.string().nullable(),
  retainUntil: utcInstantSchema,
  available: z.boolean(),
})
export type ArtifactDto = z.infer<typeof artifactDtoSchema>

export const reportMaterialDtoSchema = z.object({
  id: entityIdSchema,
  kind: z.enum(['screenshot', 'logo']),
  evidenceId: entityIdSchema.nullable(),
  artifactId: entityIdSchema.nullable(),
  runId: entityIdSchema.nullable(),
  caption: z.string(),
  digest: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  missingReason: z.string().nullable(),
})
export type ReportMaterialDto = z.infer<typeof reportMaterialDtoSchema>

export const reportDocumentSchema = z.strictObject({
  identity: z.object({ reportId: entityIdSchema, revisionId: entityIdSchema, revisionNo: z.number().int().positive(), parentRevisionId: entityIdSchema.nullable() }).optional(),
  stage: reportStageSchema,
  title: z.string(),
  subtitle: z.string().optional(),
  organization: z.string().optional(),
  authorDisplayName: z.string().optional(),
  timeZone: z.string(),
  generatedAt: utcInstantSchema,
  asOf: utcInstantSchema,
  source: z.record(z.string(), jsonValueSchema),
  summary: z.record(z.string(), jsonValueSchema),
  sections: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      required: z.boolean(),
      blocks: z.array(z.record(z.string(), jsonValueSchema)),
    }),
  ),
  gaps: z.array(z.string()),
  materials: z.array(reportMaterialDtoSchema).max(REPORT_LIMITS.screenshots + 1).optional(),
  verdict: suiteVerdictSchema.nullable().optional(),
  outcomeStatus: outcomeStatusSchema.nullable().optional(),
  evidenceStatus: runEvidenceStatusSchema.nullable().optional(),
})
export type ReportDocument = z.infer<typeof reportDocumentSchema>

export const reportProfileDtoSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  name: z.string(),
  revision: z.number().int().positive(),
  config: reportConfigSchema,
  updatedAt: utcInstantSchema,
  editScope: z.enum(['scenario', 'suite']).optional(),
})
export type ReportProfileDto = z.infer<typeof reportProfileDtoSchema>

export const saveReportProfileBodySchema = z.strictObject({
  targetId: entityIdSchema,
  name: z.string().trim().min(1).max(128),
  expectedRevision: z.number().int().positive().optional(),
  config: reportConfigSchema,
  editScope: z.enum(['scenario', 'suite']).default('scenario'),
})
export type SaveReportProfileBody = z.infer<typeof saveReportProfileBodySchema>

export const reportProfileListQuerySchema = z.object({ targetId: entityIdSchema, limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() })
export const reportProfileListResponseSchema = z.object({ items: z.array(reportProfileDtoSchema), nextCursor: nextCursorSchema })
export const reportProfileVersionsResponseSchema = z.object({ items: z.array(reportProfileDtoSchema), nextCursor: nextCursorSchema })
export const scenarioReportDefaultsSchema = z.object({ scenarioId: entityIdSchema, profileId: entityIdSchema.nullable(), revision: z.number().int().nonnegative() })
export const saveScenarioReportDefaultsBodySchema = z.strictObject({ profileId: entityIdSchema.nullable(), expectedRevision: z.number().int().nonnegative() })
export const uploadReportAssetBodySchema = z.strictObject({
  targetId: entityIdSchema,
  editScope: z.enum(['scenario', 'suite']),
  fileName: z.string().trim().min(1).max(128),
  contentType: z.enum(['image/png', 'image/jpeg']),
  base64: z.string().min(1).max(Math.ceil(REPORT_LIMITS.logoBytes / 3) * 4),
})
export type UploadReportAssetBody = z.infer<typeof uploadReportAssetBodySchema>
export const retryExportJobBodySchema = z.strictObject({ idempotencyKey: z.string().trim().min(8).max(128) })
