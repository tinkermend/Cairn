import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { systemClock } from './clock.js'

describe('systemClock.sleep', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes the abort listener when sleep completes', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const sleeping = systemClock.sleep(250, controller.signal)

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(250)
    await expect(sleeping).resolves.toBeUndefined()
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('clears the timer and listener when aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const sleeping = systemClock.sleep(250, controller.signal)

    controller.abort()
    await expect(sleeping).rejects.toMatchObject({ name: 'AbortError' })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
