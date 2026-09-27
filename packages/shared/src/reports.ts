import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { runEvidenceStatusSchema } from './evidence.js'
import { outcomeStatusSchema } from './outcome.js'
import { deriveRunOutputStatus, runFindingSchema } from './run-output.js'
import { suiteVerdictSchema } from './suite-verdict.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type JsonValue } from './wire.js'
import { REPORT_TITLE_CATALOG, reportTitleSources, type ReportTitleSource } from './report-title-template.js'
export { REPORT_TITLE_CATALOG, parseReportTitle, reportTitleSources, renderReportTitleV2, type ReportTitleSource, type ReportTitleSegment } from './report-title-template.js'

export const EXPORT_ARTIFACTS_PROTOCOL = 'export-artifacts@2' as const
export const REPORT_RENDER_VERSION = 'report-render@10' as const
export const REPORT_TEMPLATE_VERSION = 'report-template@1' as const
export const REPORT_AI_PROMPT_VERSION = 'v1' as const

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

export const REPORT_FORMATS = ['html'] as const
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

export const ARTIFACT_KINDS = ['brand_logo', 'report_material', 'report_html', 'report_bundle'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]
export const artifactKindSchema = z.enum(ARTIFACT_KINDS)

export const OBJECT_OWNER_KINDS = ['run', 'artifact', 'fixture'] as const
export type ObjectOwnerKind = (typeof OBJECT_OWNER_KINDS)[number]
export const objectOwnerKindSchema = z.enum(OBJECT_OWNER_KINDS)

export const REPORT_TITLE_VARIABLES = REPORT_TITLE_CATALOG.map((item) => item.key)
export type ReportTitleVariable = (typeof REPORT_TITLE_VARIABLES)[number]

export const SCREENSHOT_SCOPES = ['anomalies', 'selected', 'none'] as const
export type ScreenshotScope = (typeof SCREENSHOT_SCOPES)[number]
export const screenshotScopeSchema = z.enum(SCREENSHOT_SCOPES)

