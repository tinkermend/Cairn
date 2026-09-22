import { describe, expect, it } from 'vitest'
import type { TargetObservation } from '@cairn/shared'
import {
  alternativeLabels,
  candidateCompareText,
  expectFromPreviewText,
  locatorCandidateSummary,
  normalizePickLabel,
  observationPreviewText,
  pickLabelMismatch,
  resolvedCandidate,
  targetFromPickedLabel,
} from './pick-apply'

const ambiguous: TargetObservation = {
  outcome: 'AMBIGUOUS',
  target: { framePath: [], candidates: [{ by: 'css', value: 'span.text-nowrap' }] },
  page: { url: 'https://ops.example/panel' },
  preview: { text: '25%' },
  diagnostics: { outcome: 'AMBIGUOUS', candidatesTried: [] },
  source: 'managed',
  alternatives: [
    { index: 0, reason: '匹配 2 个：25%', label: '25%' },
    { index: 0, reason: '匹配 2 个：25%', label: '25%' },
    { index: 1, reason: '匹配 60 个：db2', label: 'db2' },
    { index: 1, reason: '匹配 60 个：#1', label: '#1' },
    { index: 1, reason: '匹配 60 个：4717.6', label: '4717.6' },
  ],
}

describe('pick-apply', () => {
  it('稳定文案写成文本相符，数量保留给数值比较', () => {
    expect(expectFromPreviewText('报告管理')).toEqual({ kind: 'text_equals', value: '报告管理' })
    expect(expectFromPreviewText('¥128.00')).toEqual({ kind: 'number_compare', op: 'eq', value: 128 })
  })

  it('多处匹配抽出可点选的内容，丢掉 #1 占位', () => {
    expect(alternativeLabels(ambiguous)).toEqual(['25%', 'db2', '4717.6'])
    expect(observationPreviewText(ambiguous)).toBe('25%')
  })

  it('选用一条内容时改成文本定位', () => {
    expect(
      targetFromPickedLabel('db2', {
        framePath: [],
        candidates: [{ by: 'css', value: 'span.text-nowrap' }],
        anchor: { withinText: '实例列表', scope: 'row' },
      }),
    ).toEqual({
      framePath: [],
      candidates: [{ by: 'text', value: 'db2' }],
      semantic: 'db2',
      anchor: { withinText: '实例列表', scope: 'row' },
    })
  })

  it('去掉空白和私用区后全等才算一致，「数据库」与「数据库服务」必须标黄', () => {
    expect(normalizePickLabel('\uE001 配置管理 ')).toBe('配置管理')
    expect(pickLabelMismatch('数据库', '数据库服务')).toBe(true)
    expect(pickLabelMismatch('\uE001配置管理', '配置管理')).toBe(false)
    expect(pickLabelMismatch('', '数据库服务')).toBe(false)
  })

  it('将要点取唯一匹配候选，不拿排在第 0 位的 testId 充数', () => {
    const observation: TargetObservation = {
      outcome: 'FOUND',
      target: {
        framePath: [],
        candidates: [
          { by: 'testId', value: 'menu-db' },
          { by: 'role', value: 'button', name: '数据库服务' },
        ],
      },
      page: { url: 'https://ops.example/' },
      preview: { text: '数据库' },
      diagnostics: {
        outcome: 'FOUND',
        candidatesTried: [
          { index: 0, by: 'testId', value: 'menu-db', matches: 0 },
          { index: 1, by: 'role', value: 'button', matches: 1 },
        ],
      },
      source: 'managed',
    }
    const candidate = resolvedCandidate(observation)
    expect(candidate).toEqual({ by: 'role', value: 'button', name: '数据库服务' })
    expect(locatorCandidateSummary(candidate!)).toContain('数据库服务')
    expect(locatorCandidateSummary(candidate!)).not.toMatch(/menu-db/)
    expect(pickLabelMismatch(observation.preview!.text!, candidateCompareText(candidate!))).toBe(true)
  })

  it('没有唯一匹配时不对账将要点', () => {
    expect(resolvedCandidate(ambiguous)).toBeUndefined()
    expect(
      resolvedCandidate({
        ...ambiguous,
        outcome: 'FOUND',
        diagnostics: {
          outcome: 'FOUND',
          candidatesTried: [
            { index: 0, by: 'css', value: 'span.text-nowrap', matches: 2 },
            { index: 1, by: 'text', value: '25%', matches: 2 },
          ],
        },
      }),
    ).toBeUndefined()
  })
})
