import { describe, expect, it, vi } from 'vitest'
import { WORKBENCH_PATH, nextRecorderPanelPath, openWorkbenchPanel, resetRecorderPanelPath, withDeadline } from '../panel-window'

/**
 * 复刻两个真实约束，回归录制/选取按钮点了没反应的那个 bug：
 * 1. Chrome：`sidePanel.setOptions` 路径没变时不会重新加载侧栏页面；
 * 2. playwright-crx：`SidepanelRecorderWindow` 先注册一次性 `onConnect`，再 setOptions，
 *    然后一直等这个连接才让 `recorder.show()` 返回。
 */
type ConnectListener = () => void

class FakeSidePanelHost {
  private listeners: ConnectListener[] = []
  private loadedPath: string | undefined

  addConnectListener(listener: ConnectListener) {
    this.listeners.push(listener)
  }

  removeConnectListener(listener: ConnectListener) {
    this.listeners = this.listeners.filter((item) => item !== listener)
  }

  open(path: string) {
    this.load(path)
  }

  setOptions(path: string) {
    if (this.loadedPath === path) return
    this.load(path)
  }

  private load(path: string) {
    this.loadedPath = path
    for (const listener of [...this.listeners]) listener()
  }
}

function showRecorder(host: FakeSidePanelHost, url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const listener = () => {
      host.removeConnectListener(listener)
      resolve()
    }
    host.addConnectListener(listener)
    host.setOptions(url)
  })
}

describe('录制器接管已经打开的侧栏', () => {
  it('沿用当前路径会永远等不到端口，按钮就成了死键', async () => {
    const host = new FakeSidePanelHost()
    host.open(WORKBENCH_PATH)
    await expect(withDeadline(showRecorder(host, WORKBENCH_PATH), 20, '接管超时')).rejects.toThrow(
      '接管超时',
    )
  })

  it('换一个路径能让侧栏重载并重连，接管随之完成', async () => {
    resetRecorderPanelPath()
    const host = new FakeSidePanelHost()
    host.open(WORKBENCH_PATH)
    await expect(
      withDeadline(showRecorder(host, nextRecorderPanelPath()), 20, '接管超时'),
    ).resolves.toBeUndefined()
  })

  it('停掉再录一次也要重载，第二段录制不能靠上一段的路径', async () => {
    resetRecorderPanelPath()
    const host = new FakeSidePanelHost()
    host.open(WORKBENCH_PATH)
    const first = nextRecorderPanelPath()
    await withDeadline(showRecorder(host, first), 20, '接管超时')
    await expect(
      withDeadline(showRecorder(host, nextRecorderPanelPath()), 20, '接管超时'),
    ).resolves.toBeUndefined()
  })
})

describe('从浏览器操作打开工作台', () => {
  it('在用户手势消失前调用 open，再复位侧栏路径', async () => {
    let hasUserGesture = true
    queueMicrotask(() => { hasUserGesture = false })
    const open = vi.fn(async () => {
      if (!hasUserGesture) throw new Error('sidePanel.open() requires a user gesture')
    })
    const setOptions = vi.fn(async () => {})

    await expect(openWorkbenchPanel({ open, setOptions }, 8, false)).resolves.toBeUndefined()
    expect(open).toHaveBeenCalledWith({ windowId: 8 })
    expect(setOptions).toHaveBeenCalledWith({ path: WORKBENCH_PATH, enabled: true })
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(setOptions.mock.invocationCallOrder[0])
  })

  it('录制器占用侧栏时不重载工作台路径', async () => {
    const open = vi.fn(async () => {})
    const setOptions = vi.fn(async () => {})
    await openWorkbenchPanel({ open, setOptions }, 8, true)
    expect(open).toHaveBeenCalledOnce()
    expect(setOptions).not.toHaveBeenCalled()
  })
})
