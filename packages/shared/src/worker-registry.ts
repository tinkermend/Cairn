import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { workerStatusSchema } from './run-lease.js'
import { sessionDtoSchema, sessionStatusSchema } from './session.js'
import { utcInstantSchema } from './wire.js'

export const WORKER_NETWORK_MODES = ['local', 'distributed'] as const
export type WorkerNetworkMode = (typeof WORKER_NETWORK_MODES)[number]
export const workerNetworkModeSchema = z.enum(WORKER_NETWORK_MODES)

export const WORKER_ENDPOINT_SOURCES = ['database', 'environment', 'none'] as const
export type WorkerEndpointSource = (typeof WORKER_ENDPOINT_SOURCES)[number]
export const workerEndpointSourceSchema = z.enum(WORKER_ENDPOINT_SOURCES)

export const WORKER_ROUTE_AVAILABILITIES = ['eligible', 'unavailable'] as const
export type WorkerRouteAvailability = (typeof WORKER_ROUTE_AVAILABILITIES)[number]
export const workerRouteAvailabilitySchema = z.enum(WORKER_ROUTE_AVAILABILITIES)

export const WORKER_ROUTE_REASONS = [
  'worker_not_ready',
  'registration_incomplete',
  'heartbeat_expired',
  'endpoint_missing',
  'endpoint_invalid',
] as const
export type WorkerRouteReason = (typeof WORKER_ROUTE_REASONS)[number]
export const workerRouteReasonSchema = z.enum(WORKER_ROUTE_REASONS)

export const WORKER_HANDLE_MISMATCH_STATES = ['unknown', 'none', 'pending', 'persistent'] as const
export type WorkerHandleMismatchState = (typeof WORKER_HANDLE_MISMATCH_STATES)[number]
export const workerHandleMismatchStateSchema = z.enum(WORKER_HANDLE_MISMATCH_STATES)

export const WORKER_DEBUG_PORT = 9222
export const WORKER_FORWARD_CONNECT_TIMEOUT_MS = 3_000
export const WORKER_FORWARD_HEADER_TIMEOUT_MS = 10_000
export const WORKER_FORWARD_AUTH_TIMEOUT_MS = 30_000
export const WORKER_RESULT_UNKNOWN_MESSAGE = '结果未知，请先查看状态'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '*'])

export const workerEndpointMapSchema = z.record(z.string().min(1).max(128), z.string().url())
export type WorkerEndpointMap = z.infer<typeof workerEndpointMapSchema>

export type WorkerEndpointOptions = {
  networkMode: WorkerNetworkMode
}

export type NormalizedWorkerEndpoint = {
  origin: string
  host: string
  port: number
  protocol: 'http' | 'https'
}

function hostnameOf(parsed: URL): string {
  return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host) || host === ''
}

export function isLoopbackListenHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return isLoopbackHost(normalized)
}

export function assertWorkerListenHostAllowed(host: string): void {
  if (!isLoopbackListenHost(host)) {
    throw new Error('本期受限内部服务只允许监听 loopback')
  }
}

export function normalizeWorkerEndpoint(
  url: string,
  options: WorkerEndpointOptions,
): NormalizedWorkerEndpoint {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Worker 内部地址不是合法 URL')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Worker 内部地址不得包含 userinfo')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Worker 内部地址不得包含 query 或 fragment')
  }
  if (parsed.pathname && parsed.pathname !== '/') {
    throw new Error('Worker 内部地址只能是 origin')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Worker 内部地址只允许 http(loopback) 或 https')
  }
  const host = hostnameOf(parsed)
  if (isWildcardHost(host) || host === 'unix') {
    throw new Error('Worker 内部地址不得使用通配、未指定主机或 unix socket')
  }
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80
  if (port === WORKER_DEBUG_PORT) {
    throw new Error('不得用调试端口 9222 登记平台内部服务')
  }
  const loopback = isLoopbackHost(host)
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('非 loopback 的 Worker 内部地址必须使用 https')
  }
  if (options.networkMode === 'distributed') {
    if (loopback) {
      throw new Error('distributed 模式不接受 loopback 内部入口')
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('distributed 模式的 Worker 内部入口必须是 https')
    }
  }
  const protocol = parsed.protocol === 'https:' ? 'https' : 'http'
  return {
    origin: parsed.origin,
    host: parsed.hostname,
    port,
    protocol,
  }
}

export function assertWorkerEndpointAllowed(url: string, options: WorkerEndpointOptions): void {
  normalizeWorkerEndpoint(url, options)
}

export function parseWorkerEndpoints(
  raw: string | undefined,
  options: WorkerEndpointOptions = { networkMode: 'local' },
): WorkerEndpointMap {
  if (!raw || raw.trim() === '') {
    if (options.networkMode === 'distributed') return {}
    return { 'local-worker': 'http://127.0.0.1:8091' }
  }
  const entries: Record<string, string> = {}
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      throw new Error('CAIRN_WORKER_ENDPOINTS 须为 workerId=baseUrl 的逗号分隔列表')
    }
    const origin = normalizeWorkerEndpoint(trimmed.slice(eq + 1).trim(), options).origin
    entries[trimmed.slice(0, eq).trim()] = origin
  }
  return workerEndpointMapSchema.parse(entries)
}

