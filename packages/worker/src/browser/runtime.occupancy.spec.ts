import { describe, expect, it } from 'vitest'
import {
  OccupancyRequiredError,
  clickLocator,
  fillLocator,
  gotoPage,
  launchSession,
  loginWithCredentials,
  navigateInScope,
  openRunPage,
  pressKeys,
  selectLocator,
  takeOccupancyRejects,
  verifyAuthOnPage,
} from './runtime'
import { testOccupancyGrant, withTestOccupancy } from './test-occupancy'

describe('SM34 先占用后触碰', () => {
  it('无合法 grant 时启动、核验、登录、导航、输入被拒绝并记录', async () => {
    takeOccupancyRejects()
    await expect(launchSession('/tmp/cairn-occupancy', { headless: true })).rejects.toBeInstanceOf(
      OccupancyRequiredError,
    )
    await expect(verifyAuthOnPage({} as never, { entryUrl: 'http://127.0.0.1/' })).rejects.toBeInstanceOf(
      OccupancyRequiredError,
    )
    await expect(
      loginWithCredentials({} as never, { entryUrl: 'http://127.0.0.1/' }, { username: 'a', password: 'b' }),
    ).rejects.toBeInstanceOf(OccupancyRequiredError)
    await expect(navigateInScope({} as never, 'http://127.0.0.1/', ['http://127.0.0.1'])).rejects.toBeInstanceOf(
      OccupancyRequiredError,
    )
    await expect(gotoPage({} as never, 'http://127.0.0.1/')).rejects.toBeInstanceOf(OccupancyRequiredError)
    await expect(clickLocator({} as never)).rejects.toBeInstanceOf(OccupancyRequiredError)
    await expect(fillLocator({} as never, 'x')).rejects.toBeInstanceOf(OccupancyRequiredError)
    await expect(selectLocator({} as never, { by: 'value', value: 'x' })).rejects.toBeInstanceOf(
      OccupancyRequiredError,
    )
    await expect(pressKeys({} as never, ['Enter'])).rejects.toBeInstanceOf(OccupancyRequiredError)
    await expect(openRunPage({} as never)).rejects.toBeInstanceOf(OccupancyRequiredError)
    const rejects = takeOccupancyRejects()
    expect(rejects.map((item) => item.action)).toEqual([
      'launchSession',
      'verifyAuthOnPage',
      'loginWithCredentials',
      'navigateInScope',
      'gotoPage',
      'clickLocator',
      'fillLocator',
      'selectLocator',
      'pressKeys',
      'openRunPage',
    ])
  })

  it('过期 grant 同样拒绝', async () => {
    takeOccupancyRejects()
    await expect(
      withTestOccupancy(
        () => verifyAuthOnPage({} as never, { entryUrl: 'http://127.0.0.1/' }),
        testOccupancyGrant({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      ),
    ).rejects.toBeInstanceOf(OccupancyRequiredError)
    const rejected = takeOccupancyRejects().find((item) => item.action === 'verifyAuthOnPage')
    expect(rejected?.expiresAt).toBeDefined()
    expect(Date.parse(rejected!.expiresAt!)).toBeLessThan(Date.now())
  })
})
