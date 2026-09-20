import { randomUUID } from 'node:crypto'
import {
  mapGapObservation,
  mapObservationShell,
  mapRunFactKey,
  type MapObservation,
} from '@cairn/shared'
import type { PassiveMapCaptureInput, PassiveMapObservationPort } from '../engine/ports.js'
import {
  applyCollectedSurface,
  collectAuthorizedSurface,
  capturePolicyNodeLimit,
  isHardSurfaceGap,
  type CollectedSurface,
} from '../map/surface-collect.js'
import { classifySurface, originOf, type SurfaceInspect } from '../map/surface-state.js'
import type { BrowserSessionManager } from './session-manager.js'

function topUrlPattern(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    parsed.hash = ''
    return parsed.toString().slice(0, 512)
  } catch {
    return 'https://unknown.invalid/'
  }
}

function sourceRef(input: PassiveMapCaptureInput) {
  return {
    sourceType: input.sourceType,
    runId: input.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
  } as const
}

function factKey(input: PassiveMapCaptureInput) {
  return mapRunFactKey({
    runId: input.runId,
    attemptId: input.attemptId,
    phase: input.phase,
  })
}

function toObservation(
  input: PassiveMapCaptureInput,
  inspect: SurfaceInspect,
  extras?: { collected?: CollectedSurface; collectFailed?: boolean },
): MapObservation {
  const classified = classifySurface(inspect)
  const key = factKey(input)
  const framesBlocked = inspect.frames.some((frame) => !frame.authorized)
  if (isHardSurfaceGap(classified.reason)) {
    return mapGapObservation({
      id: randomUUID(),
      targetId: input.targetId,
      sourceType: input.sourceType,
      sourceRef: sourceRef(input),
      phase: input.phase,
      dedupeKey: key,
      collectorVersion: input.policy.collectorVersion,
      conditionSnapshot: input.condition,
      reason: classified.reason,
      stateSummary: classified.stateSummary,
      topUrlPattern: topUrlPattern(inspect.url),
    })
  }
  const fields = applyCollectedSurface({
    collected: extras?.collected,
    condition: input.condition,
    capability: classified.capability,
    stateSummary: classified.stateSummary,
    collectFailed: extras?.collectFailed,
    framesBlocked,
    maxBytes: input.policy.maxBytes,
  })
  return mapObservationShell({
    id: randomUUID(),
    targetId: input.targetId,
    sourceType: input.sourceType,
    sourceRef: sourceRef(input),
    phase: input.phase,
    dedupeKey: key,
    collectorVersion: input.policy.collectorVersion,
    conditionSnapshot: fields.conditionSnapshot,
    captureStatus: 'observed',
    completeness: fields.completeness,
    truncated: fields.truncated,
    missingReasons: fields.missingReasons,
    topUrlPattern: topUrlPattern(inspect.url),
    originChain: classified.originChain,
    surfaceCapability: fields.surfaceCapability,
    regionRefs: fields.regionRefs,
    nodeSetKind: fields.nodeSetKind,
    stateSummary: fields.stateSummary,
    semanticSummary: fields.semanticSummary,
    structuralSummary: fields.structuralSummary,
  })
}

export function createPassiveMapObservationPort(manager: BrowserSessionManager): PassiveMapObservationPort {
  return {
    async capture(input) {
      if (input.policy.captureScreenshots) {
        return {
          gap: mapGapObservation({
            id: randomUUID(),
            targetId: input.targetId,
            sourceType: input.sourceType,
            sourceRef: sourceRef(input),
            phase: input.phase,
            dedupeKey: factKey(input),
            collectorVersion: input.policy.collectorVersion,
            conditionSnapshot: input.condition,
            reason: 'CAPABILITY_MISSING',
          }),
        }
      }
      if (!input.sessionGrant) {
        return {
          gap: mapGapObservation({
            id: randomUUID(),
            targetId: input.targetId,
            sourceType: input.sourceType,
            sourceRef: sourceRef(input),
            phase: input.phase,
            dedupeKey: factKey(input),
            collectorVersion: input.policy.collectorVersion,
            conditionSnapshot: input.condition,
            reason: 'NOT_APPLICABLE',
          }),
        }
      }
      const page = manager.pageForGrant(input.sessionGrant)
      if (!page) {
        return {
          gap: mapGapObservation({
            id: randomUUID(),
            targetId: input.targetId,
            sourceType: input.sourceType,
            sourceRef: sourceRef(input),
            phase: input.phase,
            dedupeKey: factKey(input),
            collectorVersion: input.policy.collectorVersion,
            conditionSnapshot: input.condition,
            reason: 'CAPABILITY_MISSING',
          }),
        }
      }
      const url = typeof page.url === 'function' ? page.url() : ''
      const origin = originOf(url)
      const allowed = new Set(input.allowedOrigins ?? [])
      const frames: SurfaceInspect['frames'] = []
      const childFrames = typeof page.frames === 'function' ? page.frames() : []
      for (const frame of childFrames) {
        const frameUrl = typeof frame.url === 'function' ? frame.url() : ''
        const frameOrigin = originOf(frameUrl)
        frames.push({
          origin: frameOrigin,
          authorized: allowed.size === 0 || allowed.has(frameOrigin) || frameOrigin === origin,
        })
      }

      const inspect: SurfaceInspect = { url, origin, frames }
      if (isHardSurfaceGap(classifySurface(inspect).reason)) {
        return { observation: toObservation(input, inspect) }
      }

      let collected: CollectedSurface | undefined
      let collectFailed = false
      if (typeof page.evaluate === 'function') {
        try {
          collected = (await page.evaluate(collectAuthorizedSurface, capturePolicyNodeLimit(input.policy))) as CollectedSurface
        } catch {
          collectFailed = true
        }
      } else {
        collectFailed = true
      }

      return {
        observation: toObservation(
          input,
          {
            ...inspect,
            empty: collected?.empty,
            ready: collected?.ready ?? true,
            loading: collected?.loading,
            canvas: collected?.canvas,
            closedShadow: collected?.closedShadow,
          },
          { collected, collectFailed },
        ),
      }
    },
  }
}
