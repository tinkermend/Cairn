import { randomUUID } from 'node:crypto'
import { ObjectStoreError, isObjectStoreError } from '@cairn/shared'
import type { ObjectStore, ObjectStoreProbeResult } from './types.js'

export async function probeObjectStore(store: Pick<ObjectStore, 'put' | 'get' | 'delete'>): Promise<ObjectStoreProbeResult> {
  const key = `v1/monitoring/probe/${randomUUID()}`
  const started = Date.now()
  const body = new TextEncoder().encode('cairn-probe')
  try {
    await store.put({ key, body, contentType: 'text/plain' })
    const got = await store.get(key)
    if (got.body.byteLength !== body.byteLength) {
      throw new ObjectStoreError('OBJECT_DIGEST_MISMATCH', '探测读回不一致')
    }
    await store.delete(key)
    return { ok: true, latencyMs: Date.now() - started, errorClass: null }
  } catch (error) {
    await store.delete(key).catch(() => undefined)
    return {
      ok: false,
      latencyMs: Date.now() - started,
      errorClass: isObjectStoreError(error) ? error.code : 'UNAVAILABLE',
    }
  }
}
