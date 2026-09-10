import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'

/**
 * 全局错误提示。只认 apiFetch 抛出的 ApiRequestError——
 * 那是与 @cairn/shared 契约同源的一条路，不再从 Axios 的 `response.data.title`
 * 猜服务端想说什么。
 */
export function handleServerError(error: unknown) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(error)
  }

  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    Number(error.status) === 204
  ) {
    toast.error('No content.')
    return
  }

  if (error instanceof ApiRequestError) {
    // 开发态附带 requestId，方便直接去服务端日志里对这一次请求；
    // 生产态不给用户看内部标识
    toast.error(import.meta.env.DEV ? `${error.message}（${error.requestId}）` : error.message)
    return
  }

  toast.error('Something went wrong!')
}
