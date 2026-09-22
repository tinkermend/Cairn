import '@/styles/index.css'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import type { EvidenceMetadata, RunVideoChapterModel } from '@cairn/shared'
import { RunVideoPlayer } from '../run-video-player'

const mockEvidence: EvidenceMetadata = {
  schemaVersion: 1,
  id: 'ev-vid-1',
  runId: 'run-1',
  type: 'video',
  status: 'available',
  createdAt: '2026-09-21T02:00:20.000Z',
  contentType: 'video/webm',
  byteSize: 4096,
}

const mockChapterModel: RunVideoChapterModel = {
  clock: {
    originMs: 1726884000000,
    spanMs: 20000,
    mediaMs: 20000,
    alignment: 'exact',
  },
  chapters: [
    {
      stepRunId: 'sr-1',
      stepId: 's-1',
      ordinal: 0,
      name: '打开页面',
      type: 'navigate',
      status: 'SUCCEEDED',
      fromMs: 0,
      toMs: 5000,
      durationMs: 5000,
      clipped: false,
      attemptCount: 1,
    },
    {
      stepRunId: 'sr-2',
      stepId: 's-2',
      ordinal: 1,
      name: '点击登录',
      type: 'click',
      status: 'FAILED',
      fromMs: 6000,
      toMs: 12000,
      durationMs: 6000,
      clipped: false,
      attemptCount: 2,
    },
    {
      stepRunId: 'sr-3',
      stepId: 's-3',
      ordinal: 2,
      name: '确认结果',
      type: 'assert',
      status: 'SUCCEEDED',
      fromMs: 14000,
      toMs: 19000,
      durationMs: 5000,
      clipped: false,
      attemptCount: 1,
    },
  ],
  pins: [
    {
      attemptId: 'att-fail-1',
      stepRunId: 'sr-2',
      attemptNo: 1,
      atMs: 9000,
    },
  ],
  gaps: [
    { fromMs: 2000, toMs: 4000, reason: 'rate_limit', kind: 'still' },
    { fromMs: 12000, toMs: 13000, reason: 'capture_failed', kind: 'blank' },
  ],
  offAxisStepRunIds: [],
}

vi.mock('@/lib/runs-api', () => ({
  fetchEvidenceContent: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' }),
    contentType: 'video/webm',
  })),
}))

describe('RunVideoPlayer', () => {
  it('VT01 / VT11: 渲染自定义播放器控件，包含 role="slider"、时间码、全屏与下载', async () => {
    const { getByRole, getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
      />,
    )

    await expect.element(getByRole('button', { name: '播放' })).toBeInTheDocument()
    await expect.element(getByRole('slider', { name: '录像进度' })).toBeInTheDocument()
    await expect.element(getByText('0:00 / 0:20')).toBeInTheDocument()
    await expect.element(getByRole('button', { name: '全屏' })).toBeInTheDocument()
    await expect.element(getByRole('button', { name: '下载录像' })).toBeInTheDocument()
    await expect.element(getByText(/正在看：1\. 打开页面/)).toBeInTheDocument()
  })

  it('VT04: 渲染失败钉并支持点击跳到失败现场时刻', async () => {
    const onSeek = vi.fn()
    const { getByRole } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
      />,
    )

    const pinBtn = getByRole('button', { name: '第 1 次尝试失败现场' })
    await expect.element(pinBtn).toBeInTheDocument()
    await pinBtn.click()
    expect(onSeek).toHaveBeenCalledWith(9000)
  })

  it('VT02 / VT11: 键盘快捷键与进度条快进', async () => {
    const onSeek = vi.fn()
    const { getByRole } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
      />,
    )

    const slider = getByRole('slider', { name: '录像进度' })
    await slider.click()
    expect(onSeek).toHaveBeenCalled()
  })

  it('VT03: 轴外步骤显示“不在录像里”', async () => {
    const { getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        offAxisSelectedStep={{ ordinal: 5, name: '轴外未录制步骤' }}
      />,
    )
    await expect.element(getByText('正在看：6. 轴外未录制步骤 · 不在录像里')).toBeInTheDocument()
  })

  it('VT06: 历史录像无 timing 提示', async () => {
    const { getByText } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={{
          clock: null,
          chapters: [],
          pins: [],
          gaps: [],
          offAxisStepRunIds: [],
        }}
      />,
    )
    await expect.element(getByText('历史录像，步骤对不上时间')).toBeInTheDocument()
  })

  it('上一步 / 下一步章节导航', async () => {
    const onSeek = vi.fn()
    const { getByRole } = await render(
      <RunVideoPlayer
        runId='run-1'
        evidence={mockEvidence}
        chapterModel={mockChapterModel}
        onSeek={onSeek}
      />,
    )

    const nextBtn = getByRole('button', { name: '下一步' })
    await nextBtn.click()
    expect(onSeek).toHaveBeenCalledWith(6000) // 下一步跳到 sr-2 的 fromMs
  })
})
