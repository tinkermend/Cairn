import type { Plugin } from 'vite'

/** A debugger cancellation can leave the injected recorder in the live document. */
function patchInjectedPollingRecorder(code: string): string {
  const begin = code.indexOf('var PollingRecorder = class {\\n')
  const end = code.indexOf('var pollingRecorder_default = PollingRecorder;', begin)
  if (begin < 0 || end < 0) throw new Error('playwright-crx injected lifecycle seam changed: verify before upgrading')
  let source = code.slice(begin, end)
  const replace = (from: string, to: string) => {
    if (source.split(from).length !== 2) throw new Error('playwright-crx injected lifecycle seam changed: verify before upgrading')
    source = source.replace(from, to)
  }
  replace('  constructor(injectedScript) {\\n    this._recorder = new Recorder(injectedScript);',
    '  constructor(injectedScript) {\\n    if (typeof injectedScript.window.__pw_uninstall === "function") injectedScript.window.__pw_uninstall();\\n    this._recorder = new Recorder(injectedScript);')
  replace('injectedScript.onGlobalListenersRemoved.add(() => this._recorder.installListeners());',
    'injectedScript.onGlobalListenersRemoved.add(() => { if (!this._disposed) this._recorder.installListeners(); });')
  replace('    const refreshOverlay = () => {\\n      this._lastStateJSON = void 0;',
    '    const refreshOverlay = () => {\\n      if (this._disposed) return;\\n      this._lastStateJSON = void 0;')
  replace('    const uninstall = () => {\\n      this._recorder.uninstall();\\n    };',
    '    const uninstall = () => {\\n      if (this._disposed) return;\\n      this._disposed = true;\\n      if (this._pollRecorderModeTimer) this._recorder.injectedScript.utils.builtins.clearTimeout(this._pollRecorderModeTimer);\\n      this._recorder.uninstall();\\n      if (this._embedder.__pw_uninstall === uninstall) {\\n        delete this._embedder.__pw_uninstall;\\n        delete this._embedder.__pw_refreshOverlay;\\n      }\\n    };')
  replace('  async _pollRecorderMode() {\\n    const pollPeriod = 1e3;',
    '  async _pollRecorderMode() {\\n    if (this._disposed) return;\\n    const pollPeriod = 1e3;')
  replace('    const state = await this._embedder.__pw_recorderState().catch(() => null);\\n    if (!state) {',
    '    const state = await this._embedder.__pw_recorderState().catch(() => null);\\n    if (this._disposed) return;\\n    if (!state) {')
  return code.slice(0, begin) + source + code.slice(end)
}

/**
 * playwright-crx@0.15.0 leaves its singleton started when an attached Page
 * initialized with a detached Frame: _doDetach throws before debugger.detach,
 * and close() skips context.close. Keep this patch pinned to the vendored shape.
 */
export function crxLifecyclePlugin(): Plugin {
  let patched = false
  return {
    name: 'cairn-crx-lifecycle',
    transform(code, id) {
      if (!id.includes('playwright-crx/') || !id.endsWith('.mjs') || !code.includes('async _doDetach(targetId)')) return
      const staleTarget = '  async _doDetach(targetId) {\n    var _a2;\n    if (!targetId)\n      return;'
      const failedPage = '    if (pageOrError instanceof Error)\n      throw pageOrError;\n    await Promise.all(['
      const closeBody = `    if (options2 == null ? void 0 : options2.closeWindows) {
      const windows = await chrome.windows.getAll();
      await Promise.all(windows.filter((w) => w.incognito && w.id).map((w) => chrome.windows.remove(w.id)));
    } else {
      await Promise.all(this._crPages().map((crPage) => (options2 == null ? void 0 : options2.closePages) ? crPage.closePage(false) : this._doDetach(crPage._targetId)));
    }
    await this._context.close({});`
      for (const seam of [staleTarget, failedPage, closeBody]) {
        if (code.split(seam).length !== 2) throw new Error('playwright-crx lifecycle seam changed: verify before upgrading')
      }
      patched = true
      return {
        code: patchInjectedPollingRecorder(code
          .replace(staleTarget, '  async _doDetach(targetId) {\n    var _a2;\n    if (!targetId || !this._transport.getTabId(targetId))\n      return;')
          .replace(failedPage, `    if (pageOrError instanceof Error) {
      await this._transport.detach(targetId);
      return;
    }
    await Promise.all([`)
          .replace(closeBody, `    try {
${closeBody.slice(0, -'    await this._context.close({});'.length).trimEnd().split('\n').map(line => `  ${line}`).join('\n')}
    } finally {
      await this._context.close({});
    }`)),
        map: null,
      }
    },
    buildEnd(error) { if (!error && !patched) throw new Error('playwright-crx lifecycle seam not installed') },
  }
}
