import { describe, expect, it } from 'vitest'
import {
  buildConcatFile,
  capturedSpanMs,
  frameDurationsMs,
  presentationMs,
  partitionVideoSegments,
  resampleToFrameGrid,
} from './video-timeline.js'

describe('video-timeline', () => {
  it('优先使用源时间并保持单调', () => {
    const clock = { startedMonoMs: 1000, lastTMs: 0 }
    expect(presentationMs(clock, { sourceTimestampMs: 5000, receivedMonoMs: 1000 })).toBe(0)
    expect(presentationMs(clock, { sourceTimestampMs: 7500, receivedMonoMs: 2000 })).toBe(2500)
    expect(presentationMs(clock, { sourceTimestampMs: 7000, receivedMonoMs: 3000 })).toBe(2500)
  })

  it('静止期按时长延展，不按帧数 ÷ fps 缩时', () => {
    const frames = [
      { file: 'frame_00000.jpg', tMs: 0 },
      { file: 'frame_00001.jpg', tMs: 10_000 },
    ]
    expect(frameDurationsMs(frames, 12_000)).toEqual([10_000, 2_000])
    expect(buildConcatFile(frames, 12_000)).toContain('duration 10.000')
    expect(capturedSpanMs(0, 12_000)).toBe(12_000)
  })

  it('网格重采样按全局时间取不晚于该点的最新帧', () => {
    const frames = [
      { file: 'a.jpg', tMs: 0 },
      { file: 'b.jpg', tMs: 4_000 },
    ]
    const grid = resampleToFrameGrid(frames, 5_000, 2)
    expect(grid).toHaveLength(10)
    expect(grid[0]?.file).toBe('a.jpg')
    expect(grid[grid.length - 1]?.file).toBe('b.jpg')
  })

  it('按 8 秒窗分段，页切换不是本函数的职责', () => {
    const frames = [
      { file: 'a.jpg', tMs: 0 },
      { file: 'b.jpg', tMs: 3_000 },
      { file: 'c.jpg', tMs: 8_000 },
      { file: 'd.jpg', tMs: 12_000 },
    ]
    const windows = partitionVideoSegments(frames, 16_000, 8_000)
    expect(windows).toHaveLength(2)
    expect(windows[0]).toMatchObject({ fromMs: 0, toMs: 8_000, frames: [{ file: 'a.jpg' }, { file: 'b.jpg' }] })
    expect(windows[1]?.frames.map((frame) => frame.file)).toEqual(['c.jpg', 'd.jpg'])
  })

  it('分段边界收成整数，避免 manifest 校验失败', () => {
    const windows = partitionVideoSegments(
      [
        { file: 'a.jpg', tMs: 0.4 },
        { file: 'b.jpg', tMs: 8000.6 },
      ],
      16000.2,
      8_000,
    )
    expect(windows).toHaveLength(2)
    expect(windows.every((window) => Number.isInteger(window.fromMs) && Number.isInteger(window.toMs))).toBe(true)
  })
})
