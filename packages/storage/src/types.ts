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

export interface ObjectStore {
  put(input: PutObjectInput): Promise<ObjectHead>
  get(key: string): Promise<{ head: ObjectHead; body: Uint8Array }>
  delete(key: string): Promise<void>
}
