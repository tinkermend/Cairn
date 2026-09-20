import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import {
  acceptCapturedFrame,
  enqueueRecorderWrite,
  flushRecorderWrites,
  rebindVideoForLease,
  writeCapturedFrame,
  type RunVideoRecorder,
} from './run-video.js'
import { capturedFrameKey, type CapturedFrame } from './captured-frame.js'

function solidJpeg(width: number, height: number, r: number, g: number, b: number): Buffer {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 60).data)
}

async function recorder(leaseId: string): Promise<RunVideoRecorder> {
  const dir = await mkdtemp(join(tmpdir(), 'cairn-video-test-'))
  return {
    runId: 'run',
    leaseId,
    sessionId: 'session',
    pageId: 'page',
    captureEpoch: 1,
    dir,
    frameIndex: 0,
    jpegBytes: 0,
    jpegBudget: 1024 * 1024,
    lastWriteAt: 0,
    lastAcceptedMonoMs: Number.NEGATIVE_INFINITY,
    lastTMs: 0,
    startedMonoMs: 0,
    startedAt: new Date('2026-09-19T02:00:00.000Z'),
    passwordMask: 'applied',
    truncated: false,
    accepting: true,
    sealed: false,
    writeChain: Promise.resolve(),
    retargetChain: Promise.resolve(),
    frames: [],
    framesDropped: { rateLimited: 0, budget: 0, maskFailed: 0 },
    finalFrame: 'page_closed',
    localSeq: 0,
    sensitiveSelectors: [],
  }
}

function frame(overrides: Partial<CapturedFrame> & Pick<CapturedFrame, 'sourceSeq' | 'origin'>): CapturedFrame {
  return {
    pageId: 'page',
    captureEpoch: 1,
    receivedMonoMs: overrides.sourceSeq * 100,
    jpeg: solidJpeg(16, 12, 20 + overrides.sourceSeq, 40, 200),
    width: 16,
    height: 12,
    ...overrides,
  }
}

