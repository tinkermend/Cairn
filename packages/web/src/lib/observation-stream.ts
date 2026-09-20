import type { ZodType } from 'zod'
import { useAuthStore } from '@/stores/auth-store'
import { readSseStream } from './sse'

/** Each connection starts with an authoritative persisted snapshot, including reconnects. */
export async function subscribeObservation<T>(input: {
  path: string
  schema: ZodType<T>
  signal: AbortSignal
  onObservation: (value: T) => void
  isFinished: (value: T) => boolean
}) {
  let retryMs = 1000
  while (!input.signal.aborted) {
    const connection = new AbortController()
    const signal = AbortSignal.any([input.signal, connection.signal])
    let finished = false
    let fatal: Error | undefined
    try {
      const token = useAuthStore.getState().auth.accessToken
      const response = await fetch(input.path, {
        signal,
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      if ([400, 401, 403, 404].includes(response.status)) {
        fatal = new Error('实时进度不可访问，请刷新检查当前权限')
        throw fatal
      }
      if (!response.ok || !response.body) throw new Error('实时连接中断')
      await readSseStream(
        response.body,
        (frame) => {
          if (frame.event === 'error') {
            fatal = new Error('实时进度不可访问，请刷新重连')
            throw fatal
          }
          if (frame.event !== 'observation') return
          const parsed = input.schema.safeParse(JSON.parse(frame.data))
          if (!parsed.success) {
            fatal = new Error('实时进度格式无效，请刷新重连')
            throw fatal
          }
          retryMs = 1000
          input.onObservation(parsed.data)
          finished = input.isFinished(parsed.data)
          if (finished) connection.abort()
        },
        signal
      )
    } catch {
      if (fatal) throw fatal
    } finally {
      connection.abort()
    }
    if (finished || input.signal.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, retryMs)
      input.signal.addEventListener('abort', done, { once: true })
    })
    retryMs = Math.min(15_000, retryMs * 2)
  }
}
