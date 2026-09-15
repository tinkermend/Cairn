import { describe, expect, it } from 'vitest'
import { workerLifecycle } from './labels'

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
