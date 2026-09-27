import '@/styles/index.css'
import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ThinkingProcessBlock } from './thinking-process'

describe('ThinkingProcessBlock 阶段与耗时摘要', () => {
  it('实时任务显示当前阶段并允许取消', async () => {
    const onCancel = vi.fn()
    await render(
      <ThinkingProcessBlock
        isLive
        stage='generating'
        thinkingText='供应商返回的内部推理文本'
        onCancel={onCancel}
      />,
    )

    await expect.element(page.getByText('正在生成答复…')).toBeVisible()
    await expect.element(page.getByText('供应商返回的内部推理文本')).not.toBeInTheDocument()
    const cancelBtn = page.getByRole('button', { name: '取消' })
    await cancelBtn.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('完成后只显示耗时，历史推理文本不可展开或复制', async () => {
    const screen = await render(
      <ThinkingProcessBlock
        isLive={false}
        thinkingText='历史保存的完整模型推理文本'
        thinkingDurationMs={3200}
      />,
    )

    await expect.element(screen.getByText('答复已完成')).toBeVisible()
    await expect.element(screen.getByText('用时 3 秒')).toBeVisible()
    await expect.element(screen.getByText('历史保存的完整模型推理文本')).not.toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /展开|复制/ })).not.toBeInTheDocument()
  })

  it('无耗时的历史回合不显示空摘要', async () => {
    const screen = await render(
      <ThinkingProcessBlock isLive={false} thinkingText='历史推理文本' />,
    )
    expect(screen.container.innerHTML).toBe('')
  })
})
