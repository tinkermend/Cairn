type PageAttachment = {
  attach(tabId: number): Promise<unknown>
  detach(tabId: number): Promise<unknown>
}

export function isDetachedFrameError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Frame has been detached')
}

type ClosableApplication = {
  close(): Promise<void>
  context(): { close(): Promise<void> }
}

const closingApplications = new WeakMap<ClosableApplication, Promise<void>>()

/** Vendor close() may stop before context.close() when a Page's frame was detached. */
export function closeApplication(app: ClosableApplication): Promise<void> {
  const closing = closingApplications.get(app)
  if (closing) return closing
  const work = (async () => {
    try {
      await app.close()
    } catch (error) {
      try {
        await app.context().close()
      } catch {
        throw error
      }
    }
  })()
  closingApplications.set(app, work)
  void work.finally(() => closingApplications.delete(app)).catch(() => {})
  return work
}

/**
 * 导航期间 Page/Frame 树可在 CRX 初始化中被替换。失败的 debugger attachment 必须先
 * 释放，否则再次 attach 会拿到同一个已失败的 Page，而不会重新初始化。
 */
export async function attachPageWithRetry(
  app: PageAttachment,
  tabId: number,
  beforeRetry: (attempt: number) => Promise<void>,
  forceDetach: (tabId: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await app.attach(tabId)
      return
    } catch (error) {
      await app.detach(tabId).catch(() => {})
      if (!isDetachedFrameError(error)) throw error
      // playwright-crx's detach() rethrows the initialization error before
      // debugger.detach(). Release our failed debugger session directly.
      await forceDetach(tabId).catch(() => {})
      if (attempt === 3) throw error
      await beforeRetry(attempt)
    }
  }
}
