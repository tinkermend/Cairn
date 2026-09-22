import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import type { OutcomeContract } from '@cairn/shared'
import { AuthoringObserveProvider } from './observe'
import { OutcomeListEditor } from './outcome-editor'

function withObserve(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={client}>
      <AuthoringObserveProvider enabled={false} onApplyTarget={() => undefined}>
        {ui}
      </AuthoringObserveProvider>
    </QueryClientProvider>
  )
}

function EditorHarness() {
  const [outcomes, setOutcomes] = useState<OutcomeContract[]>([])
  return <OutcomeListEditor outcomes={outcomes} scope='step' onChange={setOutcomes} />
}

describe('OutcomeListEditor', () => {
  it('默认用业务语言，高级区拦住非必须条件停机', async () => {
    const screen = await render(withObserve(<EditorHarness />))
    await expect.element(screen.getByRole('heading', { name: '成功条件' })).toBeInTheDocument()
    expect(screen.container.textContent).not.toMatch(/断言条件|确定性断言/)
    await screen.getByRole('button', { name: '添加条件' }).click()
    await expect.element(screen.getByLabelText('成功条件 1 含义')).toBeInTheDocument()
    await screen.getByRole('button', { name: '高级' }).click()
    await expect
      .element(screen.getByRole('combobox', { name: '成功条件 1 严重度' }))
      .toBeInTheDocument()
    await screen.getByRole('combobox', { name: '成功条件 1 严重度' }).click()
    await screen.getByRole('option', { name: '应当成立' }).click()
    await expect
      .element(screen.getByRole('combobox', { name: '成功条件 1 不成立时' }))
      .toBeDisabled()
    await expect
      .element(screen.getByText('应当成立或仅记录的条件不能停止整次运行。'))
      .toBeInTheDocument()
  })

  it('新条件不带假目标，摘要是尚未选择页面对象', async () => {
    const screen = await render(withObserve(<EditorHarness />))
    await screen.getByRole('button', { name: '添加条件' }).click()
    await expect
      .element(screen.getByLabelText('成功条件 1 含义'))
      .toHaveValue('尚未从页面选择要检查的内容')
    expect(screen.container.textContent).toMatch(/尚未选择页面对象/)
    expect(screen.container.textContent).not.toMatch(/已选择「结果」/)
    await expect
      .element(screen.getByRole('combobox', { name: '成功条件 1 期望' }))
      .toHaveTextContent('对象存在')
  })

  it('已有条件改过含义后添加第二条，第一条保持不变', async () => {
    const screen = await render(withObserve(<EditorHarness />))
    await screen.getByRole('button', { name: '添加条件' }).click()
    await screen.getByLabelText('成功条件 1 含义').fill('内存使用率有数据')
    await screen.getByRole('button', { name: '添加条件' }).click()
    await expect
      .element(screen.getByLabelText('成功条件 1 含义'))
      .toHaveValue('内存使用率有数据')
    await expect
      .element(screen.getByLabelText('成功条件 2 含义'))
      .toHaveValue('尚未从页面选择要检查的内容')
  })
})
