import type { Page } from 'playwright'
import type { AuthControlInputReceipt, BrowserAuthInputCommand } from '@cairn/shared'

export function handoffMessage(code: string): string {
  if (code === 'PAGE_HANDOFF_NO_POPUP') return '点击后没有出现可交接的弹出窗口'
  if (code === 'PAGE_HANDOFF_AMBIGUOUS') return '点击后出现多个弹出窗口，无法判定交接目标'
  if (code === 'PAGE_HANDOFF_OUT_OF_SCOPE') return '弹出窗口超出目标系统允许范围'
  if (code === 'PAGE_HANDOFF_CLOSED') return '弹出窗口在交接前已关闭'
  return '页面交接失败'
}

export function enqueueSerial<T>(
  live: { serial: Promise<void> },
  fn: () => Promise<T>,
): Promise<T> {
  const run = live.serial.then(fn, fn)
  live.serial = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function viewportMatches(
  actual: { width: number; height: number } | null,
  expected: { width: number; height: number },
): boolean {
  if (!actual) return true
  return Math.abs(actual.width - expected.width) <= 16 && Math.abs(actual.height - expected.height) <= 16
}

export async function applyAuthInput(page: Page, command: BrowserAuthInputCommand): Promise<void> {
  if (command.type === 'mouse_click') {
    await page.mouse.click(command.x, command.y, { button: command.button })
    return
  }
  if (command.type === 'mouse_wheel') {
    await page.mouse.move(command.x, command.y)
    await page.mouse.wheel(command.deltaX, command.deltaY)
    return
  }
  if (command.type === 'key') {
    await page.keyboard.press(command.key)
    return
  }
  const focused = page.locator(':focus')
  if (await focused.count()) {
    // Vue / Element 密码框不吃裸 insertText；fill 会触发 input/change。
    await focused.fill(command.text)
    return
  }
  await page.keyboard.insertText(command.text)
}

export function rememberReceipt(
  receipts: Map<string, AuthControlInputReceipt>,
  receipt: AuthControlInputReceipt,
): AuthControlInputReceipt {
  receipts.set(receipt.commandId, receipt)
  if (receipts.size > 64) {
    const oldest = receipts.keys().next().value
    if (oldest) receipts.delete(oldest)
  }
  return receipt
}
