import { describe, expect, it } from 'vitest'
import {
  capturedSpanMsOf,
  computeRunVideoCoverage,
  formatVideoSeconds,
  readRunVideoPayload,
  runVideoPayloadSchema,
  videoCoverageLines,
  videoTimingCaption,
  writeRunVideoManifest,
  writeRunVideoPayload,
} from '../run-video.js'

const timing = {
  contractVersion: 1 as const,
  captureStartedAt: '2026-09-19T02:00:00.000Z',
  sealedAt: '2026-09-19T02:00:23.000Z',
  capturedSpanMs: 23_000,
  decodedDurationMs: 22_800,
  decodedFrames: 14,
  framesWritten: 14,
  framesDropped: { rateLimited: 0, budget: 0, maskFailed: 0 },
  finalFrame: 'captured' as const,
}

describe('runVideoPayloadSchema', () => {
  it('接受 A 期之前的历史录像（无 timing）', () => {
    const parsed = runVideoPayloadSchema.parse({ truncated: false, passwordMask: 'applied' })
    expect(parsed.timing).toBeUndefined()
    expect(videoTimingCaption(parsed)).toBe('历史录像，覆盖范围未验证')
  })

  it('接受带 timing 的新录像并拒绝未知字段', () => {
    const parsed = writeRunVideoPayload({
      truncated: true,
      truncateReason: 'max_bytes',
      passwordMask: 'failed',
      timing,
    })
    expect(parsed.timing?.capturedSpanMs).toBe(23_000)
    expect(() =>
      runVideoPayloadSchema.parse({ truncated: false, passwordMask: 'applied', extra: true }),
    ).toThrow()
  })

  it('读出时丢掉无法解释的垃圾，保留可识别的历史字段', () => {
    expect(readRunVideoPayload({ foo: 1 })).toBeUndefined()
    expect(readRunVideoPayload({ truncated: true, passwordMask: 'applied', leftover: 1 })).toEqual({
      truncated: true,
      passwordMask: 'applied',
    })
  })

  it('控制台只展示录像秒数与采集区间', () => {
    expect(formatVideoSeconds(23_000)).toBe('23')
    expect(formatVideoSeconds(22_750)).toBe('22.8')
    expect(videoTimingCaption({ timing })).toBe('录像 22.8 秒 / 采集区间 23 秒')
    expect(videoTimingCaption(undefined)).toBe('历史录像，覆盖范围未验证')
    expect(capturedSpanMsOf({ truncated: false, passwordMask: 'applied', timing })).toBe(23_000)
    expect(capturedSpanMsOf({ truncated: false, passwordMask: 'applied' })).toBe(-1)
  })

  it('截断与超容差解码记 partial；心跳间隔内的静止不算缺口', () => {
    expect(
      computeRunVideoCoverage({
        frames: [
          { tMs: 0, origin: 'attach' },
          { tMs: 2000, origin: 'heartbeat' },
          { tMs: 4000, origin: 'heartbeat' },
        ],
        capturedSpanMs: 4000,
        decodedDurationMs: 3900,
        truncated: false,
        finalFrame: 'captured',
      }).status,
    ).toBe('complete')
    expect(
      computeRunVideoCoverage({
        frames: [{ tMs: 0, origin: 'attach' }],
        capturedSpanMs: 20_000,
        decodedDurationMs: 20_000,
        truncated: true,
        finalFrame: 'captured',
      }),
    ).toMatchObject({ status: 'partial', gaps: [{ reason: 'budget' }] })
    expect(
      computeRunVideoCoverage({
        frames: [{ tMs: 0, origin: 'attach' }],
        capturedSpanMs: 20_000,
        decodedDurationMs: 1000,
        truncated: false,
        finalFrame: 'captured',
      }).status,
    ).toBe('partial')
    expect(videoCoverageLines({ truncated: false, passwordMask: 'applied' })).toEqual([
      '历史录像，覆盖范围未验证',
    ])
    expect(
      videoCoverageLines({
        truncated: true,
        passwordMask: 'applied',
        timing,
        coverage: { status: 'partial', gaps: [{ fromMs: 10_000, toMs: 23_000, reason: 'budget' }] },
      }),
    ).toEqual(['录像 22.8 秒 / 采集区间 23 秒', '部分覆盖', '体积截断 10–23 秒'])
  })

  it('C 期 manifest 拒绝未知字段', () => {
    const parsed = writeRunVideoManifest({
      contractVersion: 1,
      runId: 'run-1',
      sealed: true,
      sealedTMs: 8_000,
      framesWritten: 2,
      persistWatermark: 2,
      segments: [
        { seq: 0, fromMs: 0, toMs: 8_000, frameCount: 2, persistWatermark: 2, status: 'local' },
      ],
    })
    expect(parsed.segments).toHaveLength(1)
    expect(() => writeRunVideoManifest({ ...parsed, extra: true })).toThrow()
    expect(
      writeRunVideoManifest({
        contractVersion: 1,
        runId: 'run-1',
        sealed: true,
        sealedTMs: 8000.4,
        framesWritten: 2.2,
        persistWatermark: 2,
        segments: [
          { seq: 0, fromMs: 0.2, toMs: 8000.6, frameCount: 2, persistWatermark: 2, status: 'local' },
        ],
      }).segments[0],
    ).toMatchObject({ fromMs: 0, toMs: 8001 })
  })
})
