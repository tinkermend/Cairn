import { describe, expect, it } from 'vitest'
import { buildActiveFilters } from './active-filters'
import { parseOptionalColumns } from './columns'
import type { EvidencePageSearch } from './search-state'

const T = '33333333-3333-4333-8333-333333333333'
const A = '66666666-6666-4666-8666-666666666666'
const S = '44444444-4444-4444-8444-444444444444'

describe('已生效筛选', () => {
  it('没有筛选时为空；默认的最近 7 天不算筛选', () => {
    expect(buildActiveFilters({})).toEqual([])
    expect(buildActiveFilters({ timePreset: '7d' })).toEqual([])
  })

  it('多选字段每个取值单独一项，清除一项只去掉那一个值', () => {
    const search: EvidencePageSearch = { types: 'screenshot,trace', availability: 'purged' }
    const filters = buildActiveFilters(search)
    expect(filters.map((item) => item.label)).toEqual(['类型：截图', '类型：Trace', '可用性：已清理'])
    expect(filters[0]?.clear).toEqual({ types: 'trace' })
    expect(filters[1]?.clear).toEqual({ types: 'screenshot' })
    expect(filters[2]?.clear).toEqual({ availability: undefined })
  })

  it('目标与场景用当前显示名，查不到时回退到 ID 前 8 位；清除目标一并去掉账号，清除场景一并去掉版本', () => {
    const names = { targets: new Map([[T, '目标甲']]) }
    const filters = buildActiveFilters(
      { targetId: T, targetAccountId: A, scenarioId: S, scenarioVersionId: S },
      names,
    )
    const byId = Object.fromEntries(filters.map((item) => [item.id, item]))
    expect(byId.targetId?.label).toBe('目标：目标甲')
    expect(byId.targetId?.clear).toEqual({ targetId: undefined, targetAccountId: undefined })
    expect(byId.targetAccountId?.label).toBe('账号：66666666')
    expect(byId.scenarioId?.label).toBe('场景：44444444')
    expect(byId.scenarioId?.clear).toEqual({ scenarioId: undefined, scenarioVersionId: undefined })
    expect(byId.scenarioVersionId).toBeDefined()
  })

  it('自定义时间和非默认预设都显示，清除时三个时间字段一起回到默认', () => {
    const custom = buildActiveFilters({ timePreset: 'custom', createdFrom: '2026-09-01T00:00:00.000Z' })
    expect(custom).toHaveLength(1)
    expect(custom[0]?.clear).toEqual({ timePreset: undefined, createdFrom: undefined, createdTo: undefined })
    expect(buildActiveFilters({ timePreset: '30d' })[0]?.label).toBe('时间：最近 30 天')
  })

  it('定位 ID、运行种类、对外发布、预置视图各自成项', () => {
    const filters = buildActiveFilters({
      runId: T,
      suiteId: T,
      suiteRunId: A,
      memberId: 'm1',
      evidenceId: A,
      stepRunId: S,
      attemptId: S,
      isTrial: true,
      released: false,
      view: 'recent_failures',
    })
    expect(filters.map((item) => item.id).sort()).toEqual(
      ['attemptId', 'evidenceId', 'isTrial', 'memberId', 'released', 'runId', 'stepRunId', 'suiteId', 'suiteRunId', 'view'].sort(),
    )
    expect(filters.find((item) => item.id === 'isTrial')?.label).toBe('运行种类：试跑')
    expect(filters.find((item) => item.id === 'released')?.label).toBe('对外发布：未发布')
  })

  it('每一项的清除结果都会让该项从清单里消失', () => {
    const search: EvidencePageSearch = {
      view: 'purge_failed',
      targetId: T,
      types: 'log',
      runStatuses: 'FAILED,CANCELLED',
      outcomeStatuses: 'FAIL',
      runEvidenceStatuses: 'INCOMPLETE',
      isTrial: false,
      released: true,
    }
    for (const filter of buildActiveFilters(search)) {
      const next = { ...search, ...filter.clear } as EvidencePageSearch
      expect(buildActiveFilters(next).map((item) => item.id)).not.toContain(filter.id)
    }
  })
})

describe('可选列', () => {
  it('只认已知列名并按固定顺序，未知值被丢弃', () => {
    expect(parseOptionalColumns(undefined)).toEqual([])
    expect(parseOptionalColumns('released, size ,nope')).toEqual(['size', 'released'])
  })
})
