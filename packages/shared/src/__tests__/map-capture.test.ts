import { describe, expect, it } from 'vitest'
import {
  FACTORY_MAP_CAPTURE_POLICY,
  FACTORY_PLATFORM_CONFIG,
  isMapCaptureEnabled,
  mapGapObservation,
  mapRecordingFactKey,
  mapRunFactKey,
  mapRunSourceType,
  platformConfigDocumentSchema,
  resolveMapCapturePolicy,
  runSnapshotSchema,
} from '../index.js'

const ids = {
  run: '22222222-2222-4222-8222-222222222222',
  attempt: '44444444-4444-4444-8444-444444444444',
  step: '33333333-3333-4333-8333-333333333333',
  target: '11111111-1111-4111-8111-111111111111',
  recording: '55555555-5555-4555-8555-555555555555',
}

describe('地图采集策略', () => {
  it('出厂关闭，开跑覆盖只改 enabled', () => {
    expect(FACTORY_MAP_CAPTURE_POLICY.enabled).toBe(false)
    expect(resolveMapCapturePolicy({ enabled: true, schemaVersion: 1 }).enabled).toBe(true)
    expect(resolveMapCapturePolicy({ enabled: true, schemaVersion: 1 }).captureScreenshots).toBe(false)
  })

  it('旧快照无字段视为关闭', () => {
    expect(isMapCaptureEnabled({})).toBe(false)
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId: ids.run,
      targetId: ids.target,
      scenarioId: ids.target,
      scenarioVersionId: ids.step,
      steps: [
        {
          id: ids.step,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 'ok' },
        },
      ],
      input: {},
      createdAt: '2026-09-16T00:00:00.000Z',
      digest: 'a'.repeat(64),
      executorVersions: { echo: '1', delay: '1', fail: '1' },
    })
    expect(snapshot.mapCapturePolicy).toBeUndefined()
    expect(isMapCaptureEnabled(snapshot)).toBe(false)
  })

  it('旧平台配置没有 mapCapture 时补出厂关闭', () => {
    const { mapCapture: _ignored, ...legacy } = FACTORY_PLATFORM_CONFIG
    const parsed = platformConfigDocumentSchema.parse(legacy)
    expect(parsed.mapCapture).toEqual(FACTORY_MAP_CAPTURE_POLICY)
    expect('mapCapture' in legacy).toBe(false)
  })

  it('来源与技术键满足 C0 字符集', () => {
    expect(mapRunSourceType('trial')).toBe('trial')
    expect(mapRunSourceType('published')).toBe('formal_run')
    const runKey = mapRunFactKey({ runId: ids.run, attemptId: ids.attempt, phase: 'before_action' })
    const skipKey = mapRunFactKey({ runId: ids.run, stepRunId: ids.step, phase: 'step_skipped' })
    const recKey = mapRecordingFactKey({
      recordingId: ids.recording,
      sourceVersion: 'recording-normalizer@2',
      originalEventIndex: 0,
    })
    expect(runKey).toMatch(/^[A-Za-z0-9:._-]{8,192}$/)
    expect(skipKey).toContain('skipped')
    expect(recKey.startsWith('rec:')).toBe(true)
  })

  it('缺口信封使用已有 missing 原因', () => {
    const gap = mapGapObservation({
      id: ids.attempt,
      targetId: ids.target,
      sourceType: 'formal_run',
      sourceRef: { sourceType: 'formal_run', runId: ids.run, stepRunId: ids.step, attemptId: ids.attempt },
      phase: 'after_action',
      dedupeKey: 'run-after-0........',
      reason: 'PROCESS_LOST',
    })
    expect(gap.captureStatus).toBe('missing')
    expect(gap.captureReason).toBe('PROCESS_LOST')
    const skipped = mapGapObservation({
      id: ids.step,
      targetId: ids.target,
      sourceType: 'formal_run',
      sourceRef: { sourceType: 'formal_run', runId: ids.run, stepRunId: ids.step },
      phase: 'step_skipped',
      dedupeKey: 'run-skip-0........',
      reason: 'NOT_APPLICABLE',
    })
    expect(skipped.captureStatus).toBe('skipped')
    expect(skipped.sourceRef).not.toHaveProperty('attemptId')
  })
})
