/**
 * 识途增量入口。上游 recorder-crx 只从这里接入，避免改内核。
 *
 * 登录、Target、Raw Trace 上传、工作台都放在这个目录。
 */

export { CairnPanel } from './panel'
export { canAttachRecorder } from './auth-gate'
export { loadCairnSession } from './session'
export { CAIRN_ATTACH, CAIRN_DETACH, CAIRN_STATUS, CAIRN_OPEN_TARGET } from './messages'
export { savePendingBridge } from './binding'
export { CAIRN_API, handleCairnApiMessage } from './api-bridge'
export {
  WORKBENCH_PATH,
  nextRecorderPanelPath,
  resetRecorderPanelPath,
  withDeadline,
} from './panel-window'
export { canRecordTab, chooseRecordingTab } from './tab-choice'

export function onExtensionInstalled(_details: chrome.runtime.InstalledDetails) {
  // 不打开上游 GitHub Release 页。企业安装不应跳出仓库。
}
