import { ObjectStoreError, objectKeySchema } from '@cairn/shared'

export function requireObjectKey(key: string): string {
  const parsed = objectKeySchema.safeParse(key)
  if (!parsed.success) {
    throw new ObjectStoreError('OBJECT_KEY_INVALID', '对象键不合法')
  }
  return parsed.data
}

export function requireSize(body: Uint8Array, maxBytes: number): void {
  if (body.byteLength > maxBytes) {
    throw new ObjectStoreError('OBJECT_TOO_LARGE', `对象超过 ${maxBytes} 字节上限`)
  }
}