export function resolveWorkerAdvertiseUrl(input: {
  networkMode: WorkerNetworkMode
  advertiseUrl?: string
  internalPort: number
}): string | null {
  if (input.internalPort <= 0) {
    if (input.advertiseUrl) {
      throw new Error('CAIRN_WORKER_INTERNAL_PORT=0 时不得配置广告 URL')
    }
    if (input.networkMode === 'distributed') {
      throw new Error('distributed 模式必须监听内部服务')
    }
    return null
  }
  if (!input.advertiseUrl) {
    if (input.networkMode === 'distributed') {
      throw new Error('distributed 模式必须配置非 loopback 的 HTTPS 广告 URL')
    }
    return null
  }
  return normalizeWorkerEndpoint(input.advertiseUrl, { networkMode: input.networkMode }).origin
}

export const workerSlotCountsSchema = z.object({
  occupiedSlots: z.number().int().nonnegative(),
  lostOccupied: z.number().int().nonnegative(),
  executingSlots: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  holding: z.number().int().nonnegative(),
  waitingForAuth: z.number().int().nonnegative(),
  leftoverAuthHolds: z.number().int().nonnegative(),
  expiredLeaseResidue: z.number().int().nonnegative(),
  runCapacityUsed: z.number().int().nonnegative(),
})
export type WorkerSlotCounts = z.infer<typeof workerSlotCountsSchema>

export const workerHandleSampleSchema = z.object({
  liveHandleCount: z.number().int().nonnegative().nullable(),
  sampledSlotCount: z.number().int().nonnegative().nullable(),
  handleMismatchStreak: z.number().int().min(0).max(2),
  handleSampledAt: utcInstantSchema.nullable(),
  mismatchState: workerHandleMismatchStateSchema,
})
export type WorkerHandleSample = z.infer<typeof workerHandleSampleSchema>

export const workerInternalEndpointSchema = z.object({
  baseUrl: z.string().url(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(['http', 'https']),
})
export type WorkerInternalEndpoint = z.infer<typeof workerInternalEndpointSchema>

export const workerSummarySchema = z.object({
  workerId: z.string().min(1).max(128),
  instanceId: z.uuid(),
  status: workerStatusSchema,
  heartbeatAt: utcInstantSchema,
  lostAfterSeconds: z.number().int().positive().nullable(),
  heartbeatExpiresAt: utcInstantSchema.nullable(),
  heartbeatFresh: z.boolean(),
  capacity: z.number().int().positive(),
  maxSessions: z.number().int().positive(),
  counts: workerSlotCountsSchema,
  handleSample: workerHandleSampleSchema,
  routeAvailability: workerRouteAvailabilitySchema,
  routeReason: workerRouteReasonSchema.nullable(),
  endpointSource: workerEndpointSourceSchema,
  internalEndpoint: workerInternalEndpointSchema.nullable(),
})
export type WorkerSummary = z.infer<typeof workerSummarySchema>

export const workerListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: nextCursorSchema,
  search: z.string().trim().min(1).max(128).optional(),
  status: workerStatusSchema.optional(),
  heartbeatFresh: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined
      if (typeof value === 'boolean') return value
      return value === 'true'
    }),
})
export type WorkerListQuery = z.infer<typeof workerListQuerySchema>
export type WorkerListQueryInput = z.input<typeof workerListQuerySchema>

export const workerListResponseSchema = z.object({
  items: z.array(workerSummarySchema),
  nextCursor: nextCursorSchema,
  asOf: utcInstantSchema,
})
export type WorkerListResponse = z.infer<typeof workerListResponseSchema>

export const workerSessionListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: nextCursorSchema,
  status: sessionStatusSchema.optional(),
})
export type WorkerSessionListQuery = z.infer<typeof workerSessionListQuerySchema>

export const workerDetailResponseSchema = z.object({
  worker: workerSummarySchema,
  sessions: z.object({
    items: z.array(sessionDtoSchema),
    nextCursor: nextCursorSchema,
  }),
  asOf: utcInstantSchema,
})
export type WorkerDetailResponse = z.infer<typeof workerDetailResponseSchema>

export const browserSessionListQuerySchema = z.object({
  ownerWorkerId: z.string().min(1).max(128).optional(),
})
export type BrowserSessionListQuery = z.infer<typeof browserSessionListQuerySchema>

export function heartbeatFresh(input: { heartbeatExpiresAt: Date | string | null; asOf: Date }): boolean {
  if (!input.heartbeatExpiresAt) return false
  const expires =
    typeof input.heartbeatExpiresAt === 'string'
      ? Date.parse(input.heartbeatExpiresAt)
      : input.heartbeatExpiresAt.getTime()
  return Number.isFinite(expires) && expires > input.asOf.getTime()
}

