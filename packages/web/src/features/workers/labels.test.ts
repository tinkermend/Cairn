import { describe, expect, it } from 'vitest'
import { classifyWorkerRole, workerLifecycle } from './labels'

describe('workerLifecycle', () => {
  it('把四值状态与心跳新鲜度拆开显示', () => {
    expect(workerLifecycle({ status: 'READY', heartbeatFresh: true })).toEqual({
      tone: 'success',
      label: '就绪',
    })
    expect(workerLifecycle({ status: 'READY', heartbeatFresh: false })).toEqual({
      tone: 'warning',
      label: '就绪登记已过期',
    })
    expect(workerLifecycle({ status: 'DRAINING', heartbeatFresh: true })).toEqual({
      tone: 'warning',
      label: '收尾中',
    })
    expect(workerLifecycle({ status: 'STOPPED', heartbeatFresh: true })).toEqual({
      tone: 'neutral',
      label: '已停止',
    })
    expect(workerLifecycle({ status: 'LOST', heartbeatFresh: false })).toEqual({
      tone: 'error',
      label: '失联',
    })
  })
})

describe('classifyWorkerRole', () => {
  it('按 workerId 正确识别 4 角色与单机全能兜底', () => {
    expect(classifyWorkerRole('local-worker-executor')).toBe('executor')
    expect(classifyWorkerRole('cairn-worker-executor-0')).toBe('executor')
    expect(classifyWorkerRole('local-worker-scheduler')).toBe('scheduler')
    expect(classifyWorkerRole('cairn-worker-scheduler-1')).toBe('scheduler')
    expect(classifyWorkerRole('local-worker-analyst')).toBe('analyst')
    expect(classifyWorkerRole('cairn-worker-analyst-2')).toBe('analyst')
    expect(classifyWorkerRole('local-worker-maintenance')).toBe('maintenance')
    expect(classifyWorkerRole('cairn-worker-maintenance-0')).toBe('maintenance')
    expect(classifyWorkerRole('local-worker')).toBe('monolithic')
    expect(classifyWorkerRole('worker-1')).toBe('monolithic')
  })
})

