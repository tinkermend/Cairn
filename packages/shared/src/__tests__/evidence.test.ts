import { describe, expect, it } from 'vitest'
import { evidenceMetadataSchema } from '../evidence.js'

const valid = {
  schemaVersion: 1,
  id: '00000000-0000-4000-8000-000000000031',
  runId: '00000000-0000-4000-8000-000000000032',
  attemptId: '00000000-0000-4000-8000-000000000033',
  type: 'screenshot',
  createdAt: '2026-09-10T08:00:01.000Z',
  objectKey: 'cairn-evidence/run/attempt/shot.png',
  contentType: 'image/png',
  byteSize: 128,
}

describe('evidenceMetadataSchema', () => {
  it('接受带对象指针的元数据', () => {
    expect(evidenceMetadataSchema.parse(valid)).toMatchObject({ type: 'screenshot' })
  })

  it('接受缺证据原因，不要求假装有对象', () => {
    const missing = {
      schemaVersion: 1,
      id: valid.id,
      runId: valid.runId,
      type: 'trace',
      createdAt: valid.createdAt,
      missingReason: 'object_store_unavailable',
    }
    expect(evidenceMetadataSchema.parse(missing).missingReason).toBe('object_store_unavailable')
  })

  it('拒绝未知证据类型', () => {
    expect(() => evidenceMetadataSchema.parse({ ...valid, type: 'video' })).toThrow()
  })

  it('拒绝把二进制当字段塞进来', () => {
    expect(() => evidenceMetadataSchema.parse({ ...valid, bytes: 'iVBORw0KGgo=' })).toThrow()
  })

  it('接受结构化 payload', () => {
    const parsed = evidenceMetadataSchema.parse({
      schemaVersion: 1,
      id: valid.id,
      runId: valid.runId,
      type: 'output',
      createdAt: valid.createdAt,
      payload: { waitedMs: 50 },
    })
    expect(parsed.payload).toEqual({ waitedMs: 50 })
  })
})