export function nextHandleMismatchStreak(input: {
  previous: number
  liveHandleCount: number | null
  sampledSlotCount: number | null
}): number {
  if (input.liveHandleCount === null || input.sampledSlotCount === null) return 0
  if (input.liveHandleCount === input.sampledSlotCount) return 0
  return Math.min(2, Math.max(0, input.previous) + 1)
}

export function handleMismatchState(input: {
  liveHandleCount: number | null
  sampledSlotCount: number | null
  handleMismatchStreak: number
  heartbeatFresh: boolean
}): WorkerHandleMismatchState {
  if (!input.heartbeatFresh || input.liveHandleCount === null || input.sampledSlotCount === null) {
    return 'unknown'
  }
  if (input.handleMismatchStreak <= 0) return 'none'
  if (input.handleMismatchStreak === 1) return 'pending'
  return 'persistent'
}

export function evaluateWorkerRegistration(input: {
  workerStatus: string | null
  heartbeatExpiresAt: Date | string | null
  lostAfterSeconds: number | null
  internalBaseUrl: string | null
  asOf: Date
  networkMode: WorkerNetworkMode
  envEndpoint?: string
}): {
  availability: WorkerRouteAvailability
  reason: WorkerRouteReason | null
  endpointSource: WorkerEndpointSource
  endpoint: string | null
} {
  if (!input.workerStatus || input.workerStatus !== 'READY') {
    return {
      availability: 'unavailable',
      reason: 'worker_not_ready',
      endpointSource: 'none',
      endpoint: null,
    }
  }
  if (!input.lostAfterSeconds || !input.heartbeatExpiresAt) {
    return {
      availability: 'unavailable',
      reason: 'registration_incomplete',
      endpointSource: 'none',
      endpoint: null,
    }
  }
  if (!heartbeatFresh({ heartbeatExpiresAt: input.heartbeatExpiresAt, asOf: input.asOf })) {
    return {
      availability: 'unavailable',
      reason: 'heartbeat_expired',
      endpointSource: 'none',
      endpoint: null,
    }
  }
  if (input.internalBaseUrl) {
    try {
      const normalized = normalizeWorkerEndpoint(input.internalBaseUrl, {
        networkMode: input.networkMode,
      })
      return {
        availability: 'eligible',
        reason: null,
        endpointSource: 'database',
        endpoint: normalized.origin,
      }
    } catch {
      return {
        availability: 'unavailable',
        reason: 'endpoint_invalid',
        endpointSource: 'none',
        endpoint: null,
      }
    }
  }
  if (input.envEndpoint) {
    try {
      const normalized = normalizeWorkerEndpoint(input.envEndpoint, { networkMode: input.networkMode })
      return {
        availability: 'eligible',
        reason: null,
        endpointSource: 'environment',
        endpoint: normalized.origin,
      }
    } catch {
      return {
        availability: 'unavailable',
        reason: 'endpoint_invalid',
        endpointSource: 'none',
        endpoint: null,
      }
    }
  }
  return {
    availability: 'unavailable',
    reason: 'endpoint_missing',
    endpointSource: 'none',
    endpoint: null,
  }
}

export function evaluateWorkerRoute(input: {
  workerStatus: string | null
  workerInstanceId: string | null
  sessionOwnerInstanceId: string | null
  lostAfterSeconds?: number | null
  heartbeatExpiresAt: Date | string | null
  internalBaseUrl: string | null
  asOf: Date
  networkMode: WorkerNetworkMode
  envEndpoint?: string
}): {
  availability: WorkerRouteAvailability
  reason: WorkerRouteReason | null
  endpointSource: WorkerEndpointSource
  endpoint: string | null
} {
  if (!input.workerInstanceId || !input.sessionOwnerInstanceId || input.sessionOwnerInstanceId !== input.workerInstanceId) {
    return {
      availability: 'unavailable',
      reason: 'registration_incomplete',
      endpointSource: 'none',
      endpoint: null,
    }
  }
  return evaluateWorkerRegistration({
    workerStatus: input.workerStatus,
    heartbeatExpiresAt: input.heartbeatExpiresAt,
    lostAfterSeconds: input.lostAfterSeconds ?? null,
    internalBaseUrl: input.internalBaseUrl,
    asOf: input.asOf,
    networkMode: input.networkMode,
    envEndpoint: input.envEndpoint,
  })
}

export function projectWorkerInternalEndpoint(input: {
  canSeeEndpoint: boolean
  origin: string | null
}): WorkerInternalEndpoint | null {
  if (!input.canSeeEndpoint || !input.origin) return null
  try {
    const parsed = new URL(input.origin)
    return {
      baseUrl: parsed.origin,
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
      protocol: parsed.protocol === 'https:' ? 'https' : 'http',
    }
  } catch {
    return null
  }
}

export function canSeeWorkerInternalEndpoint(permissions: readonly string[]): boolean {
  return permissions.includes('session:read') && permissions.includes('session:dispose')
}
