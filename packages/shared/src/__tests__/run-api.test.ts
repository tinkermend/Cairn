import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RETRY_LIMIT,
  DEFAULT_STEP_TIMEOUT_MS,
  canonicalJson,
  createRunBodySchema,
  runPlacementSchema,
  idempotencyDigestPayload,
  resolveStepPolicy,
  runInputSchema,
  runSnapshotSchema,
  snapshotDigestPayload,
} from '../index.js'

const ids = {
  run: '00000000-0000-4000-8000-000000000021',
  target: '00000000-0000-4000-8000-000000000022',
  scenario: '00000000-0000-4000-8000-000000000024',
  version: '00000000-0000-4000-8000-000000000025',
  echo: '00000000-0000-4000-8000-000000000026',
}

const echoStep = {
  id: ids.echo,
  name: '回显',
  type: 'echo' as const,
  effectType: 'READ_ONLY' as const,
  outputKey: 'echo_1',
  input: { value: { ok: true } },
}

describe('runInputSchema', () => {
  it('拒绝 __proto__ 与 constructor', () => {
    expect(() => runInputSchema.parse(JSON.parse('{"__proto__":1}'))).toThrow()
    expect(() => runInputSchema.parse({ constructor: 1 })).toThrow()
  })

  it('接受合法键', () => {
    expect(runInputSchema.parse({ orderId: 'A-1' })).toEqual({ orderId: 'A-1' })
  })
})

describe('runPlacementSchema', () => {
  it('详情必须带 placement，列表状态闭枚举', () => {
    expect(runPlacementSchema.parse({
      state: 'owner_required',
      sessionId: ids.run,
      ownerWorkerId: 'worker-1',
      sessionStatus: 'OPEN',
    }).state).toBe('owner_required')
    expect(() =>
      runPlacementSchema.parse({
        state: 'waiting_for_capacity',
        sessionId: null,
        ownerWorkerId: null,
        sessionStatus: null,
      }),
    ).toThrow()
  })
})

describe('createRunBodySchema', () => {
  it('拒绝过短的幂等键', () => {
    expect(() =>
      createRunBodySchema.parse({
        scenarioId: ids.scenario,
        idempotencyKey: 'short',
      }),
    ).toThrow()
  })

  it('默认 input 可省略', () => {
    const parsed = createRunBodySchema.parse({ scenarioId: ids.scenario })
    expect(parsed.input).toBeUndefined()
    expect(parsed.idempotencyKey).toBeUndefined()
  })
})

describe('resolveStepPolicy', () => {
  it('步骤字段覆盖快照，未覆盖回落默认', () => {
    expect(resolveStepPolicy(undefined, undefined)).toEqual({
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
      retryLimit: DEFAULT_RETRY_LIMIT,
    })
    expect(resolveStepPolicy({ timeoutMs: 5_000, retryLimit: 2 }, { retryLimit: 0 })).toEqual({
      timeoutMs: 5_000,
      retryLimit: 0,
    })
  })
})

describe('digest payloads', () => {
  it('canonicalJson 按键排序且忽略 undefined', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('snapshotDigestPayload 不含 runId / createdAt / digest', () => {
    const snapshot = runSnapshotSchema.parse({
      schemaVersion: 1,
      runId: ids.run,
      targetId: ids.target,
      scenarioId: ids.scenario,
      scenarioVersionId: ids.version,
      steps: [echoStep],
      input: { orderId: 'SO-1' },
      createdAt: '2026-09-10T08:00:00.000Z',
      digest: 'should-not-appear',
      executorVersions: { echo: '1', delay: '1', fail: '1' },
    })
    const payload = snapshotDigestPayload(snapshot)
    expect(payload).not.toHaveProperty('runId')
    expect(payload).not.toHaveProperty('createdAt')
    expect(payload).not.toHaveProperty('digest')
    expect(payload.targetId).toBe(ids.target)
    expect(canonicalJson(payload)).toContain('"orderId":"SO-1"')
    expect(canonicalJson(payload)).toBe(
      '{"executorVersions":{"delay":"1","echo":"1","fail":"1"},"input":{"orderId":"SO-1"},"scenarioId":"00000000-0000-4000-8000-000000000024","scenarioVersionId":"00000000-0000-4000-8000-000000000025","schemaVersion":1,"steps":[{"effectType":"READ_ONLY","id":"00000000-0000-4000-8000-000000000026","input":{"value":{"ok":true}},"name":"回显","outputKey":"echo_1","type":"echo"}],"targetId":"00000000-0000-4000-8000-000000000022"}',
    )
  })

  it('idempotencyDigestPayload 固定字段集合', () => {
    expect(
      idempotencyDigestPayload({
        scenarioVersionId: ids.version,
        input: { orderId: 'A-1' },
        targetAccountId: undefined,
      }),
    ).toEqual({
      scenarioVersionId: ids.version,
      input: { orderId: 'A-1' },
      targetAccountId: null,
      policy: undefined,
      sessionPolicy: null,
      evidencePolicy: null,
    })
  })
})
