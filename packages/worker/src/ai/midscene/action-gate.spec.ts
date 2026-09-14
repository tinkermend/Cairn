import { describe, expect, it } from 'vitest'
import { ActionGate, createCallBarrier, gateActions } from './action-gate.js'

describe('ActionGate', () => {
  it('abort 后动作边抛错，不再调用原 call', async () => {
    const controller = new AbortController()
    const gate = new ActionGate(controller.signal)
    let called = 0
    const [click] = gateActions(
      [
        {
          name: 'Click',
          call: async () => {
            called += 1
          },
        },
      ],
      gate,
    )
    await click!.call()
    expect(called).toBe(1)
    controller.abort()
    await expect(click!.call()).rejects.toThrow('CAIRN_ABORTED:action')
    expect(called).toBe(1)
  })

  it('丢租与 abort 走同一检查', async () => {
    const gate = new ActionGate()
    const [click] = gateActions([{ name: 'Click', call: async () => 'ok' }], gate)
    gate.markLeaseLost()
    await expect(click!.call()).rejects.toThrow('CAIRN_LEASE_LOST:action')
  })

  it('屏障扣住第 N 次再放行', async () => {
    const barrier = createCallBarrier()
    const order: string[] = []
    const pending = (async () => {
      await barrier.waitIf(1)
      order.push('first')
    })()
    await Promise.resolve()
    expect(order).toEqual([])
    barrier.release()
    await pending
    expect(order).toEqual(['first'])
    expect(barrier.seen).toBe(1)
  })
})
