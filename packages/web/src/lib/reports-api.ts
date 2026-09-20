import { z } from 'zod'
import {
  createReportBodySchema,
  createReportRevisionBodySchema,
  exportJobDtoSchema,
  exportReportBodySchema,
  reportDtoSchema,
  reportListResponseSchema,
  reportPreviewResponseSchema,
  deletePreviewResponseSchema,
  type CreateReportBody,
  type CreateReportRevisionBody,
  type ExportReportBody,
  type ReportListQuery,
} from '@cairn/shared'
import {
  reportConfigSchema,
  reportRevisionDtoSchema,
  reportDocumentSchema,
  reportProfileDtoSchema,
  reportProfileListResponseSchema,
  scenarioReportDefaultsSchema as scenarioReportDefaultsDtoSchema,
  type ReportSubject,
  type SaveReportProfileBody,
  type CreateReportBundleBody,
  type DeriveMemberReportBody,
} from '@cairn/shared'
import { apiFetch, apiFetchBlob, toQueryString } from '@/lib/api-client'

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
export const fetchReportSourceOptions = (subject: ReportSubject) =>
  apiFetch(
    `/api/reports/source-options${toQueryString(subject)}`,
    z.object({
      targetId: z.string(),
      config: reportConfigSchema,
      canGenerateFinal: z.boolean(),
      screenshots: z.array(
        z.object({
          evidenceId: z.string(),
          caption: z.string(),
          status: z.string(),
          anomalous: z.boolean(),
        })
      ),
    })
  )
export const fetchReportRevisions = (id: string, cursor?: string) =>
  apiFetch(
    `/api/reports/${id}/revisions${toQueryString({ cursor })}`,
    z.object({
      items: z.array(reportRevisionDtoSchema),
      nextCursor: z.string().nullable(),
    })
  )
export const fetchReportRevision = (id: string, revision: string) =>
  apiFetch(
    `/api/reports/${id}/revisions/${revision}`,
    z.object({
      report: reportDtoSchema,
      revision: reportRevisionDtoSchema,
      document: reportDocumentSchema.nullable(),
    })
  )
export const fetchReportJobs = (id: string, cursor?: string) =>
  apiFetch(
    `/api/reports/${id}/export-jobs${toQueryString({ cursor })}`,
    z.object({
      items: z.array(exportJobDtoSchema),
      nextCursor: z.string().nullable(),
    })
  )
export const cancelReportJob = (id: string) =>
  apiFetch(`/api/export-jobs/${id}/cancel`, exportJobDtoSchema, post({}))
export const retryReportJob = (id: string, idempotencyKey: string) =>
  apiFetch(
    `/api/export-jobs/${id}/retry`,
    exportJobDtoSchema,
    post({ idempotencyKey })
  )
export const createReportBundle = (body: CreateReportBundleBody) =>
  apiFetch('/api/report-bundles', exportJobDtoSchema, post(body))
export const deriveMemberReport = (
  id: string,
  revision: string,
  body: DeriveMemberReportBody
) =>
  apiFetch(
    `/api/reports/${id}/revisions/${revision}/members`,
    reportDtoSchema,
    post(body)
  )
export const fetchReportProfiles = (targetId: string, cursor?: string) =>
  apiFetch(
    `/api/report-profiles${toQueryString({ targetId, cursor, limit: 100 })}`,
    reportProfileListResponseSchema
  )
export const fetchReportProfile = (id: string) =>
  apiFetch(`/api/report-profiles/${id}`, reportProfileDtoSchema)
export const fetchReportProfileVersions = (id: string, cursor?: string) =>
  apiFetch(
    `/api/report-profiles/${id}/versions${toQueryString({ cursor })}`,
    z.object({
      items: z.array(reportProfileDtoSchema),
      nextCursor: z.string().nullable(),
    })
  )
export const saveReportProfile = (
  id: string | null,
  body: SaveReportProfileBody
) =>
  apiFetch(
    id ? `/api/report-profiles/${id}/versions` : '/api/report-profiles',
    reportProfileDtoSchema,
    post(body)
  )
export const fetchScenarioReportDefaults = (id: string) =>
  apiFetch(
    `/api/scenarios/${id}/report-defaults`,
    scenarioReportDefaultsDtoSchema
  )
export const saveScenarioReportDefaults = (
  id: string,
  body: { profileId: string | null; expectedRevision: number }
) =>
  apiFetch(
    `/api/scenarios/${id}/report-defaults`,
    scenarioReportDefaultsDtoSchema,
    post(body)
  )
export const uploadReportLogo = (body: {
  targetId: string
  editScope: 'scenario' | 'suite'
  fileName: string
  contentType: 'image/png' | 'image/jpeg'
  base64: string
}) =>
  apiFetch(
    '/api/report-assets',
    z.object({ artifactId: z.string() }),
    post(body)
  )

export function fetchReports(query?: Partial<ReportListQuery>) {
  return apiFetch(
    `/api/reports${toQueryString(query)}`,
    reportListResponseSchema
  )
}

export function fetchReport(reportId: string) {
  return apiFetch(`/api/reports/${reportId}`, reportDtoSchema)
}

export const previewDeleteReport = (reportId: string) =>
  apiFetch(
    `/api/reports/${reportId}/delete-preview`,
    deletePreviewResponseSchema,
    post({})
  )
export const deleteReport = (reportId: string) =>
  apiFetch(
    `/api/reports/${reportId}/delete`,
    z.object({ id: z.string(), deleted: z.boolean() }),
    post({})
  )

export function previewReport(body: CreateReportBody) {
  return apiFetch('/api/reports/preview', reportPreviewResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createReportBodySchema.parse(body)),
  })
}

export function createReport(body: CreateReportBody) {
  return apiFetch('/api/reports', reportDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createReportBodySchema.parse(body)),
  })
}

export function createReportRevision(
  reportId: string,
  body: CreateReportRevisionBody
) {
  return apiFetch(`/api/reports/${reportId}/revisions`, reportDtoSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createReportRevisionBodySchema.parse(body)),
  })
}

export function exportReport(
  reportId: string,
  revisionId: string,
  body: ExportReportBody
) {
  return apiFetch(
    `/api/reports/${reportId}/revisions/${revisionId}/export`,
    exportJobDtoSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportReportBodySchema.parse(body)),
    }
  )
}

export function fetchExportJob(jobId: string) {
  return apiFetch(`/api/export-jobs/${jobId}`, exportJobDtoSchema)
}

export function downloadArtifact(artifactId: string) {
  return apiFetchBlob(`/api/artifacts/${artifactId}/content`)
}
