import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  app: null as null | Record<string, any>,
  start: vi.fn(),
  debuggerDetach: vi.fn(async () => {}),
}))

vi.mock('playwright-crx', () => ({
  default: { selectors: { setTestIdAttribute: vi.fn() } },
  crx: { start: state.start },
  _debug: vi.fn(),
  _setUnderTest: vi.fn(),
  _isUnderTest: () => true,
}))
vi.mock('./settings', () => ({
  defaultSettings: { sidepanel: false, testIdAttributeName: 'data-testid', playInIncognito: false },
  loadSettings: async () => ({ sidepanel: false, testIdAttributeName: 'data-testid', playInIncognito: false }),
  addSettingsChangedListener: vi.fn(),
}))
vi.mock('./cairn', () => ({
  WORKBENCH_PATH: 'index.html',
  nextRecorderPanelPath: () => 'index.html?panel=test',
  withDeadline: (work: Promise<unknown>) => work,
  openWorkbenchPanel: vi.fn(),
  onExtensionInstalled: vi.fn(),
  chooseRecordingTab: vi.fn((tabs: chrome.tabs.Tab[]) => tabs[0]),
  canAttachRecorder: vi.fn(() => true),
  canRecordTab: vi.fn(() => true),
  loadCairnSession: vi.fn(async () => ({})),
  handleCairnApiMessage: vi.fn(),
  savePendingBridge: vi.fn(),
  CAIRN_API: 'api', CAIRN_ATTACH: 'attach', CAIRN_ATTACHMENT_CHANGED: 'attachmentChanged', CAIRN_RECOVER: 'recover', CAIRN_DETACH: 'detach',
  CAIRN_OPEN_TARGET: 'openTarget', CAIRN_STATUS: 'status', CAIRN_SET_MODE: 'setMode',
}))

function event() { return { addListener: vi.fn() } }

