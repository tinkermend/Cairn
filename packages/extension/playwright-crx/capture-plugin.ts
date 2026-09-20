import type { Plugin } from 'vite'

/** Pin the two pre-merge seams. A vendor upgrade must re-prove these seams. */
export function demonstrationCapturePlugin(): Plugin {
  let patched = false
  return { name: 'cairn-demonstration-capture',
    transform(code, id) {
      if (!id.includes('playwright-crx/') || !id.endsWith('.mjs') || !code.includes('async _createActionInContext(frame, action)')) return
      const perform = 'await this._collection.performAction(await this._createActionInContext(frame, action));'
      const record = 'this._collection.addRecordedAction(await this._createActionInContext(frame, action));'
      if (code.split(perform).length !== 2 || code.split(record).length !== 2) throw new Error('playwright-crx capture seam changed: verify before upgrading')
      const replace = (mode: string, operation: string) => `const context = await this._createActionInContext(frame, action);
        const complete = await globalThis.__cairnCaptureBegin?.(frame, context, '${mode}');
        try { ${operation} } finally { complete?.(); }`
      patched = true
      return { code: code.replace(perform, replace('perform', 'await this._collection.performAction(context);')).replace(record, replace('record', 'this._collection.addRecordedAction(context);')), map: null }
    },
    buildEnd(error) { if (!error && !patched) throw new Error('playwright-crx capture seam not installed') },
  }
}
