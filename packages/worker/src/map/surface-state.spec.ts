import { describe, expect, it } from 'vitest'
import { classifySurface } from './surface-state.js'

describe('被动观察表面状态夹具', () => {
  it('OMB08 未授权 Frame 与 epoch 变化分别给出能力/表面缺口', () => {
    const blocked = classifySurface({
      url: 'https://shop.example/orders',
      origin: 'https://shop.example',
      frames: [
        { origin: 'https://shop.example', authorized: true },
        { origin: 'https://ads.example', authorized: false },
      ],
    })
    expect(blocked.reason).toBe('CAPABILITY_MISSING')
    expect(blocked.capability.frames).toBe('blocked')
    expect(
      classifySurface({
        url: 'https://shop.example/orders',
        origin: 'https://shop.example',
        frames: [{ origin: 'https://shop.example', authorized: true }],
        canvas: true,
      }).capability.canvas,
    ).toBe('unsupported')

    const changed = classifySurface({
      url: 'https://shop.example/next',
      origin: 'https://shop.example',
      frames: [{ origin: 'https://shop.example', authorized: true }],
      navigationEpoch: '2',
      expectedEpoch: '1',
    })
    expect(changed.reason).toBe('SURFACE_CHANGED')
    expect(changed.stateSummary.regions.page).toMatchObject({ surfaceChanged: true })
  })

  it('空白页和占位 URL 不记为已观察表面', () => {
    expect(
      classifySurface({
        url: 'about:blank',
        origin: 'null',
        frames: [],
      }).reason,
    ).toBe('NOT_APPLICABLE')
    expect(
      classifySurface({
        url: 'https://unknown.invalid/',
        origin: 'https://unknown.invalid',
        frames: [],
      }).reason,
    ).toBe('NOT_APPLICABLE')
  })

  it('OMB09 empty+ready、loading、虚拟未挂载、遮挡同时保留', () => {
    const state = classifySurface({
      url: 'https://shop.example/orders',
      origin: 'https://shop.example',
      frames: [],
      empty: true,
      ready: true,
      loading: true,
      virtualUnmounted: true,
      occluded: true,
    })
    expect(state.stateSummary.regions.page).toEqual({
      empty: true,
      ready: true,
      loading: true,
      virtualUnmounted: true,
      occluded: true,
    })
  })
})
