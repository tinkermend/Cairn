import { ObjectStoreError } from '@cairn/shared'

type S3LikeError = {
  name?: string
  message?: string
  $metadata?: { httpStatusCode?: number }
  Code?: string
}

export function mapS3Error(error: unknown, fallbackMessage: string): ObjectStoreError {
  if (error instanceof ObjectStoreError) return error
  if (isNotFound(error)) {
    return new ObjectStoreError('OBJECT_NOT_FOUND', '对象不存在', { cause: error })
  }
  return new ObjectStoreError('OBJECT_STORE_UNAVAILABLE', fallbackMessage, { cause: error })
}

export function isNotFound(error: unknown): boolean {
  const e = error as S3LikeError
  const status = e.$metadata?.httpStatusCode
  const name = e.name ?? e.Code ?? ''
  return (
    status === 404 ||
    name === 'NoSuchKey' ||
    name === 'NotFound' ||
    name === 'NotFoundError'
  )
}
