import {
  evaluateAuthVerify,
  resolveVerifyUrl,
  type AuthObservation,
  type FrozenAuthVerification,
  type LoginLocator,
  type TargetAuthProfileDefinition,
} from '@cairn/shared'
import type { BrowserHandle } from './runtime'

function loginLocator(page: BrowserHandle['basePage'], field: LoginLocator) {
  if (field.by === 'id') return page.locator(`#${field.value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1')}`)
  if (field.by === 'name') return page.locator(`[name="${field.value.replace(/"/g, '\\"')}"]`)
  return page.locator(field.value)
}

export type ProfileVerifyResult = {
  observation: AuthObservation
  authValidUntil: Date | null
  authExpirySource: string | null
}

export async function verifyAuthProfile(
  handle: BrowserHandle,
  input: {
    definition: TargetAuthProfileDefinition
    verification: FrozenAuthVerification
  },
): Promise<ProfileVerifyResult> {
  const timeout = input.verification.verifyTimeoutMs
  const url = resolveVerifyUrl(input.definition)
  try {
    if (input.definition.verify.mode === 'http') {
      const response = await handle.context.request.get(url, { timeout })
      const status = response.status()
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        body = await response.text().catch(() => null)
      }
      const observation = evaluateAuthVerify({
        definition: input.definition,
        raw: { kind: 'http', status, body, url },
        expectedIdentity: input.verification.expectedIdentity,
        revision: input.verification.profileRevision,
      })
      return { observation, ...expiryFromBody(input.definition, body) }
    }

    const page = await handle.context.newPage()
    try {
      const deadline = Date.now() + timeout
      const remaining = () => Math.max(1, deadline - Date.now())
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      const success = input.definition.verify.success as { locator?: LoginLocator }
      const failure = input.definition.verify.failure as { locator?: LoginLocator }
      // SPAs often render login markers after DOMContentLoaded. Share one
      // verification deadline across navigation, marker and identity reads.
      const markers = [success.locator, failure.locator].filter((field): field is LoginLocator => Boolean(field))
      if (markers.length && Date.now() < deadline) {
        await Promise.any(markers.map(field => loginLocator(page, field).first()
          .waitFor({ state: 'visible', timeout: remaining() }))).catch(() => undefined)
      }
      const successVisible = success.locator
        ? await loginLocator(page, success.locator)
            .first()
            .isVisible()
            .catch(() => false)
        : false
      const failureVisible = failure.locator
        ? await loginLocator(page, failure.locator)
            .first()
            .isVisible()
            .catch(() => false)
        : false
      let identityText: string | null = null
      if (successVisible && !failureVisible && input.definition.identity?.locator && Date.now() < deadline) {
        identityText = await loginLocator(page, input.definition.identity.locator)
          .first()
          .innerText({ timeout: remaining() })
          .catch(() => null)
      }
      return {
        observation: evaluateAuthVerify({
          definition: input.definition,
          raw: { kind: 'page', successVisible, failureVisible, identityText, url },
          expectedIdentity: input.verification.expectedIdentity,
          revision: input.verification.profileRevision,
        }),
        authValidUntil: null,
        authExpirySource: null,
      }
    } finally {
      await page.close().catch(() => undefined)
    }
  } catch (error) {
    return {
      observation: evaluateAuthVerify({
        definition: input.definition,
        raw: { kind: 'infra', message: error instanceof Error ? error.message : '核验请求失败' },
        expectedIdentity: input.verification.expectedIdentity,
        revision: input.verification.profileRevision,
      }),
      authValidUntil: null,
      authExpirySource: null,
    }
  }
}

function expiryFromBody(
  definition: TargetAuthProfileDefinition,
  body: unknown,
): { authValidUntil: Date | null; authExpirySource: string | null } {
  if (!definition.expiry?.jsonPath || body == null || typeof body !== 'object') {
    return { authValidUntil: null, authExpirySource: null }
  }
  const parts = definition.expiry.jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)
  let current: unknown = body
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return { authValidUntil: null, authExpirySource: null }
    current = (current as Record<string, unknown>)[part]
  }
  if (typeof current !== 'string' && typeof current !== 'number') {
    return { authValidUntil: null, authExpirySource: null }
  }
  const parsed = new Date(current)
  if (Number.isNaN(parsed.getTime())) return { authValidUntil: null, authExpirySource: null }
  return { authValidUntil: parsed, authExpirySource: 'target_expiry' }
}
