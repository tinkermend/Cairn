import { describe, expect, it } from 'vitest'
import { NOTIFICATION_WORKER_PROTOCOL } from '../notifications.js'
import { EXPORT_ARTIFACTS_PROTOCOL } from '../reports.js'
import { MAP_SCHEDULER_PROTOCOL } from '../schedules.js'
import { SERVICE_WEBHOOK_DELIVERY_PROTOCOL } from '../service-webhooks.js'
import { SUITE_SCHEDULER_PROTOCOL } from '../suites.js'
import { parseWorkerRoles, protocolCapabilitiesForRoles, registrationRequiresOccupancy } from '../worker-roles.js'

describe('Worker 角色', () => {
  it('缺省 all，协议按角色三分，导出与集合推进不要求占用', () => {
    const all = parseWorkerRoles(undefined)
    expect(all).toEqual({ executor: true, scheduler: true, maintenance: true })
    const caps = protocolCapabilitiesForRoles(all)
    expect(caps.indexOf(MAP_SCHEDULER_PROTOCOL)).toBeLessThan(caps.indexOf('snapshot.outcomeManifest@1'))
    expect(() => parseWorkerRoles('all,executor')).toThrow(/不能再组合/)
    expect(parseWorkerRoles('scheduler')).toEqual({
      executor: false,
      scheduler: true,
      maintenance: false,
    })
    expect(protocolCapabilitiesForRoles(parseWorkerRoles('scheduler'))).toEqual([
      MAP_SCHEDULER_PROTOCOL,
      SUITE_SCHEDULER_PROTOCOL,
    ])
    expect(protocolCapabilitiesForRoles(parseWorkerRoles('maintenance'))).toEqual([
      NOTIFICATION_WORKER_PROTOCOL,
      SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
      EXPORT_ARTIFACTS_PROTOCOL,
    ])
    expect(registrationRequiresOccupancy([])).toBe(false)
    expect(registrationRequiresOccupancy([MAP_SCHEDULER_PROTOCOL])).toBe(false)
    expect(registrationRequiresOccupancy([SUITE_SCHEDULER_PROTOCOL])).toBe(false)
    expect(registrationRequiresOccupancy([SERVICE_WEBHOOK_DELIVERY_PROTOCOL])).toBe(false)
    expect(registrationRequiresOccupancy([EXPORT_ARTIFACTS_PROTOCOL])).toBe(false)
    expect(registrationRequiresOccupancy(['map-jobs@1'])).toBe(true)
  })
})
