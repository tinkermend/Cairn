/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Mode } from '@recorder/recorderTypes';
import type { CrxApplication } from 'playwright-crx';
import playwright, { crx, _debug, _setUnderTest, _isUnderTest as isUnderTest } from 'playwright-crx';
import { recordingBridgeAckSchema, recordingBridgeStartSchema } from '@cairn/shared';
import { CAIRN_API, CAIRN_ATTACH, CAIRN_DETACH, CAIRN_OPEN_TARGET, CAIRN_STATUS, WORKBENCH_PATH, canAttachRecorder, chooseRecordingTab, handleCairnApiMessage, loadCairnSession, nextRecorderPanelPath, onExtensionInstalled, savePendingBridge, withDeadline } from './cairn';
import type { CrxSettings } from './settings';
import { addSettingsChangedListener, defaultSettings, loadSettings } from './settings';
import { CAPTURE_CHANGED, CAPTURE_GET, CAPTURE_RESET, DemonstrationCapture } from './cairn/capture';

const demonstrationCapture = new DemonstrationCapture(state => { void chrome.runtime.sendMessage({ event: CAPTURE_CHANGED, state }).catch(() => {}); });
// A different actor/environment must never inherit the previous actor's local facts.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const account = changes.cairnAccount;
  const environment = changes.cairnEnvironmentId;
  if ((account && account.oldValue?.id !== account.newValue?.id) || (environment && environment.oldValue !== environment.newValue)) demonstrationCapture.reset();
});
Object.assign(globalThis, { __cairnCaptureBegin: demonstrationCapture.begin.bind(demonstrationCapture) });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  if (message?.event === CAPTURE_GET) reply(demonstrationCapture.get());
  if (message?.event === CAPTURE_RESET) { demonstrationCapture.reset(); reply(demonstrationCapture.get()); }
});

type CrxMode = Mode | 'detached';

const stoppedModes: CrxMode[] = ['none', 'standby', 'detached'];
const recordingModes: CrxMode[] = ['recording', 'assertingText', 'assertingVisibility', 'assertingValue', 'assertingSnapshot'];

// we must lazy initialize it
let crxAppPromise: Promise<CrxApplication> | undefined;

const attachedTabIds = new Set<number>();
let lastTargetTabId: number | undefined;
let currentMode: CrxMode | 'detached' | undefined;
let settings: CrxSettings = defaultSettings;

/** 录制器接管侧栏后，产品侧不能再改侧栏路径：重载会断端口，vendor 会当成关闭录制器。 */
let recorderOwnsPanel = false;

const SHOW_RECORDER_TIMEOUT_MS = 10_000;

// if it's in sidepanel mode, we need to open it synchronously on action click,
// so we need to fetch its value asap
const settingsInitializing = loadSettings().then(s => settings = s).catch(() => {});

addSettingsChangedListener(newSettings => {
  settings = newSettings;
  setTestIdAttributeName(newSettings.testIdAttributeName);
});

let allowsIncognitoAccess = false;
chrome.extension.isAllowedIncognitoAccess().then(allowed => {
  allowsIncognitoAccess = allowed;
});

async function changeAction(tabId: number, mode?: CrxMode | 'detached') {
  if (!mode)
    mode = attachedTabIds.has(tabId) ? currentMode : 'detached';
  else if (mode !== 'detached')
    currentMode = mode;


  // detached basically implies recorder windows was closed
  if (!mode || stoppedModes.includes(mode)) {
    await Promise.all([
      chrome.action.setTitle({ title: mode === 'none' ? '已停止' : '录制', tabId }),
      chrome.action.setBadgeText({ text: '', tabId }),
    ]).catch(() => {});
    return;
  }

  const { text, title, color, bgColor } = recordingModes.includes(mode) ?
    { text: 'REC', title: '正在录制', color: 'white', bgColor: 'darkred' } :
    { text: 'INS', title: '正在检查', color: 'white', bgColor: 'dodgerblue' };

  await Promise.all([
    chrome.action.setTitle({ title, tabId }),
    chrome.action.setBadgeText({ text, tabId }),
    chrome.action.setBadgeTextColor({ color, tabId }),
    chrome.action.setBadgeBackgroundColor({ color: bgColor, tabId }),
  ]).catch(() => {});
}

