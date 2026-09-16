import { afterEach, expect, it, vi } from 'vitest'
import { stopSession, type BrowserHandle } from './runtime'

afterEach(() => vi.useRealTimers())

it('浏览器不响应关闭时在期限内返回未确认，不做第二次无界等待', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const close = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const stopped = stopSession({ context: { close } } as unknown as BrowserHandle, 100)
  await vi.advanceTimersByTimeAsync(100)
  expect(await stopped).toBe('unconfirmed')
  expect(close).toHaveBeenCalledOnce()
  finish()
  expect(await stopped).toBe('unconfirmed')
  expect(vi.getTimerCount()).toBe(0)
})

it('确认关闭才返回 stopped，关闭异常保持未确认', async () => {
  expect(await stopSession({ context: { close: async () => {} } } as unknown as BrowserHandle)).toBe('stopped')
  expect(await stopSession({ context: { close: async () => { throw new Error('disconnected') } } } as unknown as BrowserHandle)).toBe('unconfirmed')
})
