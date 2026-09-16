import type { MapMissingReason, MapStateSummary, MapSurfaceCapability } from '@cairn/shared'

export type SurfaceFrame = {
  origin: string
  authorized: boolean
  closedShadow?: boolean
  canvas?: boolean
}

export type SurfaceInspect = {
  url: string
  origin: string
  navigationEpoch?: string
  expectedEpoch?: string
  frames: SurfaceFrame[]
  empty?: boolean
  ready?: boolean
  loading?: boolean
  virtualUnmounted?: boolean
  occluded?: boolean
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'https://unknown.invalid'
  }
}

export function classifySurface(input: SurfaceInspect): {
  capability: MapSurfaceCapability
  reason?: MapMissingReason
  stateSummary: MapStateSummary
  originChain: string[]
  truncated: boolean
} {
  const framesBlocked = input.frames.some((frame) => !frame.authorized)
  const closedShadow = input.frames.some((frame) => frame.closedShadow)
  const canvas = input.frames.some((frame) => frame.canvas)
  const epochChanged =
    input.expectedEpoch !== undefined &&
    input.navigationEpoch !== undefined &&
    input.expectedEpoch !== input.navigationEpoch

  let reason: MapMissingReason | undefined
  if (epochChanged) reason = 'SURFACE_CHANGED'
  else if (framesBlocked || closedShadow || canvas) reason = 'CAPABILITY_MISSING'

  const capability: MapSurfaceCapability = {
    frames: framesBlocked ? 'blocked' : input.frames.length > 0 ? 'ok' : 'unknown',
    a11y: 'unknown',
    canvas: canvas ? 'unsupported' : 'unknown',
    shadow: closedShadow ? 'closed' : 'unknown',
  }

  return {
    capability,
    reason,
    originChain: [input.origin, ...input.frames.map((frame) => frame.origin)].slice(0, 8),
    truncated: true,
    stateSummary: {
      regions: {
        page: {
          empty: input.empty === true,
          ready: input.ready === true,
          loading: input.loading === true,
          virtualUnmounted: input.virtualUnmounted === true,
          occluded: input.occluded === true,
          ...(epochChanged ? { surfaceChanged: true } : {}),
        },
      },
    },
  }
}
