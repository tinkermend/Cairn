import { unlink } from 'node:fs/promises'
import type {
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
  EvidenceObjectPointer,
  JsonValue,
  PageRef,
  RunGrant,
  RunSnapshot,
  SessionGrant,
  ScreenshotRole,
} from '@cairn/shared'
import {
  OBJECT_MISSING_REASONS,
  requiredScreenshotRole,
  shouldCaptureEvidence,
  writeEvidenceArtifactKey,
} from '@cairn/shared'
import type { ObjectService } from '../objects/object.service'
import type { BrowserPort } from '../engine/ports'
import { BrowserSessionManager, SessionLeaseError } from './session-manager'

export function createBrowserPort(manager: BrowserSessionManager, objects?: ObjectService): BrowserPort {
  return {
    async acquire(run: RunSnapshot, grant: RunGrant, signal?: AbortSignal) {
      return manager.acquire(run, grant, signal)
    },
    async release(grant: SessionGrant, reason: string) {
      try {
        await manager.release(grant.leaseId, reason)
      } catch (error) {
        if (error instanceof SessionLeaseError) throw error
        throw error
      }
    },
    async invalidate(grant: SessionGrant, reason: string) {
      await manager.invalidate(grant, reason)
    },
    async describeHold(runId: string) {
      return manager.describeHoldPage(runId)
    },
    async restoreAuthGate(runId, grant) {
      return manager.restoreAuthGateFromCheckpoint(runId, grant)
    },
    async recoverAuth(grant, input) {
      return manager.recoverAuth(grant, input)
    },
    async sampleMapConditions(grant, signal) {
      return manager.sampleMapConditions(grant, signal)
    },
    async probeErrorSurface(grant, signal) {
      return manager.probeErrorSurface(grant, signal)
    },
    async collectExploration(grant, options, signal) {
      return manager.collectExploration(grant, options, signal)
    },
    async installExploreGuard(grant, options) {
      return manager.installExploreGuard(grant, options)
    },
    async ingestMapSlice(grant, input) {
      return manager.ingestMapSlice(grant, input)
    },
    async captureFinalScreenshot(grant, evidence) {
      if (!objects) return
      const page = manager.pageForGrant(grant)
      if (!page) return
      const sensitiveSelectors = evidence.sensitiveSelectors ?? []
      const viewport = evidence.screenshotViewport ?? 'full_page'
      const { pageHasSensitiveContent, screenshotPage } = await import('./runtime.js')
      const sensitive = await pageHasSensitiveContent(page, sensitiveSelectors)
      const bytes = await screenshotPage(page, {
        fullPage: viewport === 'full_page',
        selectors: sensitiveSelectors,
      }).catch(() => undefined)
      if (!bytes || bytes.byteLength === 0) return

      await attachObjectEvidence({
        type: 'screenshot',
        bytes,
        contentType: 'image/png',
        objects,
        evidence: {
          runId: evidence.runId,
        } as any,
        artifactKey: writeEvidenceArtifactKey({
          type: 'screenshot',
          role: 'final',
        }),
        payload: screenshotPayload('final', viewport, new Date().toISOString(), undefined, {
          sensitive,
        }),
        emptyReason: OBJECT_MISSING_REASONS.captureFailed,
      })
    },
    async captureFailureScreenshot(grant, evidence, signal) {
      if (!objects || signal?.aborted) return undefined
      if (!shouldCaptureEvidence(evidence.screenshot ?? 'on_failure', true)) return undefined
      const page = manager.pageForGrant(grant)
      if (!page) return undefined
      const sensitiveSelectors = evidence.sensitiveSelectors ?? []
      const viewport = evidence.screenshotViewport ?? 'full_page'
      const { pageHasSensitiveContent, screenshotPage } = await import('./runtime.js')
      const { diagnoseScreenshot } = await import('./screenshot-quality.js')
      const bytes = await screenshotPage(page, {
        fullPage: viewport === 'full_page',
        selectors: sensitiveSelectors,
      }).catch(() => undefined)
      if (!bytes || bytes.byteLength === 0) return undefined
      const [sensitive, diagnosis] = await Promise.all([
        pageHasSensitiveContent(page, sensitiveSelectors).catch(() => true),
        diagnoseScreenshot(page, bytes).catch(() => undefined),
      ])
      return attachObjectEvidence({
        type: 'screenshot',
        bytes,
        contentType: 'image/png',
        objects,
        evidence,
        retainUntil: evidence.screenshotRetainUntil,
        emptyReason: OBJECT_MISSING_REASONS.captureFailed,
        artifactKey: writeEvidenceArtifactKey({
          type: 'screenshot',
          attemptId: evidence.attemptId,
          role: 'on_error',
        }),
        payload: screenshotPayload('on_error', viewport, new Date().toISOString(), undefined, {
          diagnosis,
          sensitive,
        }),
      })
    },
    async execute(
      grant: SessionGrant,
      command: BrowserCommand,
      signal?: AbortSignal,
      evidence?: BrowserCommandEvidence,
    ) {
      const raw = await manager.execute(grant, command, signal, evidence)
      const { screenshotBytes, extraShots, faceRole, pageRef, screenshotCapturedAt, screenshotDiagnosis, screenshotSeq, omittedBefore, tracePath, screenshotSensitive, ...result } = raw
      const failed = !result.ok
      const shotMode = evidence?.screenshot ?? 'on_failure'
      const traceMode = evidence?.trace ?? 'off'
      const viewport = evidence?.screenshotViewport ?? 'full_page'
      const role = faceRole ?? requiredScreenshotRole({ failed, commandType: command.type })

      if (shouldCaptureEvidence(shotMode, failed)) {
        for (const extra of extraShots ?? []) {
          await attachObjectEvidence({
            type: 'screenshot',
            bytes: extra.bytes,
            contentType: 'image/png',
            objects,
            evidence,
            retainUntil: evidence?.screenshotRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
            artifactKey: evidence
              ? writeEvidenceArtifactKey({
                  type: 'screenshot',
                  attemptId: evidence.attemptId,
                  role: extra.role,
                  seq: extra.seq,
                })
              : undefined,
            payload: screenshotPayload(extra.role, viewport, extra.capturedAt ?? new Date().toISOString(), extra.pageRef ?? pageRef, {
              seq: extra.seq,
              diagnosis: extra.diagnosis,
            }),
          })
        }
      }

      let screenshot = result.screenshot
      if (shouldCaptureEvidence(shotMode, failed)) {
        screenshot = await attachObjectEvidence({
          type: 'screenshot',
          bytes: screenshotBytes,
          contentType: 'image/png',
          objects,
          evidence,
          retainUntil: evidence?.screenshotRetainUntil,
          emptyReason: OBJECT_MISSING_REASONS.captureFailed,
          artifactKey: evidence
            ? writeEvidenceArtifactKey({
                type: 'screenshot',
                attemptId: evidence.attemptId,
                role,
                seq: screenshotSeq,
              })
            : undefined,
          payload: screenshotPayload(role, viewport, screenshotCapturedAt ?? new Date().toISOString(), pageRef, {
            seq: screenshotSeq,
            diagnosis: screenshotDiagnosis,
            omittedBefore,
            sensitive: screenshotSensitive,
          }),
        })
      }

      let trace = result.trace
      if (tracePath) {
        if (shouldCaptureEvidence(traceMode, failed)) {
          const { readFile } = await import('node:fs/promises')
          const bytes = await readFile(tracePath).catch(() => undefined)
          trace = await attachObjectEvidence({
            type: 'trace',
            bytes,
            contentType: 'application/zip',
            objects,
            evidence,
            retainUntil: evidence?.traceRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
          })
        }
        await unlink(tracePath).catch(() => undefined)
      }

      return { ...result, screenshot, trace }
    },
    async bindResolvedFromPoint(grant, input, signal) {
      const { collectCrossCheckTexts, cssViewportPoint, inspectPointElement, RESOLVED_ATTRIBUTE, resolvedSelector } =
        await import('./resolved-handle.js')
      const scoped = await manager.withManagedPage(grant, undefined, async (page) => {
        signal?.throwIfAborted()
        const point = cssViewportPoint(input.center, input.dpr)
        const inspected = await page.evaluate(
          ({ x, y, token, attr }) => {
            const doc = (globalThis as unknown as { document: any }).document
            const el = doc?.elementFromPoint(x, y)
            if (!el) return { ok: false as const, reason: 'AI_NOT_FOUND' as const }
            if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
              return { ok: false as const, reason: 'FRAME_UNSUPPORTED' as const }
            }
            let ownText = ''
            for (const node of el.childNodes) {
              if (node.nodeType === 3) ownText += node.textContent ?? ''
            }
            const labelledBy = el.getAttribute('aria-labelledby')
            const accessibleName = labelledBy
              ? labelledBy
                  .split(/\s+/)
                  .map((id: string) => doc.getElementById(id)?.textContent?.trim())
                  .filter((item: unknown): item is string => Boolean(item))
                  .join(' ')
              : ''
            el.setAttribute(attr, token)
            return {
              ok: true as const,
              tagName: el.tagName,
              accessibleName,
              ariaLabel: el.getAttribute('aria-label'),
              title: el.getAttribute('title'),
              placeholder: el.getAttribute('placeholder'),
              ownText,
              innerText: el.innerText ?? '',
            }
          },
          { ...point, token: input.token, attr: RESOLVED_ATTRIBUTE },
        )
        if (!inspected.ok) return inspected
        const checked = inspectPointElement({ element: { tagName: inspected.tagName } })
        if (!checked.ok) return checked
        const texts = collectCrossCheckTexts({
          accessibleName: inspected.accessibleName,
          ariaLabel: inspected.ariaLabel,
          title: inspected.title,
          placeholder: inspected.placeholder,
          ownText: inspected.ownText,
          innerText: inspected.innerText,
          container: checked.container,
        })
        const count = await page.locator(resolvedSelector(input.token)).count()
        if (count !== 1) {
          await page
            .evaluate(
              ({ attr, token }) => {
                const doc = (globalThis as unknown as { document: any }).document
                doc?.querySelectorAll(`[${attr}="${token}"]`).forEach((node: any) => node.removeAttribute(attr))
              },
              { attr: RESOLVED_ATTRIBUTE, token: input.token },
            )
            .catch(() => undefined)
          return { ok: false as const, reason: 'AI_AMBIGUOUS_POINT' as const }
        }
        const { generateCandidateFromElement } = await import('./reverse-locator.js')
        const reverse = await generateCandidateFromElement(page, input.token).catch(() => undefined)
        return {
          ok: true as const,
          tagName: checked.tagName,
          texts,
          suggestedCandidate: reverse?.candidate,
        }
      })
      if (!scoped.ok) {
        return { ok: false, reason: 'SURFACE_LOST', message: scoped.error.safeMessage }
      }
      if (!scoped.value.ok) {
        const messages = {
          AI_NOT_FOUND: 'AI 定位点没有对应到页面元素',
          FRAME_UNSUPPORTED: 'AI 定位点落在 iframe，首期不支持',
          AI_AMBIGUOUS_POINT: 'AI 定位点对应了多个元素',
        }
        return { ok: false, reason: scoped.value.reason, message: messages[scoped.value.reason] }
      }
      return {
        ok: true,
        texts: scoped.value.texts,
        tagName: scoped.value.tagName,
        suggestedCandidate: scoped.value.suggestedCandidate,
      }
    },
    async bindResolvedFromCandidate(grant, input, signal) {
      const { collectCrossCheckTexts, inspectPointElement, RESOLVED_ATTRIBUTE, resolvedSelector } =
        await import('./resolved-handle.js')
      const { locatorForCandidate } = await import('./runtime.js')
      const scoped = await manager.withManagedPage(grant, undefined, async (page) => {
        signal?.throwIfAborted()
        const locator = locatorForCandidate(page, input.candidate)
        const count = await locator.count()
        if (count !== 1) return { ok: false as const, reason: count === 0 ? 'AI_NOT_FOUND' as const : 'AI_AMBIGUOUS_POINT' as const }
        if (!await locator.isVisible()) return { ok: false as const, reason: 'AI_NOT_FOUND' as const }
        const inspected = await locator.evaluate((element: any, args) => {
          const doc = (globalThis as unknown as { document: any }).document
          const rect = element.getBoundingClientRect()
          const x = rect.left + rect.width / 2
          const y = rect.top + rect.height / 2
          if (x < 0 || y < 0 || x >= doc.documentElement.clientWidth || y >= doc.documentElement.clientHeight) return null
          const hit = doc.elementFromPoint(x, y)
          if (hit !== element && !element.contains(hit)) return null
          let ownText = ''
          for (const node of element.childNodes) if (node.nodeType === 3) ownText += node.textContent ?? ''
          const labelledBy = element.getAttribute('aria-labelledby')
          const accessibleName = labelledBy
            ? labelledBy.split(/\s+/).map((id: string) => doc.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ')
            : ''
          element.setAttribute(args.attr, args.token)
          return {
            tagName: element.tagName,
            accessibleName,
            ariaLabel: element.getAttribute('aria-label'),
            title: element.getAttribute('title'),
            placeholder: element.getAttribute('placeholder'),
            ownText,
            innerText: element.innerText ?? '',
          }
        }, { attr: RESOLVED_ATTRIBUTE, token: input.token })
        if (!inspected) return { ok: false as const, reason: 'AI_AMBIGUOUS_POINT' as const }
        const checked = inspectPointElement({ element: { tagName: inspected.tagName } })
        if (!checked.ok) return { ok: false as const, reason: checked.reason }
        const texts = collectCrossCheckTexts({
          accessibleName: inspected.accessibleName,
          ariaLabel: inspected.ariaLabel,
          title: inspected.title,
          placeholder: inspected.placeholder,
          ownText: inspected.ownText,
          innerText: inspected.innerText,
          container: checked.container,
        })
        if (await page.locator(resolvedSelector(input.token)).count() !== 1) {
          await locator.evaluate((element: any, attr) => element.removeAttribute(attr), RESOLVED_ATTRIBUTE).catch(() => undefined)
          return { ok: false as const, reason: 'AI_AMBIGUOUS_POINT' as const }
        }
        const { generateCandidateFromElement } = await import('./reverse-locator.js')
        const reverse = await generateCandidateFromElement(page, input.token).catch(() => undefined)
        return { ok: true as const, texts, tagName: checked.tagName, suggestedCandidate: reverse?.candidate }
      })
      if (!scoped.ok) return { ok: false, reason: 'SURFACE_LOST', message: scoped.error.safeMessage }
      if (!scoped.value.ok) return {
        ok: false,
        reason: scoped.value.reason,
        message: scoped.value.reason === 'AI_NOT_FOUND'
          ? '文本模型给出的元素已不存在或不可见'
          : '文本模型给出的元素不唯一、被遮挡或不适合操作',
      }
      return scoped.value
    },
    async clearResolved(grant, token) {
      const { RESOLVED_ATTRIBUTE } = await import('./resolved-handle.js')
      await manager.withManagedPage(grant, undefined, async (page) => {
        await page
          .evaluate(
            ({ attr, value }) => {
              const doc = (globalThis as unknown as { document: any }).document
              doc?.querySelectorAll(`[${attr}="${value}"]`).forEach((node: any) => node.removeAttribute(attr))
            },
            { attr: RESOLVED_ATTRIBUTE, value: token },
          )
          .catch(() => undefined)
      })
    },
  }
}