function fakeChrome() {
  return {
    runtime: {
      id: 'test-extension', getURL: () => 'chrome-extension://test-extension/',
      onMessage: event(), onMessageExternal: event(), onInstalled: event(), sendMessage: vi.fn(async () => {}),
    },
    storage: { onChanged: event() },
    extension: { isAllowedIncognitoAccess: async () => false },
    tabs: { onUpdated: event(), get: vi.fn(async () => ({ status: 'complete' })), query: vi.fn(async () => [tab]), create: vi.fn() },
    debugger: { detach: state.debuggerDetach },
    action: {
      disable: vi.fn(), enable: vi.fn(), onClicked: event(), setTitle: vi.fn(async () => {}),
      setBadgeText: vi.fn(async () => {}), setBadgeTextColor: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
    contextMenus: { create: vi.fn(), onClicked: event() },
    commands: { onCommand: event() },
    sidePanel: { open: vi.fn(), setOptions: vi.fn() },
  }
}

function fakeApp(overrides?: { attach?: () => Promise<unknown> }) {
  const events: string[] = []
  let recorderMode = 'none'
  const app = {
    attach: vi.fn(async () => { events.push('attach'); await overrides?.attach?.() }),
    detach: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    context: () => ({ close: vi.fn(async () => {}) }),
    addListener: vi.fn(),
    recorder: {
      addListener: vi.fn(),
      isHidden: () => true,
      show: vi.fn(async (options?: { mode?: string }) => { events.push('show'); recorderMode = options?.mode ?? recorderMode }),
      setMode: vi.fn(async (mode: string) => { events.push('setMode'); recorderMode = mode }),
      mode: () => recorderMode,
    },
  }
  return { app, events }
}

async function loadBackground() {
  vi.resetModules()
  Object.assign(globalThis, { chrome: fakeChrome(), self: globalThis })
  await import('./background')
  return (globalThis as any).attach as (tab: chrome.tabs.Tab, mode: string) => Promise<void>
}

const tab = { id: 18, windowId: 2, url: 'https://example.test/', incognito: false } as chrome.tabs.Tab

describe('后台录制启动顺序', () => {
  beforeEach(() => { state.start.mockReset(); state.debuggerDetach.mockReset().mockResolvedValue(undefined) })

  it('Page 初始化成功后才打开录制窗口并设置模式', async () => {
    const { app, events } = fakeApp()
    state.start.mockResolvedValue(app)
    const attach = await loadBackground()

    await attach(tab, 'recording')

    expect(events).toEqual(['attach', 'show', 'setMode'])
    expect(app.close).not.toHaveBeenCalled()
  })

  it('侧栏端口失联后仍可通过后台查询和切换真实录制模式', async () => {
    const { app } = fakeApp()
    state.start.mockResolvedValue(app)
    const attach = await loadBackground()
    await attach(tab, 'recording')
    const attachedListener = app.addListener.mock.calls.find(([name]) => name === 'attached')?.[1]
    await attachedListener({ tabId: tab.id })
    const listener = (globalThis as any).chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0]
    const send = (message: Record<string, unknown>) => new Promise<any>(resolve => {
      expect(listener(message, {}, resolve)).toBe(true)
    })

    expect((await send({ event: 'status' })).mode).toBe('recording')
    expect(await send({ event: 'setMode', mode: 'standby' })).toEqual({ ok: true })
    expect((await send({ event: 'status' })).mode).toBe('standby')
    expect(app.recorder.setMode).toHaveBeenCalledWith('standby')
  })

  it('Page 一直 detached 时绝不打开录制窗口，并回收 CRX 上下文', async () => {
    const { app, events } = fakeApp({ attach: async () => { throw new Error('Frame has been detached.') } })
    state.start.mockResolvedValue(app)
    const attach = await loadBackground()

    await expect(attach(tab, 'recording')).rejects.toThrow('Frame has been detached')

    expect(events.filter(item => item === 'attach')).toHaveLength(3)
    expect(events).not.toContain('show')
    expect(app.close).toHaveBeenCalledOnce()
    expect((globalThis as any).chrome.action.enable).toHaveBeenCalledOnce()
  })

  it('旧标签页的 Frame 一直 detached 时自动用同一 URL 的新标签页继续录制', async () => {
    const { app: staleApp } = fakeApp({ attach: async () => { throw new Error('Frame has been detached.') } })
    const { app: freshApp } = fakeApp()
    state.start.mockResolvedValueOnce(staleApp).mockResolvedValueOnce(freshApp)
    await loadBackground()
    const chrome = (globalThis as any).chrome
    const freshTab = { ...tab, id: 19, status: 'complete' }
    chrome.tabs.get.mockImplementation(async (id: number) => id === tab.id ? { ...tab, status: 'complete' } : freshTab)
    chrome.tabs.create.mockResolvedValue(freshTab)
    const listener = chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0]

    const response = await new Promise<any>(resolve => {
      expect(listener({ event: 'attach', mode: 'recording' }, {}, resolve)).toBe(true)
    })

    expect(response).toEqual({ ok: true, recovered: true, tabId: 19 })
    expect(staleApp.attach).toHaveBeenCalledTimes(3)
    expect(staleApp.recorder.show).not.toHaveBeenCalled()
    expect(staleApp.close).toHaveBeenCalledOnce()
    expect(chrome.tabs.create).toHaveBeenCalledWith({ windowId: tab.windowId, url: tab.url, active: true })
    expect(freshApp.attach).toHaveBeenCalledWith(19)
    expect(freshApp.recorder.show).toHaveBeenCalledOnce()
  })

  it('新标签页也无法挂接时保留可手动恢复的错误信息', async () => {
    const first = fakeApp({ attach: async () => { throw new Error('Frame has been detached.') } })
    const second = fakeApp({ attach: async () => { throw new Error('Frame has been detached.') } })
    state.start.mockResolvedValueOnce(first.app).mockResolvedValueOnce(second.app)
    await loadBackground()
    const chrome = (globalThis as any).chrome
    const freshTab = { ...tab, id: 19, status: 'complete' }
    chrome.tabs.get.mockImplementation(async (id: number) => id === tab.id ? { ...tab, status: 'complete' } : freshTab)
    chrome.tabs.create.mockResolvedValue(freshTab)
    const listener = chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0]

    const response = await new Promise<any>(resolve => {
      expect(listener({ event: 'attach', mode: 'recording' }, {}, resolve)).toBe(true)
    })

    expect(response).toEqual({ ok: false, error: 'Frame has been detached.', recovery: 'fresh-tab', tabId: tab.id })
  })

  it('不可恢复的旧标签页可由用户显式重新打开，新目标开始录制且保留旧页', async () => {
    const { app } = fakeApp()
    state.start.mockResolvedValue(app)
    await loadBackground()
    const chrome = (globalThis as any).chrome
    const oldTab = { id: 18, windowId: 2, url: 'https://example.test/keys', status: 'complete' }
    const newTab = { id: 19, windowId: 2, url: oldTab.url, status: 'complete' }
    chrome.tabs.get.mockImplementation(async (id: number) => id === 18 ? oldTab : newTab)
    chrome.tabs.create.mockResolvedValue(newTab)
    const listener = chrome.runtime.onMessage.addListener.mock.calls.at(-1)[0]

    const response = await new Promise<any>(resolve => {
      expect(listener({ event: 'recover', tabId: oldTab.id, mode: 'recording' }, {}, resolve)).toBe(true)
    })

    expect(response).toEqual({ ok: true, tabId: 19, url: oldTab.url })
    expect(chrome.tabs.create).toHaveBeenCalledWith({ windowId: 2, url: oldTab.url, active: true })
    expect(app.attach).toHaveBeenCalledWith(19)
    expect(app.recorder.show).toHaveBeenCalledOnce()
  })
})
