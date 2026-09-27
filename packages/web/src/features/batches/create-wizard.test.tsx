import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { BatchCreateWizard } from './create-wizard'

vi.mock('@/lib/scenarios-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/scenarios-api')>()),
  fetchScenarios: async () => ({ items: [], nextCursor: undefined }),
}))

it('批次名称与目标场景控件有可访问名称', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(
    <QueryClientProvider client={client}>
      <BatchCreateWizard open onOpenChange={vi.fn()} onSuccess={vi.fn()} />
    </QueryClientProvider>,
  )

  const name = screen.getByRole('textbox', { name: '自动化批次名称' })
  const scenario = screen.getByRole('combobox', { name: '选择目标场景' })
  await expect.element(name).toBeVisible()
  await expect.element(scenario).toBeVisible()
  await screen.getByText('自动化批次名称', { exact: true }).click()
  await expect.element(name).toHaveFocus()
})
