import { describe, expect, it } from 'vitest'
import { runSnapshotSchema, runStatusSchema } from '../run.js'

const ids = {
  run: '00000000-0000-4000-8000-000000000021',
  target: '00000000-0000-4000-8000-000000000022',
  account: '00000000-0000-4000-8000-000000000023',
  scenario: '00000000-0000-4000-8000-000000000024',
  version: '00000000-0000-4000-8000-000000000025',
  echo: '00000000-0000-4000-8000-000000000026',
  delay: '00000000-0000-4000-8000-000000000027',
}

const echoStep = {
  id: ids.echo,
  name: '回显',
  type: 'echo' as const,
  effectType: 'READ_ONLY' as const,
  outputKey: 'echo_1',
  input: { value: { ok: true } },
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId: ids.run,
    targetId: ids.target,
    scenarioId: ids.scenario,
    scenarioVersionId: ids.version,
    steps: [echoStep],
    input: { orderId: 'SO-1' },
    createdAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  }
}

describe('runStatusSchema', () => {
  it('接受路线图冻结的主状态', () => {
    expect(runStatusSchema.parse('QUEUED')).toBe('QUEUED')
    expect(runStatusSchema.parse('NEEDS_REVIEW')).toBe('NEEDS_REVIEW')
  })

  it('拒绝未入词表的状态', () => {
    expect(() => runStatusSchema.parse('CLAIMED')).toThrow()
    expect(() => runStatusSchema.parse('CANCELLING')).toThrow()
  })
})

describe('runSnapshotSchema', () => {
  it('接受绑定 Target 的最小快照', () => {
    const parsed = runSnapshotSchema.parse(snapshot())
    expect(parsed.targetId).toBe(ids.target)
    expect(parsed.steps).toHaveLength(1)
  })

  it('接受 TargetAccount 凭据引用', () => {
    const parsed = runSnapshotSchema.parse(
      snapshot({
        targetAccountId: ids.account,
        secretRef: { provider: 'local', secretId: 'acct-secret-1' },
      }),
    )
    expect(parsed.secretRef?.secretId).toBe('acct-secret-1')
  })

  it('未绑定 Target 被拒绝', () => {
    const { targetId: _drop, ...unbound } = snapshot()
    expect(() => runSnapshotSchema.parse(unbound)).toThrow()
  })

  it('有 secretRef 却没有 targetAccountId 被拒绝', () => {
    expect(() =>
      runSnapshotSchema.parse(
        snapshot({ secretRef: { provider: 'local', secretId: 'acct-secret-1' } }),
      ),
    ).toThrow()
  })

  it('未知 Step Type 不能进入快照', () => {
    expect(() =>
      runSnapshotSchema.parse(
        snapshot({
          steps: [
            {
              id: ids.delay,
              name: '打开页',
              type: 'navigate',
              effectType: 'IDEMPOTENT',
              input: { url: '/' },
            },
          ],
        }),
      ),
    ).toThrow()
  })

  it('重复 step.id 或 outputKey 被拒绝', () => {
    expect(() =>
      runSnapshotSchema.parse(snapshot({ steps: [echoStep, { ...echoStep, name: '副本' }] })),
    ).toThrow()

    expect(() =>
      runSnapshotSchema.parse(
        snapshot({
          steps: [
            echoStep,
            {
              id: ids.delay,
              name: '另一回显',
              type: 'echo',
              effectType: 'READ_ONLY',
              outputKey: 'echo_1',
              input: { from: 'echo_1' },
            },
          ],
        }),
      ),
    ).toThrow()
  })

  it('createdAt 必须是 UTC', () => {
    expect(() => runSnapshotSchema.parse(snapshot({ createdAt: '2026-09-10T16:00:00+08:00' }))).toThrow()
  })
})
