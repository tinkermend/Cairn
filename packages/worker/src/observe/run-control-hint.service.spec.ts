import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangeHintBus } from '@cairn/db'
import type { ChangeHint } from '@cairn/shared'
import { RunControlHintService } from './run-control-hint.service'

function createBus() {
  let onHint: ((hint: ChangeHint) => void) | undefined
  let onReconnect: (() => void) | undefined
  let onDisconnect: (() => void) | undefined
  const unsubscribe = vi.fn()
  const subscribe = vi.fn(async (
    hint: (value: ChangeHint) => void,
    reconnect?: () => void,
    disconnect?: () => void,
  ) => {
    onHint = hint
    onReconnect = reconnect
    onDisconnect = disconnect
    return unsubscribe
  })
  const bus = {
    driver: 'postgres',
    realtime: true,
    namespace: 'test',
    publish: vi.fn(async () => undefined),
    subscribe,
    ping: vi.fn(async () => true),
    close: vi.fn(async () => undefined),
  } satisfies ChangeHintBus
  return { bus, subscribe, unsubscribe, hint: (value: ChangeHint) => onHint?.(value), reconnect: () => onReconnect?.(), disconnect: () => onDisconnect?.() }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RunControlHintService', () => {
  it('subscribes once and wakes only the matching Run on a control hint', async () => {
    const { bus, subscribe, hint } = createBus()
    const service = new RunControlHintService(bus)
    const wakeA = vi.fn()
    const wakeB = vi.fn()
    const unregisterA = service.register('run-a', wakeA)
    service.register('run-b', wakeB)

    service.onModuleInit()
    await vi.waitFor(() => expect(service.ready).toBe(true))
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(wakeA).toHaveBeenCalledTimes(1) // First subscription closes the startup race.
    expect(wakeB).toHaveBeenCalledTimes(1)
    wakeA.mockClear()
    wakeB.mockClear()

    hint({ namespace: 'test', eventSeq: 1, runId: 'run-a', runControlChanged: false })
    hint({ namespace: 'test', eventSeq: 2, runId: 'run-a', objectType: 'suite_run', objectId: 'suite-a' })
    expect(wakeA).not.toHaveBeenCalled()
    expect(wakeB).not.toHaveBeenCalled()

    hint({ namespace: 'test', eventSeq: 3, runId: 'run-a', runControlChanged: true })
    hint({ namespace: 'test', eventSeq: 4, runId: 'run-a' }) // Older publishers have no flag.
    expect(wakeA).toHaveBeenCalledTimes(2)
    expect(wakeB).not.toHaveBeenCalled()

    unregisterA()
    hint({ namespace: 'test', eventSeq: 5, runId: 'run-a', runControlChanged: true })
    expect(wakeA).toHaveBeenCalledTimes(2)
    service.onModuleDestroy()
  })

  it('wakes every active Run once when the channel goes down and returns', async () => {
    const { bus, disconnect, reconnect, unsubscribe } = createBus()
    const service = new RunControlHintService(bus)
    const wakeA = vi.fn()
    const wakeB = vi.fn()
    service.register('run-a', wakeA)
    service.register('run-b', wakeB)
    service.onModuleInit()
    await vi.waitFor(() => expect(service.ready).toBe(true))
    wakeA.mockClear()
    wakeB.mockClear()

    disconnect()
    disconnect()
    expect(service.ready).toBe(false)
    expect(wakeA).toHaveBeenCalledTimes(1)
    expect(wakeB).toHaveBeenCalledTimes(1)

    reconnect()
    reconnect()
    expect(service.ready).toBe(true)
    expect(wakeA).toHaveBeenCalledTimes(2)
    expect(wakeB).toHaveBeenCalledTimes(2)

    service.onModuleDestroy()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    disconnect()
    expect(wakeA).toHaveBeenCalledTimes(2)
  })

  it('retries an initial subscription failure without blocking startup', async () => {
    vi.useFakeTimers()
    const { bus, subscribe } = createBus()
    subscribe.mockRejectedValueOnce(new Error('temporarily unavailable'))
    const service = new RunControlHintService(bus)
    const wake = vi.fn()
    service.register('run-a', wake)

    service.onModuleInit()
    expect(service.ready).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(service.ready).toBe(true)
    expect(wake).toHaveBeenCalledTimes(1)
    service.onModuleDestroy()
  })

  it('does not subscribe when realtime hints are disabled', () => {
    const { bus, subscribe } = createBus()
    const service = new RunControlHintService({ ...bus, realtime: false, driver: 'none' })
    service.onModuleInit()
    expect(service.enabled).toBe(false)
    expect(service.ready).toBe(false)
    expect(subscribe).not.toHaveBeenCalled()
    service.onModuleDestroy()
  })
})
