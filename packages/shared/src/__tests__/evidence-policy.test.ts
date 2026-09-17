import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEBUG_TRACE_RETAIN_DAYS,
  DEFAULT_EVIDENCE_POLICY,
  DEFAULT_TRACE_RETAIN_DAYS,
  evidencePolicySchema,
  resolveEvidencePolicy,
  shouldCaptureEvidence,
} from '../evidence-policy.js'
import { runSnapshotSchema } from '../run.js'

const ids = {
  run: '00000000-0000-4000-8000-000000000021',
  target: '00000000-0000-4000-8000-000000000022',
  scenario: '00000000-0000-4000-8000-000000000024',
  version: '00000000-0000-4000-8000-000000000025',
  echo: '00000000-0000-4000-8000-000000000026',
}

describe('resolveEvidencePolicy', () => {
  it('存量缺字段走平台默认', () => {
    expect(resolveEvidencePolicy(undefined)).toEqual(DEFAULT_EVIDENCE_POLICY)
    expect(resolveEvidencePolicy({})).toEqual(DEFAULT_EVIDENCE_POLICY)
    expect(evidencePolicySchema.parse({})).toEqual({})
  })

  it('Debug Trace 默认保留 7 天，失败 Trace 默认 14 天', () => {
    expect(resolveEvidencePolicy({ trace: 'always' }).retainDays.trace).toBe(
      DEFAULT_DEBUG_TRACE_RETAIN_DAYS,
    )
    expect(resolveEvidencePolicy({ trace: 'on_failure' }).retainDays.trace).toBe(
      DEFAULT_TRACE_RETAIN_DAYS,
    )
  })

  it('显式 retainDays 覆盖默认', () => {
    expect(resolveEvidencePolicy({ retainDays: { trace: 3 } }).retainDays.trace).toBe(3)
  })

  it('存量 Snapshot 没有 evidencePolicy 仍可解析', () => {
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId: ids.run,
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [
        {
          id: ids.echo,
          name: '回显',
          type: 'echo',
          effectType: 'READ_ONLY',
          input: { value: 1 },
        },
      ],
      input: {},
      createdAt: '2026-09-10T08:00:00.000Z',
    })
    expect(snapshot.evidencePolicy).toBeUndefined()
    expect(resolveEvidencePolicy(snapshot.evidencePolicy).screenshot).toBe('on_failure')
    expect(resolveEvidencePolicy(snapshot.evidencePolicy).video).toBe('off')
  })

  it('显式 video 覆盖历史默认，不把出厂 always 回写到缺字段 Snapshot', () => {
    expect(resolveEvidencePolicy({ video: 'always' }).video).toBe('always')
    expect(resolveEvidencePolicy({}).video).toBe('off')
  })
})

describe('shouldCaptureEvidence', () => {
  it('off 不开，always 全开，on_failure 只在失败时开', () => {
    expect(shouldCaptureEvidence('off', true)).toBe(false)
    expect(shouldCaptureEvidence('always', false)).toBe(true)
    expect(shouldCaptureEvidence('on_failure', false)).toBe(false)
    expect(shouldCaptureEvidence('on_failure', true)).toBe(true)
  })
})
