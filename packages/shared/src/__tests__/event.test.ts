import { describe, expect, it } from 'vitest'
import {
  encodeRunEventCursor,
  eventEnvelopeSchema,
  parseRunEventCursor,
  persistedRunEventSchema,
  runStreamControlSchema,
} from '../event.js'

const valid = {
  schemaVersion: 1,
  eventId: '00000000-0000-4000-8000-000000000041',
  type: 'run.status_changed',
  occurredAt: '2026-09-10T08:00:02.000Z',
  runId: '00000000-0000-4000-8000-000000000042',
  workerId: 'local-worker',
  requestId: 'req-create-1',
  sequence: 3,
  payload: { status: 'RUNNING' },
}

describe('eventEnvelopeSchema', () => {
  it('接受闭合词表内的事件', () => {
    expect(eventEnvelopeSchema.parse(valid)).toMatchObject({ type: 'run.status_changed', sequence: 3 })
  })

  it('拒绝自造事件名', () => {
    expect(() => eventEnvelopeSchema.parse({ ...valid, type: 'run.updated' })).toThrow()
  })

  it('requestId 复用 HTTP 关联 ID 形状', () => {
    expect(() => eventEnvelopeSchema.parse({ ...valid, requestId: 'bad id' })).toThrow()
  })

  it('接受取消与认证事件名', () => {
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.cancel_requested' }).type).toBe(
      'run.cancel_requested',
    )
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_wait' }).type).toBe('run.auth_wait')
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_decision' }).type).toBe('run.auth_decision')
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_signal' }).type).toBe('run.auth_signal')
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_control_changed' }).type).toBe(
      'run.auth_control_changed',
    )
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_gate_closed' }).type).toBe(
      'run.auth_gate_closed',
    )
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_recovering' }).type).toBe(
      'run.auth_recovering',
    )
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_recovered' }).type).toBe(
      'run.auth_recovered',
    )
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.auth_unrecoverable' }).type).toBe(
      'run.auth_unrecoverable',
    )
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'run.page_handoff' }).type).toBe('run.page_handoff')
    expect(eventEnvelopeSchema.parse({ ...valid, type: 'evidence.missing' }).type).toBe(
      'evidence.missing',
    )
  })
})

describe('persistedRunEventSchema', () => {
  it('要求 runId 与从 1 起的序号', () => {
    expect(persistedRunEventSchema.parse(valid).sequence).toBe(3)
    expect(() => persistedRunEventSchema.parse({ ...valid, sequence: 0 })).toThrow()
    const { runId: _runId, ...missingRun } = valid
    expect(() => persistedRunEventSchema.parse(missingRun)).toThrow()
  })
})

describe('run event cursor', () => {
  it('编解码 runId:sequence', () => {
    const cursor = encodeRunEventCursor(valid.runId, 4)
    expect(cursor).toBe(`${valid.runId}:4`)
    expect(parseRunEventCursor(cursor)).toEqual({ runId: valid.runId, sequence: 4 })
  })

  it('拒绝坏格式', () => {
    expect(parseRunEventCursor(valid.eventId)).toBeNull()
    expect(parseRunEventCursor(`${valid.runId}:`)).toBeNull()
    expect(parseRunEventCursor('not-a-uuid:1')).toBeNull()
  })
})

describe('runStreamControlSchema', () => {
  it('接受 ready / reset / complete / error', () => {
    expect(
      runStreamControlSchema.parse({
        kind: 'ready',
        runId: valid.runId,
        eventSeq: 0,
        earliestEventSeq: 0,
        realtime: true,
      }).kind,
    ).toBe('ready')
    const reset = runStreamControlSchema.parse({
      kind: 'reset',
      runId: valid.runId,
      reason: 'cursor_expired',
    })
    expect(reset).toMatchObject({ kind: 'reset', reason: 'cursor_expired' })
  })
})
