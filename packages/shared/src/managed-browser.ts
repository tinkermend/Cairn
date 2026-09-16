import { z } from 'zod'
import { entityIdSchema, utcInstantSchema } from './wire.js'

export const pageAfterSchema = z.enum(['same', 'popup'])
export type PageAfter = z.infer<typeof pageAfterSchema>

export const pageRefSchema = z.strictObject({
  sessionId: entityIdSchema,
  sessionGeneration: z.number().int().positive(),
  pageId: entityIdSchema,
  documentEpoch: z.number().int().nonnegative(),
})
export type PageRef = z.infer<typeof pageRefSchema>

export const AUTH_CONTROL_TTL_SECONDS = 30
export const AUTH_CONTROL_HEARTBEAT_SECONDS = 5
export const BROWSER_FRAME_MAX_EDGE = 1280
export const BROWSER_FRAME_QUALITY = 60
export const BROWSER_FRAME_MAX_FPS = 2

export const BROWSER_CAPABILITY_STATES = ['open', 'limited', 'closed'] as const
export type BrowserCapabilityState = (typeof BROWSER_CAPABILITY_STATES)[number]
export const browserCapabilityStateSchema = z.enum(BROWSER_CAPABILITY_STATES)

export const managedBrowserCapabilitiesSchema = z.strictObject({
  screencast: browserCapabilityStateSchema,
  authInput: browserCapabilityStateSchema,
  popupHandoff: browserCapabilityStateSchema,
  chineseInsertText: browserCapabilityStateSchema,
})
export type ManagedBrowserCapabilities = z.infer<typeof managedBrowserCapabilitiesSchema>

export const DEFAULT_MANAGED_BROWSER_CAPABILITIES: ManagedBrowserCapabilities = {
  screencast: 'open',
  authInput: 'open',
  popupHandoff: 'open',
  chineseInsertText: 'open',
}

export const AUTH_CONTROL_PHASES = ['acquired', 'released', 'expired'] as const
export type AuthControlPhase = (typeof AUTH_CONTROL_PHASES)[number]

export const AUTH_INPUT_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
] as const
export type AuthInputKey = (typeof AUTH_INPUT_KEYS)[number]

const viewportSchema = z.strictObject({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
})

const inputCommon = {
  pageRef: pageRefSchema,
  commandId: entityIdSchema,
  seq: z.number().int().positive(),
  frameId: z.string().min(1).max(64),
  viewport: viewportSchema,
}

export const browserAuthInputCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...inputCommon,
    type: z.literal('mouse_click'),
    x: z.number().finite().min(0).max(4096),
    y: z.number().finite().min(0).max(4096),
    button: z.enum(['left', 'right', 'middle']).default('left'),
  }),
  z.strictObject({
    ...inputCommon,
    type: z.literal('mouse_wheel'),
    x: z.number().finite().min(0).max(4096),
    y: z.number().finite().min(0).max(4096),
    deltaX: z.number().finite().min(-2000).max(2000),
    deltaY: z.number().finite().min(-2000).max(2000),
  }),
  z.strictObject({
    ...inputCommon,
    type: z.literal('key'),
    key: z.enum(AUTH_INPUT_KEYS),
  }),
  z.strictObject({
    ...inputCommon,
    type: z.literal('insert_text'),
    text: z.string().min(1).max(2000),
  }),
])
export type BrowserAuthInputCommand = z.infer<typeof browserAuthInputCommandSchema>

export const managedPageSummarySchema = z.strictObject({
  pageRef: pageRefSchema,
  kind: z.enum(['base', 'run', 'popup']),
  viewing: z.boolean(),
  currentExecution: z.boolean(),
})
export type ManagedPageSummary = z.infer<typeof managedPageSummarySchema>

export const managedBrowserAuthHoldSchema = z.strictObject({
  expiresAt: utcInstantSchema,
  bound: z.boolean(),
  runId: entityIdSchema.nullable(),
})

export const managedBrowserAuthControlSchema = z.strictObject({
  epoch: z.number().int().nonnegative(),
  actorId: entityIdSchema.nullable(),
  expiresAt: utcInstantSchema.nullable(),
  heldByViewer: z.boolean(),
})

