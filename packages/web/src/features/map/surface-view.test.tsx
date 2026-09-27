import '@/styles/index.css'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import type { MapIngestSurfaceResponse, MapMenuEntryDto } from '@cairn/shared'
import { IngestSurfaceAtlas, IngestSurfaceList } from './surface-view'

const entryId = '11111111-1111-4111-8111-111111111111'
const surface: MapIngestSurfaceResponse = {
  targetId: '22222222-2222-4222-8222-222222222222',
  targetAccountId: '33333333-3333-4333-8333-333333333333',
  sourceJobId: '44444444-4444-4444-8444-444444444444', truncated: false,
  pages: [
    { entryId, pageKey: 'tokens', title: '令牌列表', urlPattern: 'https://app.example/tokens',
      menuPath: ['API 令牌', '令牌列表'], observedAt: '2026-09-27T00:00:00.000Z',
      elementCount: 4, viewCount: 2,
      categories: { navigation: 1, input: 1, action_button: 1, table_column: 1, display: 0 },
      completeness: 'complete', lifecycle: 'observed', staleElements: 0, changeKinds: ['page_added'] },
    { entryId, pageKey: 'old', title: '旧配置', urlPattern: 'https://app.example/old',
      menuPath: ['API 令牌', '旧配置'], observedAt: '2026-09-25T00:00:00.000Z',
      elementCount: 1, viewCount: 1,
      categories: { navigation: 0, input: 0, action_button: 1, table_column: 0, display: 0 },
      completeness: 'complete', lifecycle: 'stale', staleElements: 1, changeKinds: ['page_removed'] },
  ],
}
const entries = [{ entryId, name: 'API 令牌', orderIndex: 0 }] as MapMenuEntryDto[]

describe('采集页面海图与清单', () => {
  it('按一级菜单呈现页面节点与状态详情', async () => {
    await page.viewport(390, 844)
    await render(<IngestSurfaceAtlas surface={surface} entries={entries} onSearchChange={() => {}} />)
    await expect.element(page.getByRole('heading', { name: 'API 令牌' })).toBeVisible()
    await page.getByRole('button', { name: /令牌列表/ }).click()
    await expect.element(page.getByRole('complementary', { name: '页面详情' })).toBeVisible()
    await expect.element(page.getByText('STALE')).toBeVisible()
    expect(document.documentElement.scrollWidth <= window.innerWidth + 1).toBe(true)
  })

  it('按元素类别、完整性和生命周期筛选采集页面', async () => {
    await page.viewport(1440, 900)
    await render(<IngestSurfaceList surface={surface} entries={entries} />)
    await page.getByLabelText('元素类别').selectOptions('input')
    await expect.element(page.getByRole('cell', { name: /令牌列表/ })).toBeVisible()
    await expect.element(page.getByRole('cell', { name: /旧配置/ })).not.toBeInTheDocument()
    await page.getByLabelText('元素类别').selectOptions('all')
    await page.getByLabelText('生命周期').selectOptions('stale')
    await expect.element(page.getByRole('cell', { name: /旧配置/ })).toBeVisible()
    await expect.element(page.getByRole('cell', { name: /令牌列表/ })).not.toBeInTheDocument()
  })
})
