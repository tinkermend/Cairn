import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import type { TerminologyEntry } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { TermEditor } from './term-editor'

const mocks = vi.hoisted(() => ({
  updateMapTerm: vi.fn(),
  retireMapTerm: vi.fn(),
}))
vi.mock('@/lib/map-api', () => mocks)
const term: TerminologyEntry = {
  termId: '11111111-1111-4111-8111-111111111111',
  targetId: '22222222-2222-4222-8222-222222222222',
  canonicalName: '销售订单',
  aliases: ['订单'],
  meaning: '由销售业务创建的订单，不包括采购单',
  termStatus: 'candidate',
  revision: 3,
  sources: [],
  createdAt: '2026-09-16T00:00:00Z',
  updatedAt: '2026-09-16T00:00:00Z',
}
const renderEditor = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TermEditor term={term} canReview />
    </QueryClientProvider>
  )
beforeEach(async () => {
  vi.resetAllMocks()
  await page.viewport(390, 844)
})
describe('术语维护', () => {
  it('确认时保存编辑值与 OCC，关闭后焦点返回入口', async () => {
    mocks.updateMapTerm.mockResolvedValue({
      ...term,
      revision: 4,
      termStatus: 'confirmed',
    })
    const screen = await renderEditor()
    await screen.getByRole('button', { name: '查看术语' }).click()
    await screen.getByLabelText('业务含义').fill('人工核对后的销售含义')
    await screen.getByRole('button', { name: '确认术语' }).click()
    expect(mocks.updateMapTerm).toHaveBeenCalledWith(
      term.targetId,
      term.termId,
      expect.objectContaining({
        expectedRevision: 3,
        termStatus: 'confirmed',
        meaning: '人工核对后的销售含义',
      })
    )
    await expect
      .element(screen.getByRole('button', { name: '查看术语' }))
      .toHaveFocus()
  })
  it('退役必须填写原因，失败保留输入并可重试', async () => {
    mocks.retireMapTerm.mockRejectedValue(new Error('修订已变化'))
    const screen = await renderEditor()
    await screen.getByRole('button', { name: '查看术语' }).click()
    await expect
      .element(screen.getByRole('button', { name: '退役术语' }))
      .toBeDisabled()
    await screen.getByLabelText('退役原因').fill('已合并至统一销售术语')
    await screen.getByRole('button', { name: '退役术语' }).click()
    await expect
      .element(screen.getByRole('alert'))
      .toHaveTextContent('输入已保留')
    await expect
      .element(screen.getByLabelText('退役原因'))
      .toHaveValue('已合并至统一销售术语')
    await page.screenshot({
      path: '../../../../../.run/ome-review/term-mobile.png',
    })
  })
})
