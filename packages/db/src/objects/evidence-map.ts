import type { EvidenceRow } from '../records.js'
import { RUNTIME_SCHEMA_VERSION, evidenceMetadataSchema, type EvidenceMetadata } from '@cairn/shared'


export function toEvidenceMetadata(row: EvidenceRow): EvidenceMetadata {
  return evidenceMetadataSchema.parse({
    schemaVersion: row.schemaVersion ?? RUNTIME_SCHEMA_VERSION,
    id: row.id,
    runId: row.runId,
    stepRunId: row.stepRunId ?? undefined,
    attemptId: row.attemptId ?? undefined,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    objectKey: row.objectKey ?? undefined,
    contentType: row.contentType ?? undefined,
    byteSize: row.byteSize ?? undefined,
    digest: row.digest ?? undefined,
    missingReason: row.missingReason ?? undefined,
    uploadAttempts: row.uploadAttempts,
    externalAccess: row.externalAccess === 1,
    payload: row.payload ?? undefined,
  })
}
