import { CANDIDATE_GROUPS_PROTOCOL, MODULE_MANIFEST_PROTOCOL } from './authoring-document.js'
import { MAP_CONSUMPTION_PROTOCOL } from './map-consumption.js'
import { MAP_EXPLORE_PROTOCOL } from './map-exploration.js'
import { MAP_JOBS_PROTOCOL } from './map-jobs.js'
import { IMPORTED_OUTCOME_PROTOCOL, OUTCOME_MANIFEST_PROTOCOL } from './outcome.js'
import { AI_ATOMIC_ACTIONS_PROTOCOL } from './step.js'
import { RUNTIME_INVARIANT_MANIFEST_PROTOCOL } from './runtime-invariant.js'
import { MAP_SCHEDULER_PROTOCOL } from './schedules.js'
import { SESSION_AUTH_RECOVERY_PROTOCOL } from './session-auth-recovery.js'
import { SESSION_MAINTENANCE_PROTOCOL } from './session-maintenance.js'
import { SESSION_OCCUPANCY_PROTOCOL } from './session-occupancy.js'
import { NOTIFICATION_WORKER_PROTOCOL, RUN_NOTIFICATION_PROTOCOL } from './notifications.js'
import { EXPORT_ARTIFACTS_PROTOCOL } from './reports.js'
import { SERVICE_WEBHOOK_DELIVERY_PROTOCOL } from './service-webhooks.js'
import { SUITE_ADMISSION_PROTOCOL, SUITE_SCHEDULER_PROTOCOL } from './suites.js'

export const WORKER_ROLES = ['executor', 'scheduler', 'maintenance', 'all'] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export const DEFAULT_WORKER_ROLES = 'all'

const PROTOCOL_ORDER = [
  NOTIFICATION_WORKER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  RUN_NOTIFICATION_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
  SESSION_MAINTENANCE_PROTOCOL,
  SESSION_AUTH_RECOVERY_PROTOCOL,
  MODULE_MANIFEST_PROTOCOL,
  CANDIDATE_GROUPS_PROTOCOL,
  MAP_CONSUMPTION_PROTOCOL,
  MAP_JOBS_PROTOCOL,
  MAP_EXPLORE_PROTOCOL,
  SUITE_ADMISSION_PROTOCOL,
  MAP_SCHEDULER_PROTOCOL,
  SUITE_SCHEDULER_PROTOCOL,
  EXPORT_ARTIFACTS_PROTOCOL,
  OUTCOME_MANIFEST_PROTOCOL,
  AI_ATOMIC_ACTIONS_PROTOCOL,
  IMPORTED_OUTCOME_PROTOCOL,
  RUNTIME_INVARIANT_MANIFEST_PROTOCOL,
] as const

export type WorkerRoleSet = {
  executor: boolean
  scheduler: boolean
  maintenance: boolean
}

export const ALL_WORKER_ROLES: WorkerRoleSet = {
  executor: true,
  scheduler: true,
  maintenance: true,
}

export function parseWorkerRoles(raw: string | undefined): WorkerRoleSet {
  const tokens = (raw ?? DEFAULT_WORKER_ROLES)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (tokens.length === 0) return { ...ALL_WORKER_ROLES }
  if (tokens.includes('all')) {
    if (tokens.length !== 1) {
      throw new Error('CAIRN_WORKER_ROLES 使用 all 时不能再组合其他角色')
    }
    return { ...ALL_WORKER_ROLES }
  }
  const allowed = new Set(['executor', 'scheduler', 'maintenance'])
  for (const token of tokens) {
    if (!allowed.has(token)) {
      throw new Error(`CAIRN_WORKER_ROLES 只能是 all 或 executor,scheduler,maintenance 的组合，收到 ${raw}`)
    }
  }
  return {
    executor: tokens.includes('executor'),
    scheduler: tokens.includes('scheduler'),
    maintenance: tokens.includes('maintenance'),
  }
}

const SCHEDULER_PROTOCOLS = new Set<string>([MAP_SCHEDULER_PROTOCOL, SUITE_SCHEDULER_PROTOCOL])
const MAINTENANCE_PROTOCOLS = new Set<string>([
  NOTIFICATION_WORKER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  EXPORT_ARTIFACTS_PROTOCOL,
])
const OCCUPANCY_EXEMPT_PROTOCOLS = new Set<string>([
  NOTIFICATION_WORKER_PROTOCOL,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  MAP_SCHEDULER_PROTOCOL,
  SUITE_SCHEDULER_PROTOCOL,
  EXPORT_ARTIFACTS_PROTOCOL,
  SESSION_OCCUPANCY_PROTOCOL,
])

export function protocolCapabilitiesForRoles(roles: WorkerRoleSet): string[] {
  return PROTOCOL_ORDER.filter((protocol) =>
    MAINTENANCE_PROTOCOLS.has(protocol)
      ? roles.maintenance
      : SCHEDULER_PROTOCOLS.has(protocol)
        ? roles.scheduler
        : roles.executor,
  )
}

/** 只有广告了执行/会话类协议才必须声明占用；调度与维护节点可以空协议登记。 */
export function registrationRequiresOccupancy(capabilities: readonly string[] | undefined): boolean {
  return (capabilities ?? []).some((item) => !OCCUPANCY_EXEMPT_PROTOCOLS.has(item))
}