describe('run-video', () => {
  it('领取后先起录像再 ensureAuth，认证等待也能录', () => {
    const claim = readFileSync(resolve(import.meta.dirname, 'session-claim.ts'), 'utf8')
    expect(claim.indexOf('await this.startVideoForLease')).toBeLessThan(claim.indexOf('const auth = await this.ensureAuth'))
    expect(claim).toContain('this.rebindVideoForLease(occupancy.leaseId, waitGrant.leaseId)')
    expect(claim).toContain('await this.startVideoForLease(waitGrant.leaseId, session.id, snapshot)')
  })

  it('预留与提交运行级录像使用 video:run', () => {
    const start = readFileSync(resolve(import.meta.dirname, 'run-video.ts'), 'utf8')
    expect(start).toContain("writeEvidenceArtifactKey({ type: 'video' })")
    const media = readFileSync(resolve(import.meta.dirname, 'run-video-media.ts'), 'utf8')
    expect(media).toContain("artifactKey: writeEvidenceArtifactKey({ type: 'video' })")
  })

  it('封存后先释放占用再编码', () => {
    const reaper = readFileSync(resolve(import.meta.dirname, 'session-reaper.ts'), 'utf8')
    const releaseFn = reaper.slice(reaper.indexOf('export async function release('), reaper.indexOf('export async function close('))
    expect(releaseFn.indexOf('sealVideoForLease')).toBeLessThan(releaseFn.indexOf('releaseSessionUse'))
    expect(releaseFn.indexOf('releaseSessionUse')).toBeLessThan(releaseFn.indexOf('finalizeSealedVideo'))
    const abandon = readFileSync(resolve(import.meta.dirname, 'session-claim.ts'), 'utf8')
    const abandonFn = abandon.slice(abandon.indexOf('export async function abandonOccupancy('), abandon.indexOf('export function withHeldOccupancy'))
    expect(abandonFn.indexOf('sealVideoForLease')).toBeLessThan(abandonFn.indexOf('unbindOccupancy'))
    expect(abandonFn.indexOf('releaseSessionUse')).toBeLessThan(abandonFn.indexOf('finalizeSealedVideo'))
  })

  it('认领中止丢弃短录像，不提交为 available', () => {
    const reaper = readFileSync(resolve(import.meta.dirname, 'session-reaper.ts'), 'utf8')
    expect(reaper).toContain("commitVideo: reason !== 'acquire_aborted'")
    expect(reaper).toContain('discardSealedVideo')
  })

  it('帧写入串行，后一帧等前一帧写完', async () => {
    const item = await recorder('lease')
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

  it('AUTH_WAIT 换租约时录像器跟着走', async () => {
    const manager = { videoRecorders: new Map<string, RunVideoRecorder>() }
    const item = await recorder('exec')
    manager.videoRecorders.set('exec', item)
    rebindVideoForLease.call(manager as never, 'exec', 'wait')
    expect(manager.videoRecorders.has('exec')).toBe(false)
    expect(manager.videoRecorders.get('wait')).toBe(item)
    expect(item.leaseId).toBe('wait')
  })

  it('VE02：同一 captureEpoch 下连续不同图片各有独立 sourceSeq', async () => {
    const item = await recorder('lease')
    const keys = new Set<string>()
    for (let seq = 1; seq <= 10; seq += 1) {
      const next = frame({ origin: 'cdp', sourceSeq: seq, receivedMonoMs: seq * 600 })
      keys.add(capturedFrameKey(next))
      await writeCapturedFrame(item, next, [])
    }
    expect(keys.size).toBe(10)
    expect(item.frames).toHaveLength(10)
    expect(item.frames[0]?.file).toBe('frame_00000.jpg')
    expect(item.frames[9]?.file).toBe('frame_00009.jpg')
    const first = await readFile(join(item.dir, 'frame_00000.jpg'))
    const last = await readFile(join(item.dir, 'frame_00009.jpg'))
    expect(first.equals(last)).toBe(false)
  })

  it('VE04：已接纳队列在封存前写完，sealed 之后不再写入', async () => {
    const item = await recorder('lease')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    void enqueueRecorderWrite(item, async () => {
      await gate
      await writeCapturedFrame(item, frame({ origin: 'cdp', sourceSeq: 1, receivedMonoMs: 0 }), [])
    })
    void enqueueRecorderWrite(item, async () => {
      await writeCapturedFrame(item, frame({ origin: 'cdp', sourceSeq: 2, receivedMonoMs: 800 }), [])
    })
    item.accepting = false
    release()
    await flushRecorderWrites(item)
    await writeCapturedFrame(item, frame({ origin: 'final', sourceSeq: 1, receivedMonoMs: 900 }), [])
    expect(item.frames).toHaveLength(3)
    item.sealed = true
    await writeCapturedFrame(item, frame({ origin: 'cdp', sourceSeq: 3, receivedMonoMs: 1000 }), [])
    expect(item.frames).toHaveLength(3)
  })

  it('VE05：observer_refresh 不进入录像', async () => {
    const item = await recorder('lease')
    await acceptCapturedFrame(item, frame({ origin: 'cdp', sourceSeq: 1, receivedMonoMs: 0 }), [])
    await acceptCapturedFrame(
      item,
      frame({ origin: 'observer_refresh', sourceSeq: 99, receivedMonoMs: 10, jpeg: solidJpeg(16, 12, 255, 0, 0) }),
      [],
    )
    await acceptCapturedFrame(item, frame({ origin: 'heartbeat', sourceSeq: 1, receivedMonoMs: 2000 }), [])
  })

  it('VE03：关键帧不受 CDP 限频吞掉', async () => {
    const item = await recorder('key')
    await writeCapturedFrame(item, frame({ origin: 'cdp', sourceSeq: 1, receivedMonoMs: 0 }), [])
    await writeCapturedFrame(item, frame({ origin: 'cdp', sourceSeq: 2, receivedMonoMs: 80 }), [])
    await writeCapturedFrame(item, frame({ origin: 'keyframe', sourceSeq: 3, receivedMonoMs: 90 }), [])
    expect(item.frames.map((row) => row.origin)).toEqual(['cdp', 'keyframe'])
    expect(item.framesDropped.rateLimited).toBe(1)
    expect(item.frames).toHaveLength(2)
    expect(item.frames.map((row) => row.file)).toEqual(['frame_00000.jpg', 'frame_00001.jpg'])
  })
})
