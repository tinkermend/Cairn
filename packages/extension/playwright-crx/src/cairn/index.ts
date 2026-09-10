/**
 * 识途增量入口。上游 recorder-crx 只从这里接入，避免改内核。
 *
 * 后续：登录、Target、Raw Trace 上传都放在这个目录。
 */

export function onExtensionInstalled(_details: chrome.runtime.InstalledDetails) {
  // 不打开上游 GitHub Release 页。企业安装不应跳出仓库。
}
