import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import jpeg from 'jpeg-js'
import { encodeJpegDirectoryToWebm } from './video-encoder.js'
import { writeCapturedFrame, type RunVideoRecorder } from './run-video.js'
import type { CapturedFrame } from './captured-frame.js'

function solidJpeg(width: number, height: number, r: number, g: number, b: number): Buffer {
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 70).data)
}

function newRecorder(dir: string): RunVideoRecorder {
  return {
    runId: 'run',
    leaseId: 'lease',
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
    startedAt: new Date(),
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

describe('录像时间保真', () => {
  it('三页静止停留编码后，解码时长贴近采集区间', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-ve01-'))
    await mkdir(dir, { recursive: true })
    const pages = [
      solidJpeg(80, 60, 220, 30, 30),
      solidJpeg(80, 60, 30, 180, 60),
      solidJpeg(80, 60, 30, 60, 220),
    ]
    await writeFile(join(dir, 'frame_00000.jpg'), pages[0]!)
    await writeFile(join(dir, 'frame_00001.jpg'), pages[1]!)
    await writeFile(join(dir, 'frame_00002.jpg'), pages[2]!)
    const encoded = await encodeJpegDirectoryToWebm({
      dir,
      fps: 2,
      maxBytes: 512_000,
      timeline: {
        frames: [
          { file: 'frame_00000.jpg', tMs: 0 },
          { file: 'frame_00001.jpg', tMs: 6_000 },
          { file: 'frame_00002.jpg', tMs: 12_000 },
        ],
        sealedTMs: 18_000,
      },
    })
    expect(encoded.decodedFrames).toBeGreaterThanOrEqual(2)
    expect(Math.abs(encoded.decodedDurationMs - 18_000)).toBeLessThanOrEqual(1_000)
  }, 60_000)

  it('心跳帧证明静止仍在，不靠观察者补拍', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-ve05-'))
    const recorder = newRecorder(dir)
    const attach: CapturedFrame = {
      pageId: 'page',
      captureEpoch: 1,
      sourceSeq: 1,
      origin: 'attach',
      receivedMonoMs: 0,
      jpeg: solidJpeg(16, 12, 10, 10, 10),
      width: 16,
      height: 12,
    }
    const heartbeat: CapturedFrame = {
      ...attach,
      origin: 'heartbeat',
      sourceSeq: 2,
      receivedMonoMs: 8_000,
      jpeg: solidJpeg(16, 12, 10, 10, 10),
    }
    const observer: CapturedFrame = {
      ...attach,
      origin: 'observer_refresh',
      sourceSeq: 99,
      receivedMonoMs: 1_000,
      jpeg: solidJpeg(16, 12, 255, 255, 255),
    }
    await writeCapturedFrame(recorder, attach, [])
    await writeCapturedFrame(recorder, observer, [])
    await writeCapturedFrame(recorder, heartbeat, [])
    expect(recorder.frames).toHaveLength(2)
    expect(recorder.frames[1]?.tMs).toBe(8_000)
  })

  /**
   * attach（开录首帧）、心跳、终帧会与 CDP 帧并发进入 writeCapturedFrame。
   * 文件名与时间轴下标在几个 await 之间共享：两帧读到同一个下标就写同一个文件，
   * 时间轴出现两条指向同一文件、时间戳相同的记录，磁盘上还少一个编号。
   * 编码器的定帧率回退按 frame_%05d.jpg 顺序读，遇到断号就停，只解出 1 帧——
   * 一段几秒的录像被判「覆盖不完整」，证据随之 INCOMPLETE。
   */
  it('并发写入的帧各有各的文件，编号连续，时间轴与磁盘一致，编码后仍保住采集区间', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cairn-ve-race-'))
    const recorder = newRecorder(dir)
    const frame = (origin: CapturedFrame['origin'], seq: number, atMs: number, r: number): CapturedFrame => ({
      pageId: 'page',
      captureEpoch: 1,
      sourceSeq: seq,
      origin,
      receivedMonoMs: atMs,
      jpeg: solidJpeg(16, 12, r, 40, 40),
      width: 16,
      height: 12,
    })
    // 都不是 cdp 来源，不受限频影响；内容不同，不会被去重。
    await Promise.all([
      writeCapturedFrame(recorder, frame('attach', 1, 0, 200), []),
      writeCapturedFrame(recorder, frame('heartbeat', 2, 3_000, 120), []),
      writeCapturedFrame(recorder, frame('final', 3, 6_000, 40), []),
    ])

    const names = recorder.frames.map((item) => item.file)
    expect(names).toEqual(['frame_00000.jpg', 'frame_00001.jpg', 'frame_00002.jpg'])
    expect(new Set(names).size).toBe(3)
    expect((await readdir(dir)).filter((name) => name.endsWith('.jpg')).sort()).toEqual(names)
    expect(recorder.frameIndex).toBe(3)
    // 时间轴按写入顺序，时间不倒退。
    const times = recorder.frames.map((item) => item.tMs)
    expect([...times].sort((a, b) => a - b)).toEqual(times)

    const encoded = await encodeJpegDirectoryToWebm({
      dir,
      fps: 2,
      maxBytes: 512_000,
      timeline: { frames: recorder.frames, sealedTMs: times[times.length - 1]! + 3_000 },
    })
    expect(encoded.decodedFrames).toBeGreaterThanOrEqual(2)
    expect(Math.abs(encoded.decodedDurationMs - (times[times.length - 1]! + 3_000))).toBeLessThanOrEqual(1_000)
  }, 60_000)
})
