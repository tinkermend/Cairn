import { describe, expect, it } from 'vitest'
import {
  buildRunVideoChapters,
  captureMsToMediaSeconds,
  chapterAtPlayhead,
  gapAtPlayhead,
  mediaSecondsToCaptureMs,
} from '../run-video-chapters.js'
import type { RunDetailDto } from '../run-api.js'
import type { RunVideoPayload } from '../run-video.js'
import type { EvidenceMetadata } from '../evidence.js'

function mockRun(overrides: Partial<RunDetailDto> = {}): RunDetailDto {
  return {
    id: 'run-1',
    executionOrigin: 'standalone',
    status: 'SUCCEEDED',
    cancelRequested: false,
    targetId: 't-1',
    targetName: 'Target 1',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: 's-1',
    scenarioName: 'Scenario 1',
    scenarioVersionId: 'sv-1',
    createdAt: '2026-09-21T02:00:00.000Z',
    startedAt: '2026-09-21T02:00:01.000Z',
    finishedAt: '2026-09-21T02:00:25.000Z',
    evidenceStatus: 'COMPLETE',
    outcomeStatus: 'PASS',
    outcomeResults: [],
    lease: null,
    debugMode: 'runThrough',
    placement: {
      state: 'not_applicable',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
      waitReason: null,
      occupyingRunId: null,
      occupyingOperationId: null,
      targetWorkerId: null,
      profileAffinityUntil: null,
      generation: null,
      acquireReason: null,
      profileFallback: null,
    },
    snapshot: {
      schemaVersion: 1,
      runId: 'run-1',
      targetId: 't-1',
      scenarioId: 's-1',
      scenarioVersionId: 'sv-1',
      steps: [],
      input: {},
      createdAt: '2026-09-21T02:00:00.000Z',
    },
    context: {},
    stepRuns: [],
    ...overrides,
  }
}

const mockPayload: RunVideoPayload = {
  truncated: false,
  passwordMask: 'applied',
  timing: {
    contractVersion: 1,
    captureStartedAt: '2026-09-21T02:00:00.000Z',
    sealedAt: '2026-09-21T02:00:20.000Z',
    capturedSpanMs: 20_000,
    decodedDurationMs: 19_800,
    decodedFrames: 40,
    framesWritten: 40,
    framesDropped: { rateLimited: 0, budget: 0, maskFailed: 0 },
    finalFrame: 'captured',
    timingMode: 'concat',
  },
  coverage: {
    status: 'complete',
    gaps: [],
  },
}

