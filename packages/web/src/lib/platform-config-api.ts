import {
  platformConfigCurrentSchema,
  platformConfigRestoreBodySchema,
  platformConfigRevisionListSchema,
  platformConfigSecretBodySchema,
  platformConfigSecretResponseSchema,
  platformConfigTestConnectionBodySchema,
  platformConfigTestConnectionResponseSchema,
  platformConfigUpdateBodySchema,
  platformConfigValidateBodySchema,
  type PlatformConfigCurrent,
  type PlatformConfigDocument,
  type PlatformConfigRestoreBody,
  type PlatformConfigRevisionList,
  type PlatformConfigSecretResponse,
  type PlatformConfigTestConnectionBody,
  type PlatformConfigTestConnectionResponse,
  type PlatformConfigUpdateBody,
} from '@cairn/shared'
import { apiFetch } from './api-client'

const post = (body: unknown) => ({
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function fetchPlatformConfig(): Promise<PlatformConfigCurrent> {
  return apiFetch('/api/platform-config', platformConfigCurrentSchema)
}

export function fetchPlatformConfigRevisions(
  cursor?: string,
  limit?: number,
): Promise<PlatformConfigRevisionList> {
  const params = new URLSearchParams()
  if (cursor) params.set('cursor', cursor)
  if (limit) params.set('limit', String(limit))
  const query = params.toString()
  return apiFetch(
    `/api/platform-config/revisions${query ? `?${query}` : ''}`,
    platformConfigRevisionListSchema,
  )
}

export function validatePlatformConfig(document: PlatformConfigDocument) {
  return apiFetch(
    '/api/platform-config/validate',
    platformConfigValidateBodySchema,
    post(platformConfigValidateBodySchema.parse({ document })),
  )
}

export function updatePlatformConfig(body: PlatformConfigUpdateBody): Promise<PlatformConfigCurrent> {
  return apiFetch(
    '/api/platform-config/update',
    platformConfigCurrentSchema,
    post(platformConfigUpdateBodySchema.parse(body)),
  )
}

export function restorePlatformConfig(body: PlatformConfigRestoreBody): Promise<PlatformConfigCurrent> {
  return apiFetch(
    '/api/platform-config/restore',
    platformConfigCurrentSchema,
    post(platformConfigRestoreBodySchema.parse(body)),
  )
}

export function registerPlatformConfigSecret(apiKey: string): Promise<PlatformConfigSecretResponse> {
  return apiFetch(
    '/api/platform-config/secrets',
    platformConfigSecretResponseSchema,
    post(platformConfigSecretBodySchema.parse({ apiKey })),
  )
}

export function testPlatformConfigConnection(
  body: PlatformConfigTestConnectionBody,
): Promise<PlatformConfigTestConnectionResponse> {
  return apiFetch(
    '/api/platform-config/test-connection',
    platformConfigTestConnectionResponseSchema,
    post(platformConfigTestConnectionBodySchema.parse(body)),
  )
}