export const reportConfigSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  titleSyntaxVersion: z.literal(2).optional(),
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
export const reportConfigOverrideSchema = reportConfigSchema.partial().omit({ titleSyntaxVersion: true }).extend({
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

/** Preserve v1 templates' permissive brace semantics when displaying existing bindings. */
export function reportConfigTitleSources(config: ReportConfig): ReportTitleSource[] {
  if (config.titleSyntaxVersion === 2) return reportTitleSources(config.title)
  const sources: ReportTitleSource[] = []
  for (const source of ['RUN', 'SUITE_RUN'] as const) {
    const vars: Partial<Record<ReportTitleVariable, string>> = {
      systemName: 'x', executedDate: 'x', executedRange: 'x', runNumber: 'x',
      ...(source === 'RUN' ? { scenarioName: 'x' } : { suiteName: 'x' }),
    }
    try {
      substituteReportTitle(config.title, vars)
      if (![...config.title.matchAll(/\{([A-Za-z]+)\}/g)].some((match) => vars[match[1] as ReportTitleVariable] === undefined)) sources.push(source)
    } catch { /* Existing invalid templates remain visible as repair targets. */ }
  }
  return sources
}

export function sanitizeReportFileName(input: string): string {
  const cleaned = input.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim()
  return Array.from(cleaned).slice(0, 80).join('') || 'report'
}

export function contentDispositionAttachment(fileName: string): string {
  const extension = fileName.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ''
  const safe = extension
    ? `${Array.from(sanitizeReportFileName(fileName.slice(0, -extension.length))).slice(0, 80 - extension.length).join('')}${extension}`
    : sanitizeReportFileName(fileName)
  const ext = safe.includes('.') ? `.${safe.split('.').pop()}` : ''
  const ascii = /^[\x20-\x7e]+$/.test(safe) ? safe.replace(/\\/g, '_') : `report${ext.replace(/[^\x20-\x7e]/g, '')}`
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

export const suiteSummaryBlockSchema = z.strictObject({
  type: z.literal('suite_business_summary'),
  /** 全部业务结果已判定时的评分；未判定或跳过时不得给出满分。 */
  healthScore: z.number().int().min(0).max(100).nullable(),
  healthGrade: z.enum(['EXCELLENT', 'GOOD', 'FAIR', 'POOR']).nullable(),
  /** 核心统计 */
  totalCount: z.number().int(),
  normalCount: z.number().int(),
  warningCount: z.number().int(),
  anomalousCount: z.number().int(),
  skippedCount: z.number().int(),
  /** 旧报告没有此字段；解析历史封存文档时按零处理。 */
  undeterminedCount: z.number().int().nonnegative().default(0),
  /** 耗时对比 */
  wallClockMs: z.number().int(),
  childDurationMs: z.number().int(),
  savedPercent: z.number().int().min(0).max(100),
  /** 业务汇总宽表行集合（直接汇集各子场景的 RunOutput.dataRow / metrics） */
  gridRows: z.array(
    z.strictObject({
      ordinal: z.number().int(),
      memberId: z.string(),
      displayName: z.string(),
      scenarioName: z.string(),
      status: z.enum(['NORMAL', 'WARNING', 'ANOMALOUS', 'UNDETERMINED', 'SKIPPED']),
      summary: z.string(),
      metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      dataRow: z.record(z.string(), jsonValueSchema),
      durationMs: z.number().int().nullable(),
      hasFindings: z.boolean(),
      originalRunId: z.string().nullable().optional(),
      rerunCount: z.number().int().optional(),
      stageId: z.string().nullable().optional(),
      stageOrdinal: z.number().int().optional(),
    }),
  ),
  /** 汇总所有子场景抛出的 Findings 集合，用于 L2 异常画廊呈现 */
  aggregatedFindings: z.array(
    runFindingSchema.extend({
      memberId: z.string(),
      displayName: z.string(),
    }),
  ),
})
export type SuiteSummaryBlock = z.infer<typeof suiteSummaryBlockSchema>
export type SuiteGridRow = SuiteSummaryBlock['gridRows'][number]
export type SuiteAggregatedFinding = SuiteSummaryBlock['aggregatedFindings'][number]

/**
 * 历史报告的汇总块可能把未评估成员写为 NORMAL。只投影展示数据，不修改封存文档。
 * 来源快照缺失时保留原行并交由界面明确标注旧版分类不可复核。
 */
export function projectSuiteSummaryForDisplay(
  block: SuiteSummaryBlock,
  source: Record<string, JsonValue>,
): { summary: SuiteSummaryBlock; unverifiedCount: number; reclassifiedCount: number } {
  const sourceItems = Array.isArray(source.items) ? source.items : []
  const byMemberId = new Map<string, Record<string, JsonValue>>()
  for (const value of sourceItems) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.memberId === 'string') {
      byMemberId.set(value.memberId, value)
    }
  }
  let unverifiedCount = 0
  let reclassifiedCount = 0
  const gridRows = block.gridRows.map((row) => {
    const item = byMemberId.get(row.memberId)
    if (!item) {
      unverifiedCount++
      return row
    }
    if (item.admission === 'SKIPPED') {
      if (row.status !== 'SKIPPED') reclassifiedCount++
      return { ...row, status: 'SKIPPED' as const }
    }
    const run = item.run && typeof item.run === 'object' && !Array.isArray(item.run) ? item.run : null
    const runStatus = typeof run?.status === 'string' ? run.status : item.runStatus
    const outcomeStatus = typeof run?.outcomeStatus === 'string' ? run.outcomeStatus : item.outcomeStatus
    if (typeof runStatus !== 'string' || typeof outcomeStatus !== 'string') {
      unverifiedCount++
      return row
    }
    const output = run?.output && typeof run.output === 'object' && !Array.isArray(run.output) ? run.output : null
    const rawFindings = output && Array.isArray(output.findings) ? output.findings : []
    const findings = rawFindings.flatMap((finding) => {
      const parsed = runFindingSchema.safeParse(finding)
      return parsed.success ? [parsed.data] : []
    })
    const projectedStatus = item.admission !== 'SETTLED'
      ? 'UNDETERMINED'
      : outcomeStatus === 'FAIL' ? 'ANOMALOUS'
        : runStatus !== 'SUCCEEDED' || !['PASS', 'WARN'].includes(outcomeStatus)
          ? 'UNDETERMINED'
          : deriveRunOutputStatus(runStatus, outcomeStatus, findings)
    if (projectedStatus !== row.status) reclassifiedCount++
    return {
      ...row,
      status: projectedStatus,
      summary: projectedStatus === 'UNDETERMINED' && row.status !== 'UNDETERMINED'
        ? `业务未判定；原摘要：${row.summary || '未提供'}`
        : row.summary,
    }
  })
  const normalCount = gridRows.filter((row) => row.status === 'NORMAL').length
  const warningCount = gridRows.filter((row) => row.status === 'WARNING').length
  const anomalousCount = gridRows.filter((row) => row.status === 'ANOMALOUS').length
  const undeterminedCount = gridRows.filter((row) => row.status === 'UNDETERMINED').length
  const skippedCount = gridRows.filter((row) => row.status === 'SKIPPED').length
  const score = unverifiedCount > 0
    ? { healthScore: null, healthGrade: null }
    : computeSuiteHealthScore({
      totalCount: gridRows.length,
      normalCount,
      warningCount,
      anomalousCount,
      undeterminedCount,
      skippedCount,
    })
  return {
    summary: { ...block, ...score, normalCount, warningCount, anomalousCount, undeterminedCount, skippedCount, gridRows },
    unverifiedCount,
    reclassifiedCount,
  }
}

export const reportTokenPayloadSchema = z.strictObject({
  suiteRunId: entityIdSchema,
  reportRevisionId: entityIdSchema.optional(),
  exp: z.number().int().positive(),
  scope: z.literal('readonly_report'),
})
export type ReportTokenPayload = z.infer<typeof reportTokenPayloadSchema>

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  const base64 = globalThis.btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) {
    base64 += '='
  }
  const binary = globalThis.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export async function signReportToken(payload: ReportTokenPayload, secret: string): Promise<string> {
  reportTokenPayloadSchema.parse(payload)
  const data = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuffer = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  const sig = toBase64Url(new Uint8Array(sigBuffer))
  return `${data}.${sig}`
}

