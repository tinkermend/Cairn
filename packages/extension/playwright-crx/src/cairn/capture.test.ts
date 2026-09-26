import { describe, expect, it } from 'vitest'
import { DemonstrationCapture, captureSource } from './capture'
import { suggestDemonstration } from '@cairn/authoring'

function frame() {
  return { _currentDocument: { documentId: 'doc-1' }, url: () => 'https://example.test/orders?token=secret', evaluateExpression: async () => ({ url: 'https://example.test/orders?token=secret', readyState: 'complete', regionSummary: '{"forms":1}' }) }
}
const context = (text: string) => ({ frame: { pageAlias: 'page', framePath: [] }, action: { name: 'fill', selector: '#order', text } })

describe('pre-merge capture ownership and observations', () => {
  it('keeps standalone page navigation and avoids a duplicate initial page fact', async () => {
    const capture = new DemonstrationCapture(); const page = frame()
    capture.recordStandalone({ frame: { pageAlias: 'page', framePath: [] }, action: { name: 'openPage', url: 'https://example.test/orders?token=secret' } })
    capture.recordStandalone({ frame: { pageAlias: 'page', framePath: [] }, action: { name: 'navigate', url: 'https://example.test/next?token=secret' } })
    capture.recordStandalone({ frame: { pageAlias: 'page', framePath: [] }, action: { name: 'closePage' } })
    const complete = await capture.begin(page, context('a'), 'record')
    complete()
    expect(capture.get().facts.map((item) => item.action)).toEqual(['openPage', 'navigate', 'fill'])
    expect(capture.get().facts.map((item) => item.sequence)).toEqual([0, 1, 2])
    expect(JSON.stringify(capture.get())).not.toContain('token=secret')
  })
  it('keeps every native input fact, stable IDs and only honest cached before-state', async () => {
    const capture = new DemonstrationCapture(); const page = frame()
    const first = await capture.begin(page, context('a'), 'record'); first(); await new Promise((r) => setTimeout(r, 0))
    const second = await capture.begin(page, context('ab'), 'record'); second(); await new Promise((r) => setTimeout(r, 0))
    const source = captureSource(capture.get().facts, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')
    expect(source.facts).toHaveLength(3)
    expect(new Set(source.facts.map((f) => f.id)).size).toBe(3)
    expect(source.facts[1]!.before).toMatchObject({ status: 'missing', reasonCode: 'post_action_only' })
    expect(source.facts[2]!.before).toMatchObject({ status: 'approximate', ageMs: expect.any(Number), documentEpoch: 'doc-1' })
    expect(JSON.stringify(source)).not.toContain('token=secret')
    expect(suggestDemonstration(source).at(-1)?.sourceIds).toHaveLength(2)
  })
  it('never reuses old-document or reset-generation observations', async () => {
    const capture = new DemonstrationCapture(); const page = frame()
    const complete = await capture.begin(page, context('a'), 'perform')
    expect(capture.get().facts[1]!.before.status).toBe('captured')
    complete(); await new Promise((r) => setTimeout(r, 0))
    page._currentDocument.documentId = 'doc-2'
    await capture.begin(page, context('b'), 'record')
    expect(capture.get().facts[2]!.before.status).toBe('missing')
    capture.reset(); complete(); await new Promise((r) => setTimeout(r, 0))
    expect(capture.get().facts).toHaveLength(0)
  })
  it('bounds a stalled observer without losing the action', async () => {
    const capture = new DemonstrationCapture(); const page = frame()
    page.evaluateExpression = () => new Promise(() => {})
    const done = await capture.begin(page, context('value'), 'perform')
    expect(capture.get().facts[1]!.before).toMatchObject({ status: 'missing', reasonCode: 'timeout' })
    done()
  })
})
