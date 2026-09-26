import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { ThinkingProcessBlock } from './thinking-process'

describe('ThinkingProcessBlock 深度思考过程流式与折叠组件', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('实时流式分析初期（无思考文本）：展示对应阶段状态与取消按钮', async () => {
    const onCancel = vi.fn()
    await render(
      <ThinkingProcessBlock
        isLive={true}
        stage='generating'
        thinkingText=''
        onCancel={onCancel}
      />,
    )

    await expect.element(page.getByText('大模型正在思考分析...')).toBeVisible()
    const cancelBtn = page.getByRole('button', { name: '取消' })
    await expect.element(cancelBtn).toBeVisible()
    await cancelBtn.click()
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('实时流式思考中：默认展开呈现思考文本与流式指示，支持点击收起与重新展开', async () => {
    await render(
      <ThinkingProcessBlock
        isLive={true}
        stage='generating'
        thinkingText='模型思考中：正在对比历史运行中报错步骤的选择器与当前 DOM 结构...'
      />,
    )

    // 默认展开呈现
    await expect
      .element(page.getByText('模型思考中：正在对比历史运行中报错步骤的选择器与当前 DOM 结构...'))
      .toBeVisible()

    // 切换折叠（点击收起）
    const foldBtn = page.getByRole('button', { name: '收起思考过程' })
    await foldBtn.click()
    const expandBtn = page.getByRole('button', { name: '展开思考过程' })
    await expect.element(expandBtn).toBeVisible()

    // 切换展开（点击重新展开）
    await expandBtn.click()
    await expect.element(page.getByRole('button', { name: '收起思考过程' })).toBeVisible()
    await expect
      .element(page.getByText('模型思考中：正在对比历史运行中报错步骤的选择器与当前 DOM 结构...'))
      .toBeVisible()
  })

  it('已完成问答回合：默认折叠呈现已深度思考与耗时，点击展开可复盘思考详情与一键复制', async () => {
    // 模拟剪贴板
    const writeTextMock = vi.fn().mockResolvedValue(undefined)
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        configurable: true,
      })
    } else {
      vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeTextMock)
    }

    await render(
      <ThinkingProcessBlock
        isLive={false}
        thinkingText='已完成的完整思考链：首先核查账号授权租约，随后比对 step_03 快照，定位由于弹窗遮挡导致的点击超时。'
        thinkingDurationMs={3200}
      />,
    )

    // 默认折叠：展示已深度思考与用时秒数
    await expect.element(page.getByText('已深度思考 (用时 3 秒)')).toBeVisible()
    await expect.element(page.getByText('点击展开')).toBeVisible()

    // 点击展开
    const trigger = page.getByRole('button', { name: '展开思考过程' })
    await trigger.click()

    await expect
      .element(page.getByText('已完成的完整思考链：首先核查账号授权租约，随后比对 step_03 快照，定位由于弹窗遮挡导致的点击超时。'))
      .toBeVisible()

    // 点击复制思考过程
    const copyBtn = page.getByRole('button', { name: '复制思考过程' })
    await copyBtn.click()
    expect(writeTextMock).toHaveBeenCalledWith(
      '已完成的完整思考链：首先核查账号授权租约，随后比对 step_03 快照，定位由于弹窗遮挡导致的点击超时。',
    )
  })

  it('非实时且无思考文本时静默不渲染', async () => {
    const screen = await render(
      <ThinkingProcessBlock isLive={false} thinkingText='' />,
    )
    expect(screen.container.innerHTML).toBe('')
  })
})
