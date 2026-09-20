import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ObjectStoreError } from '@cairn/shared'

export async function inspectUpload(path: string, maxBytes: number, signal?: AbortSignal) {
  const info = await stat(path)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3 || !info.isFile() || info.size > maxBytes) throw new ObjectStoreError('OBJECT_TOO_LARGE', '派生文件超过允许大小')
  const hash = createHash('sha256')
  let byteSize = 0
  for await (const chunk of createReadStream(path, { signal })) {
    byteSize += chunk.length
    if (byteSize > maxBytes) throw new ObjectStoreError('OBJECT_TOO_LARGE', '派生文件超过允许大小')
    hash.update(chunk)
  }
  return { byteSize, digest: `sha256:${hash.digest('hex')}` }
}