// action state per tab is reset every time a navigation occurs
// https://bugs.chromium.org/p/chromium/issues/detail?id=1450904
chrome.tabs.onUpdated.addListener(tabId => changeAction(tabId));

async function getCrxApp(incognito: boolean) {
  if (!crxAppPromise) {
    await settingsInitializing;

    crxAppPromise = crx.start({ incognito }).then(crxApp => {
      crxApp.recorder.addListener('hide', async () => {
        recorderOwnsPanel = false;
        await crxApp.close();
        crxAppPromise = undefined;
      });
      crxApp.recorder.addListener('modechanged', async ({ mode }) => {
        await Promise.all([...attachedTabIds].map(tabId => changeAction(tabId, mode)));
      });
      crxApp.addListener('attached', async ({ tabId }) => {
        attachedTabIds.add(tabId);
        await changeAction(tabId, crxApp.recorder.mode());
      });
      crxApp.addListener('detached', async tabId => {
        attachedTabIds.delete(tabId);
        await changeAction(tabId, 'detached');
      });
      setTestIdAttributeName(settings.testIdAttributeName);
      return crxApp;
    });
  }
  return await crxAppPromise;
}

async function attach(tab: chrome.tabs.Tab, mode?: Mode) {
  if (!tab?.id || (attachedTabIds.has(tab.id) && !mode))
    return;

  // if the tab is incognito, chek if can be started in incognito mode.
  if (tab.incognito && !allowsIncognitoAccess)
    throw new Error('未授权在无痕窗口运行。');

  const sidepanel = !isUnderTest() && settings.sidepanel;

  // 面板自己发起挂接时侧栏已经开着，而 `sidePanel.open()` 没有用户手势会被 Chrome 拒绝。
  // 这一步只是兜底，不能让它决定挂不挂得上。
  if (sidepanel)
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});

  // ensure one attachment at a time
  chrome.action.disable();
  if (tab.url?.startsWith('chrome://')) {
    const windowId = tab.windowId;
    tab = await new Promise(resolve => {
      // we will not be able to attach to this tab, so we need to open a new one
      chrome.tabs.create({ windowId, url: 'about:blank' }).
          then(tab => {
            resolve(tab);
          }).
          catch(() => {});
    });
  }

  const crxApp = await getCrxApp(tab.incognito);

  try {

    if (crxApp.recorder.isHidden()) {
      // 侧栏此刻已经开着工作台，路径不变 Chrome 不会重载页面，vendor 就等不到新端口。
      const url = sidepanel ? nextRecorderPanelPath() : WORKBENCH_PATH;
      await withDeadline(
        crxApp.recorder.show({
          mode: mode ?? 'recording',
          language: 'javascript',
          window: { type: sidepanel ? 'sidepanel' : 'popup', url },
          playInIncognito: settings.playInIncognito,
        }),
        SHOW_RECORDER_TIMEOUT_MS,
        '侧栏没有接上录制器，请关掉侧栏再重新打开',
      );
      recorderOwnsPanel = sidepanel;
    }

    await crxApp.attach(tab.id!);

    if (mode)
      await crxApp.recorder.setMode(mode);
  } finally {
    chrome.action.enable();
  }
}

async function setTestIdAttributeName(testIdAttributeName: string) {
  playwright.selectors.setTestIdAttribute(testIdAttributeName);
}

function rememberTab(tab?: chrome.tabs.Tab) {
  if (tab?.id && tab.url && !tab.url.startsWith('chrome-extension://'))
    lastTargetTabId = tab.id;
}

async function openWorkbench(windowId?: number) {
  // 正在录制时改 path 会重载侧栏、断开端口，vendor 会把这一段录制停掉。
  if (!recorderOwnsPanel)
    await chrome.sidePanel.setOptions({ path: WORKBENCH_PATH, enabled: true });
  if (windowId !== undefined)
    await chrome.sidePanel.open({ windowId });
}

async function onOpenWorkbench(tab?: chrome.tabs.Tab) {
  rememberTab(tab);
  await openWorkbench(tab?.windowId);
}

async function resolveTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  let remembered: chrome.tabs.Tab | undefined;
  if (lastTargetTabId) {
    try {
      remembered = await chrome.tabs.get(lastTargetTabId);
    } catch {
      lastTargetTabId = undefined;
    }
  }
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  return chooseRecordingTab(tabs, remembered);
}

