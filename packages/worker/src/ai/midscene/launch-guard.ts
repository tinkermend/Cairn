import type { Browser, BrowserType } from 'playwright'

type Launchable = Pick<BrowserType, 'launch' | 'launchPersistentContext'>

/**
 * persistent context 的 browser() 为 null，「额外 Browser」改验：适配期间禁止 launch。
 */
export async function withLaunchBanned<T>(playwright: { chromium: Launchable }, run: () => Promise<T>): Promise<T> {
  const originalLaunch = playwright.chromium.launch
  const originalPersistent = playwright.chromium.launchPersistentContext
  const banned = async () => {
    throw new Error('CAIRN_LAUNCH_BANNED')
  }
  playwright.chromium.launch = banned as typeof originalLaunch
  playwright.chromium.launchPersistentContext = banned as typeof originalPersistent
  try {
    return await run()
  } finally {
    playwright.chromium.launch = originalLaunch
    playwright.chromium.launchPersistentContext = originalPersistent
  }
}

export function banNewContext(browser: Browser | null): () => void {
  if (!browser) return () => {}
  const original = browser.newContext.bind(browser)
  browser.newContext = async () => {
    throw new Error('CAIRN_LAUNCH_BANNED')
  }
  return () => {
    browser.newContext = original
  }
}
