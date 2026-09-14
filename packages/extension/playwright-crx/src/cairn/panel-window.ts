/** 工作台页面。未挂录制器时由产品侧自己打开。 */
export const WORKBENCH_PATH = 'index.html'

let serial = 0

/**
 * 录制器每次 `show()` 都要一个新的侧栏路径。
 *
 * vendor 的 SidepanelRecorderWindow 先注册一次性 `onConnect`，再
 * `sidePanel.setOptions({ path })`，然后等这个连接。路径与当前相同时 Chrome 不会
 * 重新加载侧栏，页面也就不会重新 connect，`show()` 会一直挂着——按钮看起来没反应。
 */
export function nextRecorderPanelPath(): string {
  serial += 1
  return `${WORKBENCH_PATH}?panel=${serial}`
}

export function resetRecorderPanelPath(): void {
  serial = 0
}

/** 给挂在 vendor 内部的等待加上限，超时给出可执行的原因而不是静默卡住。 */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