export async function verifyReportToken(token: string, secret: string): Promise<ReportTokenPayload> {
  const parts = token.split('.')
  if (parts.length !== 2) throw new Error('INVALID_TOKEN_FORMAT')
  const [data, sig] = parts
  if (!data || !sig) throw new Error('INVALID_TOKEN_FORMAT')
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  let sigBytes: Uint8Array
  try {
    sigBytes = fromBase64Url(sig)
  } catch {
    throw new Error('INVALID_TOKEN_FORMAT')
  }
  const valid = await globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as BufferSource,
    new TextEncoder().encode(data),
  )
  if (!valid) throw new Error('INVALID_TOKEN_SIGNATURE')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(data)))
  } catch {
    throw new Error('INVALID_TOKEN_PAYLOAD')
  }
  const payload = reportTokenPayloadSchema.parse(parsed)
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('TOKEN_EXPIRED')
  }
  return payload
}

export const HEALTH_GRADE_LABELS: Record<'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR', string> = {
  EXCELLENT: '优',
  GOOD: '良',
  FAIR: '中',
  POOR: '差',
}

export const SUITE_GRID_STATUS_LABELS: Record<'NORMAL' | 'WARNING' | 'ANOMALOUS' | 'UNDETERMINED' | 'SKIPPED', string> = {
  NORMAL: '正常',
  WARNING: '警告',
  ANOMALOUS: '异常',
  UNDETERMINED: '未判定',
  SKIPPED: '已跳过',
}

