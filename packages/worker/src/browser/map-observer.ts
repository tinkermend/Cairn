import { randomUUID } from 'node:crypto'
import {
  mapGapObservation,
  mapObservationShell,
  mapRunFactKey,
  type MapObservation,
} from '@cairn/shared'
import type { PassiveMapCaptureInput, PassiveMapObservationPort } from '../engine/ports.js'
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

function toObservation(input: PassiveMapCaptureInput, inspect: SurfaceInspect): MapObservation {
  const classified = classifySurface(inspect)
  const key = mapRunFactKey({
    runId: input.runId,
    attemptId: input.attemptId,
    phase: input.phase,
  })
  if (classified.reason) {
    return mapGapObservation({
      id: randomUUID(),
      targetId: input.targetId,
      sourceType: input.sourceType,
      sourceRef: {
        sourceType: input.sourceType,
        runId: input.runId,
        stepRunId: input.stepRunId,
        attemptId: input.attemptId,
      },
      phase: input.phase,
      dedupeKey: key,
      collectorVersion: input.policy.collectorVersion,
      conditionSnapshot: input.condition,
      reason: classified.reason,
      stateSummary: classified.stateSummary,
      topUrlPattern: topUrlPattern(inspect.url),
    })
  }
  return mapObservationShell({
    id: randomUUID(),
    targetId: input.targetId,
    sourceType: input.sourceType,
    sourceRef: {
      sourceType: input.sourceType,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
    },
    phase: input.phase,
    dedupeKey: key,
    collectorVersion: input.policy.collectorVersion,
    conditionSnapshot: input.condition,
    captureStatus: 'observed',
    completeness: 'partial',
    truncated: true,
    topUrlPattern: topUrlPattern(inspect.url),
    originChain: classified.originChain,
    surfaceCapability: classified.capability,
    stateSummary: classified.stateSummary,
    structuralSummary: { nodeCount: 0, truncated: true },
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
            sourceRef: {
              sourceType: input.sourceType,
              runId: input.runId,
              stepRunId: input.stepRunId,
              attemptId: input.attemptId,
            },
            phase: input.phase,
            dedupeKey: mapRunFactKey({
              runId: input.runId,
              attemptId: input.attemptId,
              phase: input.phase,
            }),
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
            sourceRef: {
              sourceType: input.sourceType,
              runId: input.runId,
              stepRunId: input.stepRunId,
              attemptId: input.attemptId,
            },
            phase: input.phase,
            dedupeKey: mapRunFactKey({
              runId: input.runId,
              attemptId: input.attemptId,
              phase: input.phase,
            }),
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
            sourceRef: {
              sourceType: input.sourceType,
              runId: input.runId,
              stepRunId: input.stepRunId,
              attemptId: input.attemptId,
            },
            phase: input.phase,
            dedupeKey: mapRunFactKey({
              runId: input.runId,
              attemptId: input.attemptId,
              phase: input.phase,
            }),
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
      return {
        observation: toObservation(input, {
          url,
          origin,
          frames,
          empty: false,
          ready: true,
        }),
      }
    },
  }
}
