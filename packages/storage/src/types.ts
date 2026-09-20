export type ObjectHead = {
  key: string
  byteSize: number
  digest: string
}

export type PutObjectInput = {
  key: string
  body: Uint8Array
  contentType: string
}

export type ObjectStoreProbeResult = {
  ok: boolean
  latencyMs: number
  errorClass: string | null
}

export type ObjectGetOptions = {
  start?: number
  end?: number
}

export type ObjectGetResult = {
  head: ObjectHead
  body: Uint8Array
  range?: { start: number; end: number; size: number }
}

export interface ObjectStore {
  put(input: PutObjectInput): Promise<ObjectHead>
  /** Bounded file upload for managed derived artifacts; avoids buffering large ZIPs. */
  putFile?(input: { key: string; path: string; contentType: string; maxBytes: number; signal?: AbortSignal }): Promise<ObjectHead>
  get(key: string, options?: ObjectGetOptions): Promise<ObjectGetResult>
  delete(key: string): Promise<void>
  probe(): Promise<ObjectStoreProbeResult>
}