export function computeSuiteHealthScore(counts: {
  totalCount: number
  normalCount: number
  warningCount: number
  anomalousCount: number
  skippedCount?: number
  undeterminedCount?: number
}): { healthScore: number | null; healthGrade: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' | null } {
  if (counts.totalCount <= 0) {
    return { healthScore: null, healthGrade: null }
  }
  const evaluated = counts.normalCount + counts.warningCount + counts.anomalousCount
  if (evaluated !== counts.totalCount || (counts.skippedCount ?? 0) > 0 || (counts.undeterminedCount ?? 0) > 0) {
    return { healthScore: null, healthGrade: null }
  }
  const weighted = Math.round(
    (counts.normalCount * 100 + counts.warningCount * 60) / evaluated,
  )
  // 聚合异常不能被大量正常项平均成「优」；警告也不应得到满分评级。
  const capped = counts.anomalousCount > 0
    ? Math.min(weighted, 59)
    : counts.warningCount > 0 ? Math.min(weighted, 89) : weighted
  const healthScore = Math.max(0, Math.min(100, capped))
  let healthGrade: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR' = 'POOR'
  if (healthScore >= 90) healthGrade = 'EXCELLENT'
  else if (healthScore >= 75) healthGrade = 'GOOD'
  else if (healthScore >= 60) healthGrade = 'FAIR'
  return { healthScore, healthGrade }
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

export const reportAiJobStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped'])
export type ReportAiJobStatus = z.infer<typeof reportAiJobStatusSchema>

export const reportAiJobDtoSchema = z.object({
  id: entityIdSchema,
  reportId: entityIdSchema,
  baseRevisionId: entityIdSchema,
  status: reportAiJobStatusSchema,
  model: z.string().nullable().optional(),
  promptVersion: z.string().nullable().optional(),
  inputDigest: z.string().nullable().optional(),
  tokenUsage: z.object({
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  error: z.string().nullable().optional(),
  aiRevisionId: entityIdSchema.nullable().optional(),
  interpretation: z.lazy(() => reportAiInterpretationSchema).nullable().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type ReportAiJobDto = z.infer<typeof reportAiJobDtoSchema>

export const reportDtoSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  subject: reportSubjectSchema,
  currentRevision: reportRevisionDtoSchema.nullable(),
  aiJob: reportAiJobDtoSchema.nullable().optional(),
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
  formats: z.array(reportFormatSchema).min(1).max(1),
  idempotencyKey: z.string().trim().min(8).max(128),
})
export type ExportReportBody = z.infer<typeof exportReportBodySchema>

export const createReportBundleBodySchema = z.strictObject({
  reportRevisionId: entityIdSchema,
  formats: z.array(reportFormatSchema).min(1).max(1),
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

export const reportAiCitationSchema = z.strictObject({
  statement: z.string().max(512),
  citationIds: z.array(z.string().max(128)).max(16),
})
export type ReportAiCitation = z.infer<typeof reportAiCitationSchema>

export const reportAiHypothesisSchema = z.strictObject({
  cause: z.string().max(512),
  likelihood: z.enum(['high', 'medium', 'low']),
  basis: z.string().max(512),
})
export type ReportAiHypothesis = z.infer<typeof reportAiHypothesisSchema>

export const reportAiInterpretationSchema = z.strictObject({
  model: z.string().max(128),
  generatedAt: utcInstantSchema,
  status: z.enum(['conclusive', 'inconclusive']),
  observation: z.string().max(2048),
  findings: z.array(reportAiCitationSchema).max(16),
  hypotheses: z.array(reportAiHypothesisSchema).max(8),
  suggestions: z.array(z.string().max(512)).max(8),
})
export type ReportAiInterpretation = z.infer<typeof reportAiInterpretationSchema>

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
  aiInterpretation: reportAiInterpretationSchema.optional(),
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

import {
  outputPolicySchema,
  type OutputPolicy,
  RUN_REPORT_STATUSES,
  type RunReportStatus,
  runReportStatusSchema,
} from './reports-policy.js'
export {
  outputPolicySchema,
  type OutputPolicy,
  RUN_REPORT_STATUSES,
  type RunReportStatus,
  runReportStatusSchema,
}

export const REPORT_TRIGGER_STATUSES = ['pending', 'processing', 'created', 'skipped', 'failed'] as const
export type ReportTriggerStatus = (typeof REPORT_TRIGGER_STATUSES)[number]
export const reportTriggerStatusSchema = z.enum(REPORT_TRIGGER_STATUSES)

export const reportProfileListQuerySchema = z.object({ targetId: entityIdSchema, limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() })
export const reportProfileListResponseSchema = z.object({ items: z.array(reportProfileDtoSchema), nextCursor: nextCursorSchema })
export const reportProfileVersionsResponseSchema = z.object({ items: z.array(reportProfileDtoSchema), nextCursor: nextCursorSchema })
export const scenarioReportDefaultsSchema = z.object({ scenarioId: entityIdSchema, profileId: entityIdSchema.nullable(), revision: z.number().int().nonnegative(), outputPolicy: outputPolicySchema.optional() })
export const saveScenarioReportDefaultsBodySchema = z.strictObject({ profileId: entityIdSchema.nullable(), expectedRevision: z.number().int().nonnegative(), outputPolicy: outputPolicySchema.optional() })
export const uploadReportAssetBodySchema = z.strictObject({
  targetId: entityIdSchema,
  editScope: z.enum(['scenario', 'suite']),
  fileName: z.string().trim().min(1).max(128),
  contentType: z.enum(['image/png', 'image/jpeg']),
  base64: z.string().min(1).max(Math.ceil(REPORT_LIMITS.logoBytes / 3) * 4),
})
export const uploadReportAssetBodySchema_type = uploadReportAssetBodySchema
export type UploadReportAssetBody = z.infer<typeof uploadReportAssetBodySchema>
export const retryExportJobBodySchema = z.strictObject({ idempotencyKey: z.string().trim().min(8).max(128) })
