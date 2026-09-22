import { z } from 'zod'

export const LANDING_SETTLE_MODES = ['default', 'off'] as const
export type LandingSettleMode = (typeof LANDING_SETTLE_MODES)[number]
export const landingSettleModeSchema = z.enum(LANDING_SETTLE_MODES)

export const DEFAULT_LANDING_SETTLE_BUDGET_MS = 8_000
export const DEFAULT_LANDING_SETTLE_WATCH_MS = 1_500
export const DEFAULT_LANDING_SETTLE_MAX_DISMISSALS = 3
export const LANDING_SETTLE_URL_STABLE_MS = 300
export const LANDING_SETTLE_QUIET_MS = 400
export const LANDING_SETTLE_APP_SHELL_VIEWPORT_RATIO = 0.8
export const LANDING_SETTLE_OVERLAY_POLL_MS = 200
export const LANDING_SETTLE_DISMISS_WAIT_MS = 400

export const LANDING_SETTLE_ALLOW_NAMES = [
  '关闭',
  '关掉',
  '关闭窗口',
  '跳过',
  '跳过引导',
  '知道了',
  '我知道了',
  '暂不',
  '以后再说',
  '下次再说',
  '忽略',
  '×',
  '✕',
  'close',
  'dismiss',
  'skip',
  'skip tour',
  'got it',
  'not now',
  'maybe later',
  'no thanks',
] as const

export const LANDING_SETTLE_ALLOW_SUFFIXES = ['窗口', '弹窗', '引导', '提示', 'tour'] as const

export const LANDING_SETTLE_DENY_NAMES = [
  '同意',
  '接受',
  '允许',
  '开启',
  '启用',
  '开始',
  '立即体验',
  '开始使用',
  '进入',
  '确定',
  'accept',
  'accept all',
  'allow',
  'enable',
  'get started',
  'start tour',
  'continue',
  'next',
  'ok',
] as const

const INTERSTITIAL_PATH_TOKENS = [
  'mfa',
  '2fa',
  'otp',
  'oauth',
  'authorize',
  'consent',
  'challenge',
] as const

export const LANDING_SETTLE_SKIPPED_REASONS = [
  'mode_off',
  'url_unusable',
  'out_of_scope',
  'login_page',
  'password_visible',
  'interstitial',
  'unsafe_navigation',
  'file_chooser',
  'download',
  'input_accepting',
  'config_unreadable',
  'mismatch',
  'already_settled',
] as const
export type LandingSettleSkippedReason = (typeof LANDING_SETTLE_SKIPPED_REASONS)[number]

export type LandingSettleResult = {
  didNavigate: boolean
  didReload: boolean
  overlaysSeen: number
  overlaysDismissed: number
  skippedReason?: LandingSettleSkippedReason
  residualOverlay: boolean
  catchUp: boolean
  authLost?: boolean
}

export const landingSettleResultSchema = z.strictObject({
  didNavigate: z.boolean(),
  didReload: z.boolean(),
  overlaysSeen: z.number().int().nonnegative(),
  overlaysDismissed: z.number().int().nonnegative(),
  skippedReason: z.enum(LANDING_SETTLE_SKIPPED_REASONS).optional(),
  residualOverlay: z.boolean(),
  catchUp: z.boolean(),
  authLost: z.boolean().optional(),
})

export function skippedLandingSettle(
  reason: LandingSettleSkippedReason,
  catchUp = false,
): LandingSettleResult {
  return {
    didNavigate: false,
    didReload: false,
    overlaysSeen: 0,
    overlaysDismissed: 0,
    skippedReason: reason,
    residualOverlay: false,
    catchUp,
  }
}

export function normalizeAccessibleName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function nameEqualsAllow(normalized: string, allow: string): boolean {
  if (normalized === allow) return true
  for (const suffix of LANDING_SETTLE_ALLOW_SUFFIXES) {
    if (normalized === `${allow} ${suffix}` || normalized === `${allow}${suffix}`) return true
  }
  return false
}

