export const PERIODIC_SLOT_MODES = ['single_flight', 'throttle'] as const
export type PeriodicSlotMode = (typeof PERIODIC_SLOT_MODES)[number]

export const PERIODIC_SLOT_NAMES = [
  'monitor.sample.platform',
  'monitor.sample.purge',
  'monitor.alerts.evaluate',
  'monitor.objectstore.probe',
  'reaper.recovery',
  'reaper.session_leases',
  'reaper.liveness',
  'monitor.alerts.deliver',
  'credential.reminders',
  'service.request_logs.purge',
  'service.webhooks.deliver',
] as const
export type PeriodicSlotName = (typeof PERIODIC_SLOT_NAMES)[number]

export const PERIODIC_SLOT_OUTCOMES = ['ok', 'failed'] as const
export type PeriodicSlotOutcome = (typeof PERIODIC_SLOT_OUTCOMES)[number]

export const DEFAULT_PERIODIC_SLOT_LEASE_TTL_MS = 60_000
export const DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS = 5_000
export const DEFAULT_REAPER_DRAIN_BUDGET_MS = 5_000
export const DEFAULT_MONITOR_PURGE_INTERVAL_MS = 600_000
export const DEFAULT_CREDENTIAL_REMINDER_SCAN_INTERVAL_MS = 60_000
/** Request diagnostics are short-lived facts; one daily maintenance pass is sufficient. */
export const DEFAULT_SERVICE_REQUEST_LOG_PURGE_INTERVAL_MS = 86_400_000
export const DEFAULT_MONITOR_OVERVIEW_CACHE_MS = 3_000

export const REAPER_DEADLINE_BATCH = 200
export const REAPER_STALE_LEASE_BATCH = 50
export const REAPER_DRIFT_BATCH = 50
export const REAPER_SESSION_LEASE_BATCH = 100

export const REAPER_PERIODIC_SLOT_ORDER = [
  'reaper.recovery',
  'reaper.session_leases',
  'reaper.liveness',
  'monitor.alerts.evaluate',
  'credential.reminders',
  'service.request_logs.purge',
  'service.webhooks.deliver',
  'monitor.alerts.deliver',
] as const satisfies readonly PeriodicSlotName[]

export function isPeriodicSlotName(value: string): value is PeriodicSlotName {
  return (PERIODIC_SLOT_NAMES as readonly string[]).includes(value)
}

export function isPeriodicSlotMode(value: string): value is PeriodicSlotMode {
  return (PERIODIC_SLOT_MODES as readonly string[]).includes(value)
}

export function periodicSlotDueToleranceMs(intervalMs: number): number {
  return Math.min(Math.floor(intervalMs * 0.1), 2_000)
}

export function nextPeriodicSlotDueAt(now: Date, intervalMs: number): Date {
  return new Date(now.getTime() + intervalMs - periodicSlotDueToleranceMs(intervalMs))
}
