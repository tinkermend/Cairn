import { expect, it, vi } from 'vitest'
import { fetchMapObjects } from './map-api'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiFetch: mocks.fetch,
}))
it('条件快照按 JSON 查询参数传输，不转为 object 字符串', () => {
  const condition = {
    targetId: '11111111-1111-4111-8111-111111111111',
    accountBinding: { presence: 'anonymous' as const },
    unknownFields: [],
  }
  fetchMapObjects(condition.targetId, {
    limit: 20,
    conditionSnapshot: condition,
  })
  const url = new URL(mocks.fetch.mock.calls[0]![0], 'http://localhost')
  expect(JSON.parse(url.searchParams.get('conditionSnapshot')!)).toEqual(
    condition
  )
  expect(url.searchParams.get('limit')).toBe('20')
})