function screenshotPayload(
  role: ScreenshotRole,
  viewport: 'viewport' | 'full_page',
  capturedAt: string,
  pageRef?: PageRef,
  extra?: {
    seq?: number
    diagnosis?: import('@cairn/shared').ScreenshotDiagnosis
    omittedBefore?: 'initial_blank_page'
    sensitive?: boolean
  },
): JsonValue {
  return {
    role,
    viewport,
    capturedAt,
    ...(pageRef ? { pageRef } : {}),
    ...(extra?.seq ? { seq: extra.seq } : {}),
    ...(extra?.diagnosis ? { diagnosis: extra.diagnosis } : {}),
    ...(extra?.omittedBefore ? { omittedBefore: extra.omittedBefore } : {}),
    ...(extra?.sensitive !== undefined ? { sensitive: extra.sensitive } : {}),
  }
}

export async function attachObjectEvidence(input: {
  type: 'screenshot' | 'trace'
  bytes: Buffer | Uint8Array | undefined
  contentType: string
  objects: ObjectService | undefined
  evidence: BrowserCommandEvidence | undefined
  retainUntil?: string
  emptyReason: string
  artifactKey?: string
  payload?: JsonValue
}): Promise<EvidenceObjectPointer> {
  if (!input.bytes || input.bytes.byteLength === 0) {
    return { missingReason: input.emptyReason }
  }
  if (!input.objects || !input.evidence) {
    return { missingReason: OBJECT_MISSING_REASONS.storeUnavailable }
  }
  try {
    const saved = await input.objects.putObjectEvidence({
      runId: input.evidence.runId,
      stepRunId: input.evidence.stepRunId,
      attemptId: input.evidence.attemptId,
      type: input.type,
      artifactKey: input.artifactKey,
      payload: input.payload,
      body: input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes),
      contentType: input.contentType,
      retainUntil: input.retainUntil ? new Date(input.retainUntil) : undefined,
    })
    if (saved.status === 'missing') {
      return { missingReason: saved.missingReason ?? OBJECT_MISSING_REASONS.storeUnavailable }
    }
    return {
      objectKey: saved.objectKey,
      contentType: saved.contentType,
      byteSize: saved.byteSize,
      digest: saved.digest,
    }
  } catch (error) {
    const tooLarge =
      error && typeof error === 'object' && 'code' in error && error.code === 'OBJECT_TOO_LARGE'
    return {
      missingReason: tooLarge && input.type === 'trace'
        ? OBJECT_MISSING_REASONS.traceTooLarge
        : OBJECT_MISSING_REASONS.storeUnavailable,
    }
  }
}
