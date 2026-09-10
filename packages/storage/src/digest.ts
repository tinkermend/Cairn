import { createHash } from 'node:crypto'

export function sha256Digest(body: Uint8Array): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}
