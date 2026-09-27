import { describe, expect, it } from 'vitest'
import type { MapIngestElement } from '@cairn/shared'
import { buildIngestSurfacePages, composeCurrentIngestRows } from './ingest-surface.js'

type PageRow = Parameters<typeof buildIngestSurfacePages>[0]['base'][number]
const entryA = '00000000-0000-4000-8000-000000000001'
const entryB = '00000000-0000-4000-8000-000000000002'
const element = (fingerprint: string, category: MapIngestElement['category'] = 'input') => ({
  fingerprint, category, role: 'textbox', name: fingerprint,
}) as MapIngestElement
const row = (jobId: string, entryId: string, pageKey: string, elements: MapIngestElement[]): PageRow => ({
  jobId, entryId, pageKey, viewStateKey: pageKey + ':default', elementsJson: elements,
  title: pageKey, urlPattern: 'https://app.example/' + pageKey,
  menuPathJson: [entryId, pageKey], completeness: 'complete',
  observedAt: new Date(jobId === 'old' ? '2026-09-25T00:00:00Z' : '2026-09-27T00:00:00Z'),
}) as PageRow

describe('按账号和授权子树合成采集页面', () => {
  it('完整全量采集仅将当前授权子树中消失的页面和元素标记为 stale', () => {
    const pages = buildIngestSurfacePages({
      previousFull: [
        row('old', entryA, 'kept', [element('name'), element('removed')]),
        row('old', entryA, 'missing', [element('old-only')]),
        row('old', entryB, 'outside', [element('outside')]),
      ],
      base: [row('new', entryA, 'kept', [element('name')])],
      overlays: [], authorizedEntryIds: new Set([entryA]), latestChanges: [],
    })
    expect(pages.map(page => [page.pageKey, page.lifecycle])).toEqual([
      ['kept', 'observed'], ['missing', 'stale'],
    ])
    expect(pages.find(page => page.pageKey === 'kept')?.staleElements).toBe(1)
    expect(pages.find(page => page.pageKey === 'missing')?.staleElements).toBe(1)
  })

  it('局部采集只覆盖看见的页面，不会把其他页面标记为 stale', () => {
    const pages = buildIngestSurfacePages({
      previousFull: [], base: [row('old', entryA, 'kept', [element('old')])],
      overlays: [[row('new', entryA, 'changed', [element('new')])]],
      authorizedEntryIds: new Set([entryA]), latestChanges: [],
    })
    expect(pages.map(page => [page.pageKey, page.lifecycle])).toEqual([
      ['changed', 'observed'], ['kept', 'observed'],
    ])
  })

  it('AI 上下文沿用全量基线，并叠加后续局部作业的最新页面', () => {
    const current = composeCurrentIngestRows(
      [row('old', entryA, 'kept', [element('old')]), row('old', entryA, 'untouched', [element('stable')])],
      [[row('new', entryA, 'kept', [element('new')])]],
    )
    expect(current.map(page => [page.pageKey, page.elementsJson[0]?.fingerprint])).toEqual([
      ['kept', 'new'], ['untouched', 'stable'],
    ])
  })
})
