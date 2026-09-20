import { decodeCredentialKey } from './env.js'
import { entityIdSchema } from './wire.js'

/**
 * 服务间 HMAC。只用 globalThis.crypto.subtle，不引入 node:crypto，
 * 避免 shared 在浏览器侧打包失败。
 */

export { DEV_INTERNAL_AUTH_SECRET, DEFAULT_WORKER_INTERNAL_HOST, DEFAULT_WORKER_INTERNAL_PORT } from './env.js'
export {
  workerEndpointMapSchema,
  parseWorkerEndpoints,
  assertWorkerEndpointAllowed,
  type WorkerEndpointMap,
  type WorkerEndpointOptions,
} from './worker-registry.js'
export const INTERNAL_REQUEST_TTL_SECONDS = 30
export const WORKER_INTERNAL_PATH_PREFIX = '/internal/managed-browser'
export const WORKER_RUNS_INTERNAL_PATH_PREFIX = '/internal/runs'
export const WORKER_NODE_HEALTH_PATH = '/internal/node/health'

export function workerInternalPath(suffix: string): string {
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${WORKER_INTERNAL_PATH_PREFIX}${path}`
}

export function workerRunsInternalPath(suffix: string): string {
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${WORKER_RUNS_INTERNAL_PATH_PREFIX}${path}`
}

export type InternalSignInput = {
  method: 'GET' | 'POST'
  path: string
  body: string
  expiresUnix: number
  actorId: string
  runId: string
  sessionGeneration: number
  workerInstanceId: string
}

export function internalCanonicalString(input: InternalSignInput): string {
  return [
    input.method,
    input.path,
    input.body,
    String(input.expiresUnix),
    input.actorId,
    input.runId,
    String(input.sessionGeneration),
    input.workerInstanceId,
  ].join('\n')
}

type SubtleLike = {
  importKey(
    format: 'raw',
    keyData: BufferSource,
    algorithm: { name: 'HMAC'; hash: 'SHA-256' },
    extractable: boolean,
    usages: Array<'sign' | 'verify'>,
  ): Promise<CryptoKey>
  sign(algorithm: 'HMAC', key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>
  digest(algorithm: 'SHA-256', data: BufferSource): Promise<ArrayBuffer>
}

function subtle(): SubtleLike {
  const cryptoApi = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto
  if (!cryptoApi?.subtle) throw new Error('crypto.subtle 不可用')
  return cryptoApi.subtle
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(raw: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(raw))
  return hex(digest)
}

export async function hmacSha256Hex(secret: Uint8Array, message: string): Promise<string> {
  const key = await subtle().importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const signed = await subtle().sign('HMAC', key, new TextEncoder().encode(message))
  return hex(signed)
}

export function requireInternalSecret(raw: string): Uint8Array {
  const bytes = decodeCredentialKey(raw)
  if (!bytes) throw new Error('CAIRN_INTERNAL_AUTH_SECRET 须为 base64 编码的 32 字节密钥')
  return bytes
}

export const INTERNAL_SIGNATURE_HEADERS = {
  expires: 'x-cairn-internal-expires',
  signature: 'x-cairn-internal-signature',
  actor: 'x-cairn-internal-actor',
  run: 'x-cairn-internal-run',
  sessionGeneration: 'x-cairn-internal-session-generation',
  workerInstance: 'x-cairn-internal-worker-instance',
} as const

export async function signInternalHeaders(
  secret: Uint8Array,
  input: InternalSignInput,
): Promise<Record<string, string>> {
  entityIdSchema.parse(input.actorId)
  entityIdSchema.parse(input.runId)
  const signed = { ...input, body: await sha256Hex(input.body) }
  const signature = await hmacSha256Hex(secret, internalCanonicalString(signed))
  return {
    [INTERNAL_SIGNATURE_HEADERS.expires]: String(input.expiresUnix),
    [INTERNAL_SIGNATURE_HEADERS.signature]: signature,
    [INTERNAL_SIGNATURE_HEADERS.actor]: input.actorId,
    [INTERNAL_SIGNATURE_HEADERS.run]: input.runId,
    [INTERNAL_SIGNATURE_HEADERS.sessionGeneration]: String(input.sessionGeneration),
    [INTERNAL_SIGNATURE_HEADERS.workerInstance]: input.workerInstanceId,
  }
}

export async function verifyInternalHeaders(
  secret: Uint8Array,
  input: InternalSignInput & { signature: string; nowUnix?: number },
): Promise<boolean> {
  const now = input.nowUnix ?? Math.floor(Date.now() / 1000)
  if (Math.abs(input.expiresUnix - now) > INTERNAL_REQUEST_TTL_SECONDS) return false
  const signed = { ...input, body: await sha256Hex(input.body) }
  const expected = await hmacSha256Hex(secret, internalCanonicalString(signed))
  if (expected.length !== input.signature.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i)! ^ input.signature.charCodeAt(i)!
  }
  return mismatch === 0
}

export const NODE_HEALTH_SIGNATURE_HEADERS = {
  expires: 'x-cairn-node-expires',
  signature: 'x-cairn-node-signature',
  worker: 'x-cairn-node-worker',
} as const

export type NodeHealthSignInput = {
  method: 'GET'
  path: typeof WORKER_NODE_HEALTH_PATH
  body: string
  expiresUnix: number
  workerId: string
}

export function nodeHealthCanonicalString(input: {
  method: 'GET'
  path: string
  bodyHash: string
  expiresUnix: number
  workerId: string
}): string {
  return ['NODE_HEALTH', input.method, input.path, input.bodyHash, String(input.expiresUnix), input.workerId].join(
    '\n',
  )
}

export async function signNodeHealthHeaders(
  secret: Uint8Array,
  input: NodeHealthSignInput,
): Promise<Record<string, string>> {
  if (!input.workerId || input.workerId.length > 256) {
    throw new Error('节点健康签名缺少合法 Worker ID')
  }
  const signed = {
    method: input.method,
    path: input.path,
    bodyHash: await sha256Hex(input.body),
    expiresUnix: input.expiresUnix,
    workerId: input.workerId,
  }
  const signature = await hmacSha256Hex(secret, nodeHealthCanonicalString(signed))
  return {
    [NODE_HEALTH_SIGNATURE_HEADERS.expires]: String(input.expiresUnix),
    [NODE_HEALTH_SIGNATURE_HEADERS.signature]: signature,
    [NODE_HEALTH_SIGNATURE_HEADERS.worker]: input.workerId,
  }
}

export async function verifyNodeHealthHeaders(
  secret: Uint8Array,
  input: NodeHealthSignInput & { signature: string; nowUnix?: number },
): Promise<boolean> {
  const now = input.nowUnix ?? Math.floor(Date.now() / 1000)
  if (Math.abs(input.expiresUnix - now) > INTERNAL_REQUEST_TTL_SECONDS) return false
  if (!input.workerId || input.workerId.length > 256) return false
  const signed = {
    method: input.method,
    path: input.path,
    bodyHash: await sha256Hex(input.body),
    expiresUnix: input.expiresUnix,
    workerId: input.workerId,
  }
  const expected = await hmacSha256Hex(secret, nodeHealthCanonicalString(signed))
  if (expected.length !== input.signature.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i)! ^ input.signature.charCodeAt(i)!
  }
  return mismatch === 0
}