export const managedBrowserMetaSchema = z.strictObject({
  runId: entityIdSchema,
  runStatus: z.string().min(1),
  sessionId: entityIdSchema.nullable(),
  sessionGeneration: z.number().int().positive().nullable(),
  ownerWorkerId: z.string().min(1).max(128).nullable(),
  framesAvailable: z.boolean(),
  viewingOtherPage: z.boolean(),
  currentPage: managedPageSummarySchema.nullable(),
  pages: z.array(managedPageSummarySchema).max(16),
  authHold: managedBrowserAuthHoldSchema.nullable(),
  authControl: managedBrowserAuthControlSchema.nullable(),
  capabilities: managedBrowserCapabilitiesSchema,
  degradedReason: z.enum(['worker_unreachable', 'worker_generation_mismatch']).nullable(),
})
export type ManagedBrowserMeta = z.infer<typeof managedBrowserMetaSchema>

export const managedBrowserFrameSchema = z.strictObject({
  pageRef: pageRefSchema,
  frameId: z.string().min(1).max(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: utcInstantSchema,
  image: z.string().min(1),
})
export type ManagedBrowserFrame = z.infer<typeof managedBrowserFrameSchema>

export const acquireAuthControlBodySchema = z.strictObject({
  pageId: entityIdSchema.optional(),
})
export type AcquireAuthControlBody = z.infer<typeof acquireAuthControlBodySchema>

export const acquireAuthControlResponseSchema = z.strictObject({
  token: z.string().min(16).max(128),
  epoch: z.number().int().positive(),
  expiresAt: utcInstantSchema,
  pageRef: pageRefSchema,
  meta: managedBrowserMetaSchema,
})
export type AcquireAuthControlResponse = z.infer<typeof acquireAuthControlResponseSchema>

export const authControlTokenBodySchema = z.strictObject({
  token: z.string().min(16).max(128),
  pageId: entityIdSchema.optional(),
})
export type AuthControlTokenBody = z.infer<typeof authControlTokenBodySchema>

export const authControlHeartbeatResponseSchema = z.strictObject({
  expiresAt: utcInstantSchema,
  epoch: z.number().int().positive(),
})

export const authControlInputBodySchema = z.strictObject({
  token: z.string().min(16).max(128),
  command: browserAuthInputCommandSchema,
})
export type AuthControlInputBody = z.infer<typeof authControlInputBodySchema>

export const authControlInputReceiptSchema = z.strictObject({
  commandId: entityIdSchema,
  seq: z.number().int().positive(),
  status: z.enum(['accepted', 'duplicate', 'unknown']),
})
export type AuthControlInputReceipt = z.infer<typeof authControlInputReceiptSchema>

export function canObserveManagedFrames(input: {
  runStatus: string
  actorId: string
  controlActorId?: string | null
  controlExpiresAt?: Date | string | null
  now?: number
}): boolean {
  if (!['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'].includes(input.runStatus)) return false
  if (input.runStatus !== 'WAITING_FOR_AUTH') return true
  if (!input.controlActorId || !input.controlExpiresAt) return false
  const expires =
    typeof input.controlExpiresAt === 'string'
      ? Date.parse(input.controlExpiresAt)
      : input.controlExpiresAt.getTime()
  return input.controlActorId === input.actorId && Number.isFinite(expires) && expires > (input.now ?? Date.now())
}

export const MANAGED_BROWSER_ERROR_CODES = [
  'WORKER_UNREACHABLE',
  'WORKER_RESULT_UNKNOWN',
  'WORKER_GENERATION_MISMATCH',
  'AUTH_HOLD_UNBOUND',
  'AUTH_CONTROL_HELD',
  'AUTH_CONTROL_INVALID',
  'AUTH_NOT_VERIFIED',
  'AUTH_INPUT_REJECTED',
  'PAGE_STALE',
  'PAGE_HANDOFF_NO_POPUP',
  'PAGE_HANDOFF_AMBIGUOUS',
  'PAGE_HANDOFF_OUT_OF_SCOPE',
  'PAGE_HANDOFF_CLOSED',
] as const
export type ManagedBrowserErrorCode = (typeof MANAGED_BROWSER_ERROR_CODES)[number]
