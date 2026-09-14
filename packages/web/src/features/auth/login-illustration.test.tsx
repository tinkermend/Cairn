import '@/styles/index.css'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { LoginIllustration } from './login-illustration'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('keeps a static fallback, pauses in the background, and replays only after completion', async () => {
  await page.viewport(1440, 900)
  const preference = Object.assign(new EventTarget(), { matches: false })
  vi.stubGlobal('matchMedia', () => preference)
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  await render(
    <div style={{ position: 'relative', width: 684, height: 852 }}>
      <LoginIllustration />
    </div>
  )
  const root = document.querySelector<HTMLDivElement>('.login-illustration')!
  expect(root.dataset.motion).toBe('static')
  expect(root.querySelector('svg')).toBeNull()

  preference.matches = true
  preference.dispatchEvent(new Event('change'))
  await expect.poll(() => root.dataset.motion).toBe('ready')
  const animations = root.getAnimations({ subtree: true })
  expect(animations.length).toBeGreaterThan(0)

  hidden.mockReturnValue(true)
  document.dispatchEvent(new Event('visibilitychange'))
  await expect
    .poll(() =>
      animations.every((animation) => animation.playState === 'paused')
    )
    .toBe(true)
  hidden.mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange'))
  await expect
    .poll(() =>
      animations.every((animation) => animation.playState === 'running')
    )
    .toBe(true)

  animations.forEach((animation) => animation.finish())
  root.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
  await expect
    .poll(() =>
      animations.every(
        (animation) =>
          animation.playState === 'running' &&
          Number(animation.currentTime) < 1000
      )
    )
    .toBe(true)

  preference.matches = false
  preference.dispatchEvent(new Event('change'))
  await expect.poll(() => root.dataset.motion).toBe('static')
  expect(root.querySelector('svg')).toBeNull()
  expect(root.getAnimations({ subtree: true })).toHaveLength(0)
})
