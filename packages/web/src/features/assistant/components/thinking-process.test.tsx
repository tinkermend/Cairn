import '@/styles/index.css'
import { describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ThinkingProcessBlock } from './thinking-process'

describe('ThinkingProcessBlock 思考过程与折叠', () => {
  it('实时任务无思考文本时显示当前阶段并允许取消', async () => {
    const onCancel = vi.fn()
    await render(
      <ThinkingProcessBlock
        isLive
        stage='generating'
        onCancel={onCancel}
      />,
    )

    await expect.element(page.getByText('正在生成答复…')).toBeVisible()
    const cancelBtn = page.getByRole('button', { name: '取消' })
    await cancelBtn.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('实时任务有思考文本时展开展现思考分析过程', async () => {
    await render(
      <ThinkingProcessBlock
        isLive
        stage='generating'
        thinkingText='模型正在分析步骤选择器与 DOM 结构...'
      />,
    )

    await expect.element(page.getByText('大模型正在思考分析…')).toBeVisible()
    await expect.element(page.getByText('模型正在分析步骤选择器与 DOM 结构...')).toBeVisible()
  })

  it('思考完成后默认折叠展示耗时，支持点击展开查看完整过程与复制', async () => {
    await render(
      <ThinkingProcessBlock
        isLive={false}
        thinkingText='这是已完成的完整分析推理链路'
        thinkingDurationMs={3200}
      />,
    )

    // 默认折叠展示
    await expect.element(page.getByText('已深度思考 (用时 3 秒)')).toBeVisible()
    await expect.element(page.getByText('点击展开')).toBeVisible()

    // 点击展开
    const trigger = page.getByRole('button', { name: '展开思考过程' })
    await trigger.click()

    await expect.element(page.getByText('点击折叠')).toBeVisible()
    await expect.element(page.getByText('这是已完成的完整分析推理链路')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '复制思考过程' })).toBeVisible()
  })

  it('无耗时且无思考文本的历史回合不显示空摘要', async () => {
    const screen = await render(
      <ThinkingProcessBlock isLive={false} />,
    )
    expect(screen.container.innerHTML).toBe('')
  })
})
