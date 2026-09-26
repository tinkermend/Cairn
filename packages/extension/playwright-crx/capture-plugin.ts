import type { Plugin } from 'vite'

/** The upstream recorder consumes every pointer event, including clicks it cannot describe. */
function patchInjectedRecordActionTool(code: string): string {
  const begin = code.indexOf('var RecordActionTool = class {\\n')
  const end = code.indexOf('var TextAssertionTool = class {\\n', begin)
  if (begin < 0 || end < 0) throw new Error('playwright-crx injected recorder seam changed: verify before upgrading')
  let tool = code.slice(begin, end)
  const replace = (from: string, to: string) => {
    if (tool.split(from).length !== 2) throw new Error('playwright-crx injected recorder action seam changed: verify before upgrading')
    tool = tool.replace(from, to)
  }
  replace('  onClick(event) {\\n    if (isRangeInput(this._hoveredElement))',
    '  onClick(event) {\\n    this._refreshModelForEvent(event);\\n    if (isRangeInput(this._hoveredElement))')
  replace('  onDblClick(event) {\\n    if (isRangeInput(this._hoveredElement))',
    '  onDblClick(event) {\\n    this._refreshModelForEvent(event);\\n    if (isRangeInput(this._hoveredElement))')
  replace('  onContextMenu(event) {\\n    if (this._shouldIgnoreMouseEvent(event))',
    '  onContextMenu(event) {\\n    this._refreshModelForEvent(event);\\n    if (this._shouldIgnoreMouseEvent(event))')
  replace('  onPointerDown(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    if (!this._performingActions.size)\\n      consumeEvent(event);',
    '  onPointerDown(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    this._refreshModelForEvent(event);\\n    if (!this._performingActions.size && this._hoveredModel)\\n      consumeEvent(event);')
  replace('  onPointerUp(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    if (!this._performingActions.size)\\n      consumeEvent(event);',
    '  onPointerUp(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    if (!this._performingActions.size && this._hoveredModel)\\n      consumeEvent(event);')
  replace('  onMouseDown(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    if (!this._performingActions.size)\\n      consumeEvent(event);\\n    this._activeModel = this._hoveredModel;',
    '  onMouseDown(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    this._refreshModelForEvent(event);\\n    if (!this._performingActions.size && this._hoveredModel)\\n      consumeEvent(event);\\n    this._activeModel = this._hoveredModel;')
  replace('  onMouseUp(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    if (!this._performingActions.size)\\n      consumeEvent(event);',
    '  onMouseUp(event) {\\n    if (this._shouldIgnoreMouseEvent(event))\\n      return;\\n    if (!this._performingActions.size && this._hoveredModel)\\n      consumeEvent(event);')
  replace('    consumeEvent(event);\\n    return false;\\n  }\\n  _consumedDueToNoModel(event, model) {',
    '    if ((isMouseOrPointerEvent && this._hoveredModel) || (isKeyEvent && this._activeModel))\\n      consumeEvent(event);\\n    return false;\\n  }\\n  _consumedDueToNoModel(event, model) {')
  replace('  _consumedDueToNoModel(event, model) {\\n    if (model)\\n      return false;\\n    consumeEvent(event);\\n    return true;\\n  }',
    '  _consumedDueToNoModel(event, model) {\\n    return !model;\\n  }')
  replace('  _consumedDueWrongTarget(event) {\\n    if (this._activeModel && this._activeModel.elements[0] === this._recorder.deepEventTarget(event))\\n      return false;\\n    consumeEvent(event);\\n    return true;\\n  }',
    '  _consumedDueWrongTarget(event) {\\n    if (this._activeModel && this._activeModel.elements[0] === this._recorder.deepEventTarget(event))\\n      return false;\\n    if (this._activeModel) consumeEvent(event);\\n    return true;\\n  }')
  replace('  _updateModelForHoveredElement() {',
    '  _refreshModelForEvent(event) {\\n    const target = this._recorder.deepEventTarget(event);\\n    if (this._hoveredElement !== target || !this._hoveredModel) {\\n      this._hoveredElement = target;\\n      try { this._updateModelForHoveredElement(); } catch { this._hoveredModel = null; }\\n    }\\n  }\\n  _updateModelForHoveredElement() {')
  return code.slice(0, begin) + tool + code.slice(end)
}

/** Pin the two pre-merge seams. A vendor upgrade must re-prove these seams. */
export function demonstrationCapturePlugin(): Plugin {
  let patched = false
  return { name: 'cairn-demonstration-capture',
    transform(code, id) {
      if (!id.includes('playwright-crx/') || !id.endsWith('.mjs') || !code.includes('async _createActionInContext(frame, action)')) return
      const perform = 'await this._collection.performAction(await this._createActionInContext(frame, action));'
      const record = 'this._collection.addRecordedAction(await this._createActionInContext(frame, action));'
      const standalone = 'addRecordedAction(actionInContext) {\n    if (["openPage", "closePage"].includes(actionInContext.action.name)) {'
      if (code.split(perform).length !== 2 || code.split(record).length !== 2 || code.split(standalone).length !== 2) throw new Error('playwright-crx capture seam changed: verify before upgrading')
      const replace = (mode: string, operation: string) => `const context = await this._createActionInContext(frame, action);
        const complete = await globalThis.__cairnCaptureBegin?.(frame, context, '${mode}');
        try { ${operation} } finally { complete?.(); }`
      patched = true
      const patchedCode = code
        .replace(perform, replace('perform', 'await this._collection.performAction(context);'))
        .replace(record, replace('record', 'this._collection.addRecordedAction(context);'))
        .replace(standalone, `addRecordedAction(actionInContext) {
    if (actionInContext.action.name === "closePage") return;
    if (this._enabled && ["openPage", "navigate"].includes(actionInContext.action.name))
      globalThis.__cairnCaptureStandalone?.(actionInContext);
    if (["openPage", "closePage"].includes(actionInContext.action.name)) {`)
      return { code: patchInjectedRecordActionTool(patchedCode), map: null }
    },
    buildEnd(error) { if (!error && !patched) throw new Error('playwright-crx capture seam not installed') },
  }
}