async function attachIfAuthed(mode?: Mode) {
  const session = await loadCairnSession();
  if (!canAttachRecorder(session))
    throw new Error('请先登录识途');
  const tab = await resolveTargetTab();
  if (!tab)
    throw new Error('没有可挂接的标签页');
  await attach(tab, mode);
}

/** 面板要写清「正在录哪一页」，被录标签页的事实只有 background 知道。 */
async function attachStatus(): Promise<{ attached: boolean; title: string; url: string }> {
  for (const tabId of attachedTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return { attached: true, title: tab.title ?? '', url: tab.url ?? '' };
    } catch {
      attachedTabIds.delete(tabId);
    }
  }
  return { attached: false, title: '', url: '' };
}

async function detachAll() {
  recorderOwnsPanel = false;
  if (!crxAppPromise)
    return;
  const crxApp = await crxAppPromise;
  await crxApp.close();
  crxAppPromise = undefined;
  attachedTabIds.clear();
}

chrome.action.onClicked.addListener(onOpenWorkbench);

chrome.contextMenus.create({
  id: 'pw-recorder',
  title: '打开识途录制器',
  contexts: ['all'],
});

chrome.contextMenus.onClicked.addListener(async (_, tab) => {
  await onOpenWorkbench(tab);
});

chrome.commands.onCommand.addListener(async (_command, tab) => {
  await onOpenWorkbench(tab);
});

chrome.runtime.onMessage.addListener((message, _, sendResponse) => {
  // 挂接会重载侧栏，发起请求的页面可能已经不在了。
  const respond = (value: unknown) => {
    try {
      sendResponse(value);
    } catch {
    }
  };
  if (message.event === CAIRN_API) {
    handleCairnApiMessage(message).then(respond).catch((error: Error) => {
      respond({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.event === CAIRN_ATTACH) {
    attachIfAuthed(message.mode).then(() => respond({ ok: true })).catch((error: Error) => {
      respond({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.event === CAIRN_DETACH) {
    detachAll().then(() => respond({ ok: true })).catch((error: Error) => {
      respond({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.event === CAIRN_STATUS) {
    attachStatus().then(respond).catch(() => {
      respond({ attached: false, title: '', url: '' });
    });
    return true;
  }
  if (message.event === CAIRN_OPEN_TARGET && typeof message.url === 'string') {
    chrome.tabs.create({ url: message.url }).then((tab) => {
      rememberTab(tab);
      respond({ ok: true });
    }).catch((error: Error) => respond({ ok: false, error: error.message }));
    return true;
  }
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const parsed = recordingBridgeStartSchema.safeParse(message);
  if (!parsed.success) {
    sendResponse({ version: 1, type: 'cairn.recording.ack', bindingId: '00000000-0000-4000-8000-000000000000', opened: false, attached: false, reason: '消息无法识别' });
    return false;
  }
  const rawOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');
  const allowed = new Set([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ]);
  if (!rawOrigin || !allowed.has(rawOrigin)) {
    sendResponse(recordingBridgeAckSchema.parse({
      version: 1,
      type: 'cairn.recording.ack',
      bindingId: parsed.data.bindingId,
      opened: false,
      attached: false,
      reason: '来源不受信任',
    }));
    return false;
  }
  savePendingBridge(parsed.data).then(async () => {
    let opened = false;
    try {
      if (sender.tab?.windowId !== undefined)
        await chrome.sidePanel.open({ windowId: sender.tab.windowId });
      opened = true;
    } catch {
      opened = false;
    }
    sendResponse(recordingBridgeAckSchema.parse({
      version: 1,
      type: 'cairn.recording.ack',
      bindingId: parsed.data.bindingId,
      opened,
      attached: false,
      reason: opened ? undefined : 'USER_GESTURE_REQUIRED',
    }));
  }).catch((error: Error) => {
    sendResponse(recordingBridgeAckSchema.parse({
      version: 1,
      type: 'cairn.recording.ack',
      bindingId: parsed.data.bindingId,
      opened: false,
      attached: false,
      reason: error.message,
    }));
  });
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  if ((globalThis as any).__crxTest)
    return;
  onExtensionInstalled(details);
});

// for testing
Object.assign(self, { attach, setTestIdAttributeName, getCrxApp, _debug, _setUnderTest });
