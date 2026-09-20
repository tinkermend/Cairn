import { describe, expect, it } from 'vitest'
import { DEMONSTRATION_LIMITS, canonicalJson, type DemonstrationProfile } from '@cairn/shared'
import { parseDemonstrationFile, demonstrationFactDigest } from '../demonstration-adapters.js'
import { previewDemonstration, suggestDemonstration } from '../demonstration.js'

const targetId = '00000000-0000-4000-8000-000000000001'
const captureId = '00000000-0000-4000-8000-000000000002'
const parse = (text: string, profile: DemonstrationProfile = 'midscene-yaml-flow@1') => parseDemonstrationFile({ text, profile, targetId, captureId })
const yaml = (flow: string, extra = '') => `web:\n  url: https://example.test/orders\n${extra}tasks:\n  - name: 查询\n    flow:\n${flow}`

describe('demonstration source adapters and immutable suggestions', () => {
  it('preserves atomic input, keyboard, scroll and assertion order without inventing a producer version', () => {
    const source = parse(yaml(`      - aiInput: 订单号\n        value: '1008611'\n        mode: replace\n      - aiKeyboardPress: 订单号\n        keyName: Enter\n      - aiScroll: 列表\n        direction: down\n        distance: 300\n      - aiAssert: 出现订单\n      - aiAssert: 订单已完成`))
    expect(source.producerVersion).toBeNull()
    expect(source.authorship).toBe('unknown')
    const suggestions = suggestDemonstration(source)
    expect(suggestions.map((s) => s.status)).toEqual(Array(6).fill('mapped'))
    expect(suggestions[1]!.step?.input).toEqual({ operation: 'input', targetDescription: '订单号', value: '1008611', mode: 'replace' })
    expect(suggestions[4]!.outcome).toMatchObject({ afterSourceId: 'task-0-flow-2', severity: 'MUST', onViolation: 'halt', provenance: 'imported' })
    expect(suggestions[5]!.outcome?.afterSourceId).toBe(suggestions[4]!.outcome?.afterSourceId)
    expect(suggestDemonstration(source)).toEqual(suggestions)
  })
  it.each(['replace', 'typeOnly', 'append'])('rejects SDK no-op empty %s input before acceptance', (mode) => {
    const suggestions = suggestDemonstration(parse(yaml(`      - aiInput: 输入框\n        value: ''\n        mode: ${mode}`)))
    expect(suggestions[1]!.status).toBe('unresolved')
  })
  it('preserves explicit clear and focused keyboard semantics', () => {
    const suggestions = suggestDemonstration(parse(yaml(`      - aiInput: 输入框\n        mode: clear\n      - aiKeyboardPress:\n        keyName: Escape`)))
    expect(suggestions[1]!.step?.input).toEqual({ operation: 'input', targetDescription: '输入框', mode: 'clear' })
    expect(suggestions[2]!.step?.input).toEqual({ operation: 'keyboard', key: 'Escape' })
  })
  it.each([
    `web: {url: https://example.test}\nweb: {url: https://example.test}\ntasks: []`,
    `web: &web {url: https://example.test}\ntasks: [*web]`,
    `web: !!map {url: https://example.test}\ntasks: []`,
    `---\nweb: {}\n---\ntasks: []`,
    yaml('      - aiTap: ${BUTTON}'),
    yaml('      - aiTap: 按钮\n        aiAssert: 成功'),
    yaml('      - __proto__: bad'),
    'import { test } from "@playwright/test";',
  ])('rejects unsafe or unsupported document shapes: %s', (input) => expect(() => parse(input)).toThrow())
  it('requires review for semantics-affecting configuration and beginning assertions', () => {
    const source = parse(yaml('      - aiAssert: 已登录\n      - aiTap: 按钮\n        deepLocate: true', 'aiActContext: 先选择部门\n'))
    expect(suggestDemonstration(source).slice(1).every((s) => s.status === 'unresolved')).toBe(true)
  })
  it('omits configuration values and redacts secrets before persistence', () => {
    const source = parse(`web:\n  url: https://u:secret@example.test/?token=private&order=10#secret\n  cookies: private-cookie\ntasks:\n  - name: 登录\n    flow:\n      - aiInput: 密码\n        value: hidden-password`)
    const wire = canonicalJson(source)
    for (const value of ['private-cookie', 'hidden-password', 'private&', 'u:secret', '#secret']) expect(wire).not.toContain(value)
    expect(source.omittedConfig).toContain('target.cookies')
    expect(source.facts[1]!.data.value?.state).toBe('redacted')
  })
  it('retains Midscene event identities and navigation observations; absolute scroll is unresolved', () => {
    const source = parse(JSON.stringify([
      { type: 'navigation', url: 'https://example.test', timestamp: 1, hashId: 'n', pageInfo: { width: 1200, height: 800 } },
      { type: 'click', elementDescription: '查询', hashId: 'c', timestamp: 2, pageInfo: { width: 1200, height: 800 } },
      { type: 'navigation', actionType: 'NavigationChanged', url: 'https://example.test/result', hashId: 'n2', timestamp: 3, pageInfo: { width: 1200, height: 800 } },
      { type: 'scroll', value: '0,800', hashId: 's', mergedHashIds: ['s1'], timestamp: 4, pageInfo: { width: 1200, height: 800 } },
    ]), 'midscene-recorder-json@1')
    const suggestions = suggestDemonstration(source)
    expect(suggestions.map((s) => s.status)).toEqual(['mapped', 'mapped', 'observation', 'unresolved'])
    expect(suggestions[3]!.sourceIds).toEqual(['s', 's1'])
    expect(source.facts[1]!.before.status).toBe('missing')
  })
  it('keeps old CRX input facts separate when epoch is unknown', () => {
    const events = [
      { name: 'navigate', url: 'https://example.test' },
      { name: 'fill', selector: '#order', text: '12', pageAlias: 'page' },
      { name: 'fill', selector: '#order', text: '123', pageAlias: 'page' },
    ]
    const source = parse(events.map((e) => JSON.stringify(e)).join('\n'), 'playwright-crx@0.15.0')
    expect(source.sourceKind).toBe('legacy_normalized')
    expect(source.facts).toHaveLength(3)
    expect(suggestDemonstration(source)).toHaveLength(3)
  })
  it('never promotes an unsupported wait or extraction to a successful assertion', () => {
    const suggestions = suggestDemonstration(parse(yaml('      - aiWaitFor: 成功\n      - aiQuery: 订单号')))
    expect(suggestions.slice(1).every((s) => s.status === 'unresolved')).toBe(true)
  })
  it('enforces action limits and stable context-bound preview digests', () => {
    expect(() => parse(yaml(Array.from({ length: DEMONSTRATION_LIMITS.actions }, () => '      - aiTap: 按钮').join('\n')))).toThrow()
    const source = parse(yaml('      - aiTap: 按钮'))
    const input = { source, scenarioId: targetId, recordingDraftId: captureId, baseRevision: 1, placement: { kind: 'start' as const }, remainingCapacity: 200 }
    expect(previewDemonstration(input).factDigest).toBe(demonstrationFactDigest(source))
    expect(previewDemonstration({ ...input, baseRevision: 2 }).suggestionDigest).not.toBe(previewDemonstration(input).suggestionDigest)
    expect(previewDemonstration(input)).toEqual(previewDemonstration(input))
  })
})
