import { describe, expect, it } from 'vitest'
import { eventEnvelopeSchema } from '../event.js'

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
})
