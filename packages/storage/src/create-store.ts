import { S3Client } from '@aws-sdk/client-s3'
import { LocalObjectStore } from './local-store.js'
import { resolveLocalObjectStoreDir } from './repo-root.js'
import { S3ObjectStore } from './s3-store.js'
import type { ObjectStore } from './types.js'

export type ObjectStoreConfig = {
  CAIRN_OBJECT_STORE: 'local' | 's3'
  CAIRN_OBJECT_STORE_DIR: string
  CAIRN_OBJECT_MAX_BYTES: number
  CAIRN_S3_ENDPOINT?: string
  CAIRN_S3_REGION: string
  CAIRN_S3_BUCKET?: string
  CAIRN_S3_ACCESS_KEY?: string
  CAIRN_S3_SECRET_KEY?: string
  CAIRN_S3_FORCE_PATH_STYLE: boolean
}

export function createObjectStore(
  env: ObjectStoreConfig,
  options: { repoRoot: () => string },
): ObjectStore {
  if (env.CAIRN_OBJECT_STORE === 'local') {
    const root = resolveLocalObjectStoreDir(env.CAIRN_OBJECT_STORE_DIR, options.repoRoot)
    return new LocalObjectStore(root, env.CAIRN_OBJECT_MAX_BYTES)
  }

  const client = new S3Client({
    region: env.CAIRN_S3_REGION,
    endpoint: env.CAIRN_S3_ENDPOINT,
    forcePathStyle: env.CAIRN_S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.CAIRN_S3_ACCESS_KEY ?? '',
      secretAccessKey: env.CAIRN_S3_SECRET_KEY ?? '',
    },
  })
  return new S3ObjectStore(client, env.CAIRN_S3_BUCKET ?? '', env.CAIRN_OBJECT_MAX_BYTES)
}
