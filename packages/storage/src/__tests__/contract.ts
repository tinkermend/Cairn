import { expect } from 'vitest'
import { ObjectStoreError, objectKeyFor } from '@cairn/shared'
import type { ObjectStore } from '../types.js'
import { sha256Digest } from '../digest.js'

const runId = '00000000-0000-4000-8000-0000000000b1'
const objectId = '00000000-0000-4000-8000-0000000000b2'
const otherId = '00000000-0000-4000-8000-0000000000b3'

export const CONTRACT_KEY = objectKeyFor(runId, objectId)
export const CONTRACT_OTHER_KEY = objectKeyFor(runId, otherId)

export async function runObjectStoreContract(
  store: ObjectStore,
  options: { maxBytes: number; exists?: (key: string) => boolean | Promise<boolean> },
): Promise<void> {
  const body = new TextEncoder().encode('cairn-object-store')
  const digest = sha256Digest(body)

  const first = await store.put({
    key: CONTRACT_KEY,
    body,
    contentType: 'text/plain',
  })
  expect(first).toEqual({ key: CONTRACT_KEY, byteSize: body.byteLength, digest })

  const again = await store.put({
    key: CONTRACT_KEY,
    body,
    contentType: 'application/octet-stream',
  })
  expect(again).toEqual(first)

  const got = await store.get(CONTRACT_KEY)
  expect(got.head).toEqual(first)
  expect(got.body).toEqual(body)

  const conflict = store.put({
    key: CONTRACT_KEY,
    body: new TextEncoder().encode('different'),
    contentType: 'text/plain',
  })
  await expect(conflict).rejects.toMatchObject({ code: 'OBJECT_KEY_CONFLICT' })
  const still = await store.get(CONTRACT_KEY)
  expect(still.body).toEqual(body)

  await store.delete(CONTRACT_KEY)
  await expect(store.get(CONTRACT_KEY)).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' })
  await store.delete(CONTRACT_KEY)

  await expect(
    store.put({
      key: '../escape',
      body,
      contentType: 'text/plain',
    }),
  ).rejects.toBeInstanceOf(ObjectStoreError)
  await expect(
    store.put({
      key: '/abs/path',
      body,
      contentType: 'text/plain',
    }),
  ).rejects.toMatchObject({ code: 'OBJECT_KEY_INVALID' })
  await expect(
    store.put({
      key: 'v1//x',
      body,
      contentType: 'text/plain',
    }),
  ).rejects.toMatchObject({ code: 'OBJECT_KEY_INVALID' })
  await expect(
    store.put({
      key: 'a/b/',
      body,
      contentType: 'text/plain',
    }),
  ).rejects.toMatchObject({ code: 'OBJECT_KEY_INVALID' })

  const huge = new Uint8Array(options.maxBytes + 1)
  await expect(
    store.put({
      key: CONTRACT_OTHER_KEY,
      body: huge,
      contentType: 'application/octet-stream',
    }),
  ).rejects.toMatchObject({ code: 'OBJECT_TOO_LARGE' })
  if (options.exists) {
    expect(await options.exists(CONTRACT_OTHER_KEY)).toBe(false)
  }
}
