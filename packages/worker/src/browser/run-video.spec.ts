import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  enqueueRecorderWrite,
  flushRecorderWrites,
  rebindVideoForLease,
  type RunVideoRecorder,
} from './run-video.js'

function recorder(leaseId: string): RunVideoRecorder {
  return {
    runId: 'run',
    leaseId,
    sessionId: 'session',
    pageId: 'page',
    dir: '/tmp/cairn-video-test',
    frameIndex: 0,
    jpegBytes: 0,
    jpegBudget: 1024,
    lastWriteAt: 0,
    passwordMask: 'applied',
    truncated: false,
    stopped: false,
    writeChain: Promise.resolve(),
  }
}

describe('run-video', () => {
  it('领取后先起录像再 ensureAuth，认证等待也能录', () => {
    const claim = readFileSync(resolve(import.meta.dirname, 'session-claim.ts'), 'utf8')
    expect(claim.indexOf('await this.startVideoForLease')).toBeLessThan(claim.indexOf('const auth = await this.ensureAuth'))
    expect(claim).toContain('this.rebindVideoForLease(occupancy.leaseId, waitGrant.leaseId)')
    expect(claim).toContain('await this.startVideoForLease(waitGrant.leaseId, session.id, snapshot)')
  })

  it('帧写入串行，后一帧等前一帧写完', async () => {
    const item = recorder('lease')
    const order: number[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    void enqueueRecorderWrite(item, async () => {
      await gate
      order.push(1)
    })
    void enqueueRecorderWrite(item, async () => {
      order.push(2)
    })
    expect(order).toEqual([])
    release()
    await flushRecorderWrites(item)
    expect(order).toEqual([1, 2])
  })

  it('AUTH_WAIT 换租约时录像器跟着走', () => {
    const manager = { videoRecorders: new Map<string, RunVideoRecorder>() }
    const item = recorder('exec')
    manager.videoRecorders.set('exec', item)
    rebindVideoForLease.call(manager as never, 'exec', 'wait')
    expect(manager.videoRecorders.has('exec')).toBe(false)
    expect(manager.videoRecorders.get('wait')).toBe(item)
    expect(item.leaseId).toBe('wait')
  })
})
