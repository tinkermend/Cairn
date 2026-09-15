import { act, createRef } from 'react'
import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { AssistantLauncher } from './launcher'

const positionKey = 'cairn:assistant-launcher-position:v1'

async function dispatch(button: HTMLButtonElement, event: Event) {
  const environment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const previous = environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT = true
  try {
    await act(async () => {
      button.dispatchEvent(event)
    })
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = previous
  }
}

async function setup() {
  const buttonRef = createRef<HTMLButtonElement>()
  const onOpen = vi.fn()
  const screen = await render(
    <AssistantLauncher buttonRef={buttonRef} onOpen={onOpen} />
  )
  const button = buttonRef.current!
  // Synthetic pointer events do not register an active browser pointer.
  vi.spyOn(button, 'setPointerCapture').mockImplementation(() => {})
  vi.spyOn(button, 'hasPointerCapture').mockReturnValue(false)
  return { screen, button, onOpen }
}

async function pointer(
  button: HTMLButtonElement,
  type: string,
  x: number,
  y: number,
  pointerType = 'mouse'
) {
  await dispatch(
    button,
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      isPrimary: true,
      pointerType,
      clientX: x,
      clientY: y,
    })
  )
}

async function mouseClick(button: HTMLButtonElement) {
  await dispatch(
    button,
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
    })
  )
}

describe('AssistantLauncher', () => {
  beforeEach(async () => {
    localStorage.removeItem(positionKey)
    await page.viewport(1000, 800)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.removeItem(positionKey)
  })

  it('仅显示头像，拖动结束才保存，松手不误打开，重新挂载恢复位置', async () => {
    const { screen, button, onOpen } = await setup()
    expect(getComputedStyle(button).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(getComputedStyle(button).borderTopWidth).toBe('0px')
    expect(button.getBoundingClientRect().width).toBe(56)
    const start = button.getBoundingClientRect()
    await pointer(button, 'pointerdown', start.x + 28, start.y + 28)
    await pointer(button, 'pointermove', start.x - 172, start.y - 122)
    expect(localStorage.getItem(positionKey)).toBeNull()
    expect(button.getBoundingClientRect().x).toBeCloseTo(start.x - 200, 0)
    expect(button.getBoundingClientRect().y).toBeCloseTo(start.y - 150, 0)
    await pointer(button, 'pointerup', start.x - 172, start.y - 122)
    await mouseClick(button)
    expect(onOpen).not.toHaveBeenCalled()
    expect(localStorage.getItem(positionKey)).not.toBeNull()
    const moved = button.getBoundingClientRect()
    await screen.unmount()
    const restored = await setup()
    expect(restored.button.getBoundingClientRect().x).toBeCloseTo(moved.x, 0)
    expect(restored.button.getBoundingClientRect().y).toBeCloseTo(moved.y, 0)
    await restored.screen.getByRole('button', { name: '打开识途助手' }).click()
    expect(restored.onOpen).toHaveBeenCalledOnce()
  })

  it('轻微手抖仍算点击；触摸拖动取消后恢复原位且不打开', async () => {
    const { button, onOpen } = await setup()
    const start = button.getBoundingClientRect()
    await pointer(button, 'pointerdown', start.x + 28, start.y + 28)
    await pointer(button, 'pointermove', start.x + 30, start.y + 29)
    await pointer(button, 'pointerup', start.x + 30, start.y + 29)
    await mouseClick(button)
    expect(onOpen).toHaveBeenCalledOnce()
    expect(localStorage.getItem(positionKey)).toBeNull()
    onOpen.mockClear()
    await pointer(button, 'pointerdown', start.x + 28, start.y + 28, 'touch')
    await pointer(button, 'pointermove', 400, 300, 'touch')
    expect(button.getBoundingClientRect().x).toBeLessThan(start.x)
    await pointer(button, 'pointercancel', 400, 300, 'touch')
    await mouseClick(button)
    expect(button.getBoundingClientRect().x).toBe(start.x)
    expect(button.getBoundingClientRect().y).toBe(start.y)
    expect(localStorage.getItem(positionKey)).toBeNull()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('拖动不能出界，窗口缩小时仍完整可见', async () => {
    const { button } = await setup()
    await pointer(button, 'pointerdown', 948, 748)
    await pointer(button, 'pointermove', -1000, -1000)
    expect(button.getBoundingClientRect().x).toBe(8)
    expect(button.getBoundingClientRect().y).toBe(8)
    await pointer(button, 'pointermove', 3000, 3000)
    await pointer(button, 'pointerup', 3000, 3000)
    await page.viewport(390, 480)
    await expect.poll(() => button.getBoundingClientRect().right).toBe(382)
    expect(button.getBoundingClientRect().bottom).toBe(472)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  })

  it('方向键和位置控件可以移动，重置恢复默认位置并保持焦点', async () => {
    const { screen, button, onOpen } = await setup()
    const start = button.getBoundingClientRect()
    button.focus()
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}')
    expect(button.getBoundingClientRect().x).toBeCloseTo(start.x - 12, 0)
    expect(button.getBoundingClientRect().y).toBeCloseTo(start.y - 12, 0)
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await expect
      .element(page.getByRole('button', { name: '向左移动助手' }))
      .toBeVisible()
    await page.getByRole('button', { name: '向左移动助手' }).click()
    expect(button.getBoundingClientRect().x).toBeCloseTo(start.x - 36, 0)
    await page.getByRole('button', { name: '重置助手位置' }).click()
    expect(button.getBoundingClientRect().x).toBe(start.x)
    expect(button.getBoundingClientRect().y).toBe(start.y)
    expect(localStorage.getItem(positionKey)).toBeNull()
    await userEvent.keyboard('{Escape}')
    await expect
      .element(screen.getByRole('button', { name: '打开识途助手' }))
      .toHaveFocus()
    expect(onOpen).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('保存值损坏或存储被禁用仍可移动和打开助手', async () => {
    localStorage.setItem(positionKey, '{invalid')
    const { screen, button, onOpen } = await setup()
    expect(button.getBoundingClientRect().x).toBe(920)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    button.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(button.getBoundingClientRect().x).toBeCloseTo(908, 0)
    await screen.getByRole('button', { name: '打开识途助手' }).click()
    expect(onOpen).toHaveBeenCalledOnce()
  })
})