describe('run-video-chapters', () => {
  it('VT18: 无 timing 时安全降级为 null clock 和空数据', () => {
    const model = buildRunVideoChapters({
      run: mockRun(),
      payload: { truncated: false, passwordMask: 'applied' },
    })
    expect(model.clock).toBeNull()
    expect(model.chapters).toEqual([])
    expect(model.pins).toEqual([])
    expect(model.gaps).toEqual([])
    expect(model.offAxisStepRunIds).toEqual([])
  })

  it('VT18: timingMode === "concat" 判定为 exact，缺失或 cfr 判定为 approximate', () => {
    const exactModel = buildRunVideoChapters({
      run: mockRun(),
      payload: mockPayload,
    })
    expect(exactModel.clock?.alignment).toBe('exact')

    const approxModel = buildRunVideoChapters({
      run: mockRun(),
      payload: {
        ...mockPayload,
        timing: { ...mockPayload.timing!, timingMode: 'cfr' },
      },
    })
    expect(approxModel.clock?.alignment).toBe('approximate')

    const legacyModel = buildRunVideoChapters({
      run: mockRun(),
      payload: {
        ...mockPayload,
        timing: { ...mockPayload.timing!, timingMode: undefined },
      },
    })
    expect(legacyModel.clock?.alignment).toBe('approximate')
  })

  it('VT18: 轴外裁剪与墙钟耗时保持（完全在轴外进 offAxisStepRunIds，相交裁剪并标 clipped）', () => {
    const run = mockRun({
      stepRuns: [
        // 1. 完全在轴前（-5s ~ -2s）
        {
          id: 'step-before',
          stepId: 's-before',
          name: '轴前步骤',
          type: 'navigate',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T01:59:55.000Z',
          finishedAt: '2026-09-21T01:59:58.000Z',
          attempts: [{ id: 'att-b', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T01:59:55.000Z', finishedAt: '2026-09-21T01:59:58.000Z', output: null, error: null }],
        },
        // 2. 跨轴前边界（-2s ~ +4s）：需 clamp 到 [0, 4000]，clipped: true，墙钟 6000ms
        {
          id: 'step-cross-start',
          stepId: 's-cross-start',
          name: '跨起点步骤',
          type: 'click',
          ordinal: 1,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T01:59:58.000Z',
          finishedAt: '2026-09-21T02:00:04.000Z',
          attempts: [{ id: 'att-cs', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T01:59:58.000Z', finishedAt: '2026-09-21T02:00:04.000Z', output: null, error: null }],
        },
        // 3. 正常轴内步骤（+5s ~ +10s）：fromMs: 5000, toMs: 10000, clipped: false, 墙钟 5000ms
        {
          id: 'step-inside',
          stepId: 's-inside',
          name: '轴内步骤',
          type: 'fill',
          ordinal: 2,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:05.000Z',
          finishedAt: '2026-09-21T02:00:10.000Z',
          attempts: [{ id: 'att-i', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:05.000Z', finishedAt: '2026-09-21T02:00:10.000Z', output: null, error: null }],
        },
        // 4. 跨轴后边界（+18s ~ +25s）：spanMs 为 20s，需 clamp 到 [18000, 20000]，clipped: true，墙钟 7000ms
        {
          id: 'step-cross-end',
          stepId: 's-cross-end',
          name: '跨终点步骤',
          type: 'assert',
          ordinal: 3,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:18.000Z',
          finishedAt: '2026-09-21T02:00:25.000Z',
          attempts: [{ id: 'att-ce', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:18.000Z', finishedAt: '2026-09-21T02:00:25.000Z', output: null, error: null }],
        },
        // 5. 完全在轴后（+22s ~ +26s）
        {
          id: 'step-after',
          stepId: 's-after',
          name: '轴后步骤',
          type: 'delay',
          ordinal: 4,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:22.000Z',
          finishedAt: '2026-09-21T02:00:26.000Z',
          attempts: [{ id: 'att-a', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:22.000Z', finishedAt: '2026-09-21T02:00:26.000Z', output: null, error: null }],
        },
        // 6. SKIPPED 步骤：不上轴，也不进 offAxis
        {
          id: 'step-skipped',
          stepId: 's-skipped',
          name: '跳过步骤',
          type: 'delay',
          ordinal: 5,
          status: 'SKIPPED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:12.000Z',
          finishedAt: '2026-09-21T02:00:12.000Z',
          attempts: [],
        },
      ],
    })

    const model = buildRunVideoChapters({ run, payload: mockPayload })
    expect(model.offAxisStepRunIds).toEqual(['step-before', 'step-after'])
    expect(model.chapters).toHaveLength(3)

    const [c1, c2, c3] = model.chapters
    expect(c1).toMatchObject({
      stepRunId: 'step-cross-start',
      fromMs: 0,
      toMs: 4000,
      clipped: true,
      durationMs: 6000, // 墙钟仍为 6s
    })
    expect(c2).toMatchObject({
      stepRunId: 'step-inside',
      fromMs: 5000,
      toMs: 10000,
      clipped: false,
      durationMs: 5000,
    })
    expect(c3).toMatchObject({
      stepRunId: 'step-cross-end',
      fromMs: 18000,
      toMs: 20000,
      clipped: true,
      durationMs: 7000, // 墙钟仍为 7s
    })
  })

  it('VT18: 零时长步骤保底命中宽度至少 1ms', () => {
    const run = mockRun({
      stepRuns: [
        {
          id: 'step-zero',
          stepId: 's-zero',
          name: '定位步骤',
          type: 'locate',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:05.000Z',
          finishedAt: '2026-09-21T02:00:05.000Z',
          attempts: [{ id: 'att-z', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:05.000Z', finishedAt: '2026-09-21T02:00:05.000Z', output: null, error: null }],
        },
      ],
    })
    const model = buildRunVideoChapters({ run, payload: mockPayload })
    expect(model.chapters[0]).toMatchObject({
      fromMs: 5000,
      toMs: 5001,
      durationMs: 0, // 墙钟 0ms
    })
  })

  it('VT18: 两类缺口分类与裁剪合并（still 点纹 vs blank 斜线灰段）', () => {
    const payloadWithGaps: RunVideoPayload = {
      ...mockPayload,
      coverage: {
        status: 'partial',
        gaps: [
          // still 缺口：rate_limit 3s~6s 与 5s~8s 重叠 -> 合并为 3s~8s
          { fromMs: 3000, toMs: 6000, reason: 'rate_limit' },
          { fromMs: 5000, toMs: 8000, reason: 'paused' },
          // blank 缺口：capture_failed 10s~12s 与 11s~14s 重叠 -> 合并为 10s~14s
          { fromMs: 10000, toMs: 12000, reason: 'capture_failed' },
          { fromMs: 11000, toMs: 14000, reason: 'budget' },
          // 超出 spanMs (20s) 的缺口：22s~25s -> 丢弃
          { fromMs: 22000, toMs: 25000, reason: 'capture_failed' },
          // 跨边界缺口：19s~23s -> 裁剪到 19s~20s
          { fromMs: 19000, toMs: 23000, reason: 'mask_failed' },
        ],
      },
    }

    const model = buildRunVideoChapters({ run: mockRun(), payload: payloadWithGaps })
    expect(model.gaps).toEqual([
      { fromMs: 3000, toMs: 8000, reason: 'rate_limit', kind: 'still' },
      { fromMs: 10000, toMs: 14000, reason: 'capture_failed', kind: 'blank' },
      { fromMs: 19000, toMs: 20000, reason: 'mask_failed', kind: 'blank' },
    ])
  })

  it('VT18: 重试与失败钉（钉在 finishedAt，包含 attemptNo）', () => {
    const run = mockRun({
      stepRuns: [
        {
          id: 'step-retry',
          stepId: 's-retry',
          name: '重试步骤',
          type: 'click',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:02.000Z',
          finishedAt: '2026-09-21T02:00:15.000Z',
          attempts: [
            // Attempt 1 失败（+2s ~ +5s） -> 钉在 +5s (5000ms)
            {
              id: 'att-1',
              attemptNo: 1,
              status: 'FAILED',
              startedAt: '2026-09-21T02:00:02.000Z',
              finishedAt: '2026-09-21T02:00:05.000Z',
              output: null,
              error: { code: 'TIMEOUT', category: 'TIMEOUT', retryable: true, safeMessage: '超时' },
            },
            // Attempt 2 失败（+6s ~ +10s） -> 钉在 +10s (10000ms)
            {
              id: 'att-2',
              attemptNo: 2,
              status: 'FAILED',
              startedAt: '2026-09-21T02:00:06.000Z',
              finishedAt: '2026-09-21T02:00:10.000Z',
              output: null,
              error: { code: 'NOT_FOUND', category: 'EXECUTOR', retryable: true, safeMessage: '未找到' },
            },
            // Attempt 3 成功（+11s ~ +15s） -> 不打钉
            {
              id: 'att-3',
              attemptNo: 3,
              status: 'SUCCEEDED',
              startedAt: '2026-09-21T02:00:11.000Z',
              finishedAt: '2026-09-21T02:00:15.000Z',
              output: null,
              error: null,
            },
          ],
        },
      ],
    })

    const model = buildRunVideoChapters({ run, payload: mockPayload })
    expect(model.pins).toEqual([
      { attemptId: 'att-1', stepRunId: 'step-retry', attemptNo: 1, atMs: 5000 },
      { attemptId: 'att-2', stepRunId: 'step-retry', attemptNo: 2, atMs: 10000 },
    ])
    // 章节本体覆盖整个 StepRun（2000 ~ 15000）
    expect(model.chapters[0]).toMatchObject({
      fromMs: 2000,
      toMs: 15000,
      durationMs: 13000,
    })
  })

  it('VT18: 动作模块名解析与主截图 faceEvidenceId 关联', () => {
    const run = mockRun({
      snapshot: {
        schemaVersion: 1,
        runId: 'run-1',
        targetId: 't-1',
        scenarioId: 's-1',
        scenarioVersionId: 'sv-1',
        steps: [],
        input: {},
        createdAt: '2026-09-21T02:00:00.000Z',
        moduleManifest: {
          entries: [
            {
              invocationId: 'inv-1',
              ordinal: 0,
              name: '登录模块',
              moduleId: 'm-1',
              moduleKey: 'login',
              contentDigest: 'sha256:abc',
              contractDigest: 'sha256:abc',
              implementationDigest: 'sha256:abc',
              implementationKey: 'default',
              executionMode: 'DETERMINISTIC',
              effectCeiling: 'READ_ONLY',
              expandedStepIds: ['s-mod-1', 's-mod-2'],
              internalToExpanded: {},
              preconditionStepIds: [],
              postconditionStepIds: [],
              outputRequired: [],
              inputBindingsDigest: 'sha256:abc',
            },
          ],
        },
      },
      stepRuns: [
        {
          id: 'sr-mod-1',
          stepId: 's-mod-1',
          name: '输入用户名',
          type: 'fill',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:01.000Z',
          finishedAt: '2026-09-21T02:00:03.000Z',
          attempts: [
            { id: 'att-mod-1', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:01.000Z', finishedAt: '2026-09-21T02:00:03.000Z', output: null, error: null },
          ],
        },
      ],
    })

    const evidenceItems: EvidenceMetadata[] = [
      {
        schemaVersion: 1,
        id: 'ev-face-1',
        runId: 'run-1',
        stepRunId: 'sr-mod-1',
        attemptId: 'att-mod-1',
        type: 'screenshot',
        status: 'available',
        createdAt: '2026-09-21T02:00:03.000Z',
        contentType: 'image/png',
        byteSize: 1024,
      },
    ]

    const model = buildRunVideoChapters({ run, payload: mockPayload, evidenceItems })
    expect(model.chapters[0]).toMatchObject({
      moduleName: '登录模块',
      faceAttemptId: 'att-mod-1',
      faceEvidenceId: 'ev-face-1',
    })
  })

  it('VT18: mediaMs < spanMs 不拉伸，保持 1:1，超出部分截断', () => {
    const clock = { mediaMs: 15_000 }
    expect(captureMsToMediaSeconds(5000, clock)).toBe(5)
    expect(captureMsToMediaSeconds(15000, clock)).toBe(15)
    expect(captureMsToMediaSeconds(18000, clock)).toBe(15) // clamp 到 mediaMs
  })

  it('VT18: 两向换算在 mediaMs 内互逆', () => {
    const clock = { mediaMs: 15_000, alignment: 'exact' as const }
    for (const ms of [0, 1000, 3500, 7200, 15000]) {
      const sec = captureMsToMediaSeconds(ms, clock)
      const backMs = mediaSecondsToCaptureMs(sec, clock)
      expect(backMs).toBe(ms)
    }
  })

  it('VT18: chapterAtPlayhead 与 gapAtPlayhead 优先级与命中判定', () => {
    const run = mockRun({
      stepRuns: [
        {
          id: 'step-1',
          stepId: 's-1',
          name: '步骤1',
          type: 'click',
          ordinal: 0,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:01.000Z',
          finishedAt: '2026-09-21T02:00:05.000Z',
          attempts: [{ id: 'a1', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:01.000Z', finishedAt: '2026-09-21T02:00:05.000Z', output: null, error: null }],
        },
        {
          id: 'step-2',
          stepId: 's-2',
          name: '步骤2',
          type: 'click',
          ordinal: 1,
          status: 'SUCCEEDED',
          outcomeStatus: 'NOT_EVALUATED',
          startedAt: '2026-09-21T02:00:08.000Z',
          finishedAt: '2026-09-21T02:00:12.000Z',
          attempts: [{ id: 'a2', attemptNo: 1, status: 'SUCCEEDED', startedAt: '2026-09-21T02:00:08.000Z', finishedAt: '2026-09-21T02:00:12.000Z', output: null, error: null }],
        },
      ],
    })

    const payloadWithGaps: RunVideoPayload = {
      ...mockPayload,
      coverage: {
        status: 'partial',
        gaps: [
          // 步骤 1 内有一个 still gap (2s ~ 4s)
          { fromMs: 2000, toMs: 4000, reason: 'rate_limit' },
          // 步骤 1 和 步骤 2 之间有一个 blank gap (6s ~ 7s)
          { fromMs: 6000, toMs: 7000, reason: 'capture_failed' },
        ],
      },
    }

    const model = buildRunVideoChapters({ run, payload: payloadWithGaps })

    // 1. 落在步骤 1 的 3000ms（此时也是 still 缺口）：仍判定为 step-1，still 不夺走章节
    const ch1 = chapterAtPlayhead(model.chapters, 3000, model.gaps)
    expect(ch1?.stepRunId).toBe('step-1')
    const gapStill = gapAtPlayhead(model.gaps, 3000)
    expect(gapStill?.kind).toBe('still')

    // 2. 落在 blank gap (6500ms)：chapterAtPlayhead 返回 null
    const chBlank = chapterAtPlayhead(model.chapters, 6500, model.gaps)
    expect(chBlank).toBeNull()
    const gapBlank = gapAtPlayhead(model.gaps, 6500)
    expect(gapBlank?.kind).toBe('blank')

    // 3. 落在两步之间且不在 blank gap 内（7500ms）：返回 null（步骤之间）
    const chBetween = chapterAtPlayhead(model.chapters, 7500, model.gaps)
    expect(chBetween).toBeNull()
    const gapBetween = gapAtPlayhead(model.gaps, 7500)
    expect(gapBetween).toBeNull()

    // 4. 落在步骤 2 (9000ms)：判定为 step-2
    const ch2 = chapterAtPlayhead(model.chapters, 9000, model.gaps)
    expect(ch2?.stepRunId).toBe('step-2')
  })
})