export function classifyDismissLabel(name: string): 'allow' | 'deny' | 'none' {
  const normalized = normalizeAccessibleName(name)
  if (!normalized) return 'none'
  if (LANDING_SETTLE_DENY_NAMES.some((item) => normalized === item)) return 'deny'
  if (LANDING_SETTLE_ALLOW_NAMES.some((item) => nameEqualsAllow(normalized, item))) return 'allow'
  return 'none'
}

export function pickDismissButton(names: readonly string[]): string | null {
  const allowed = names.filter((name) => classifyDismissLabel(name) === 'allow')
  return allowed[0] ?? null
}

export function authRoutePathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const hashPath = (parsed.hash.replace(/^#/, '').split('?')[0] || '').trim()
    const path = (hashPath.startsWith('/') ? hashPath : parsed.pathname).replace(/\/+$/, '') || '/'
    return path.toLocaleLowerCase()
  } catch {
    return null
  }
}

export function isUnusableSettleUrl(url: string): boolean {
  if (!url || url === 'about:blank' || url === 'chrome://newtab/') return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'blob:' || parsed.protocol === 'data:' || parsed.protocol === 'file:'
  } catch {
    return true
  }
}

export function isInterstitialAuthPath(url: string, entryUrl: string): boolean {
  const path = authRoutePathFromUrl(url)
  if (!path) return false
  let entryPath = '/'
  try {
    entryPath = authRoutePathFromUrl(entryUrl) ?? '/'
  } catch {
    entryPath = '/'
  }
  const segments = path.split('/').filter(Boolean)
  if (INTERSTITIAL_PATH_TOKENS.some((token) => segments.includes(token))) return true
  return segments.includes('verify') && path !== entryPath
}

export function isAppShellOverlay(input: {
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  hasAllowButton: boolean
}): boolean {
  if (input.hasAllowButton) return false
  if (input.viewportWidth <= 0 || input.viewportHeight <= 0) return false
  const ratio = (input.width * input.height) / (input.viewportWidth * input.viewportHeight)
  return ratio >= LANDING_SETTLE_APP_SHELL_VIEWPORT_RATIO
}

export type LandingSettleEventHint = {
  type: string
  sessionId?: string | null
  seq?: number
}

/** 该会话在最近一次登录尝试之后还没有整理事件，则需要补跑。 */
export function needsLandingSettleCatchUp(
  events: readonly LandingSettleEventHint[],
  sessionId: string,
): boolean {
  const scoped = events.filter((event) => event.sessionId === sessionId)
  let lastAttemptSeq = -1
  let lastSettledSeq = -1
  for (const [index, event] of scoped.entries()) {
    const seq = event.seq ?? index
    if (event.type === 'auth.attempt_started') lastAttemptSeq = Math.max(lastAttemptSeq, seq)
    if (event.type === 'auth.landing_settled') lastSettledSeq = Math.max(lastSettledSeq, seq)
  }
  if (lastSettledSeq < 0) return true
  return lastAttemptSeq > lastSettledSeq
}

export function resolveLandingSettleConfig(input: {
  mode?: LandingSettleMode | null
  targetTimeoutMs?: number | null
  platformBudgetMs?: number | null
  platformWatchMs?: number | null
  platformMaxDismissals?: number | null
  loginTimeoutMs: number
}): {
  mode: LandingSettleMode
  budgetMs: number
  watchMs: number
  maxDismissals: number
} {
  const mode = input.mode === 'off' ? 'off' : 'default'
  const preferred = input.targetTimeoutMs ?? input.platformBudgetMs ?? DEFAULT_LANDING_SETTLE_BUDGET_MS
  const budgetMs = Math.max(1, Math.min(preferred, input.loginTimeoutMs))
  const watchMs = Math.max(
    0,
    Math.min(input.platformWatchMs ?? DEFAULT_LANDING_SETTLE_WATCH_MS, budgetMs - 1),
  )
  const maxDismissals = Math.max(
    1,
    Math.min(input.platformMaxDismissals ?? DEFAULT_LANDING_SETTLE_MAX_DISMISSALS, 8),
  )
  return { mode, budgetMs, watchMs, maxDismissals }
}

export function canOfferLandingSettle(input: {
  status: string
  occupyingRunId?: string | null
}): boolean {
  if (input.occupyingRunId) return false
  return input.status === 'ready' || input.status === 'needs_check'
}
