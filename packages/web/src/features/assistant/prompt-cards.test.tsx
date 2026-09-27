import '@/styles/index.css'
import type { AssistantCapabilitiesResponse } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { PromptCards } from './prompt-cards'

function capabilities(
  available: string[],
  presentIds = ['platform.guide', 'scenario.explain', 'run.diagnose', 'run.compare'],
): AssistantCapabilitiesResponse {
  return {
    modelEnabled: true,
    items: presentIds.map((id) => ({
      id,
      label: id,
      available: available.includes(id),
      missingPermissions: [],
      requiredContext: [],
    })) as AssistantCapabilitiesResponse['items'],
  }
}

describe('PromptCards 能力与承诺', () => {
  it('只推荐有权限的入口，提问与导览能力一致', async () => {
    const onSelectPrompt = vi.fn()
    const screen = await render(
      <PromptCards pageContext={null} capabilities={capabilities(['platform.guide'], ['platform.guide'])} onSelectPrompt={onSelectPrompt} />,
    )

    await expect.element(screen.getByTestId('prompt-card-auth-create')).toBeInTheDocument()
    await expect.element(screen.getByTestId('prompt-card-auth-retry')).not.toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '运行排障' })).not.toBeInTheDocument()
    await screen.getByTestId('prompt-card-auth-create').click()
    expect(onSelectPrompt).toHaveBeenCalledWith('在哪里打开场景编排和场景工作区？', 'platform.guide')
  })

  it('运行页只显示当前可用的诊断能力', async () => {
    const screen = await render(
      <PromptCards
        pageContext={{ page: 'run', runId: 'run-1' }}
        capabilities={capabilities(['run.diagnose'])}
        onSelectPrompt={vi.fn()}
      />,
    )
    await expect.element(screen.getByTestId('prompt-card-diag-rootcause')).toBeInTheDocument()
    await expect.element(screen.getByTestId('prompt-card-diag-compare')).not.toBeInTheDocument()
  })

  it('没有可用能力时不显示失效推荐', async () => {
    const screen = await render(
      <PromptCards pageContext={null} capabilities={capabilities([])} onSelectPrompt={vi.fn()} />,
    )
    expect(screen.container.innerHTML).toBe('')
  })

  it('M3: 当提供 boundContext（如 Studio 选中单步）时，首帧卡片置顶展示「场景推荐」并支持点击发问', async () => {
    const onSelectPrompt = vi.fn()
    const screen = await render(
      <PromptCards
        pageContext={{ page: 'studio', scenarioId: 'sc-1', stepId: 'step-1' }}
        boundContext={{
          page: 'studio',
          scenarioId: 'sc-1',
          selectedStepId: 'step-1',
          chips: [
            {
              id: 'studio-step-propose',
              label: '✏️ 修改建议',
              question: '请对当前选中的步骤给出编写与配置优化建议。',
              capabilityHint: 'scenario.explain',
            },
          ],
        }}
        capabilities={capabilities(['scenario.explain'])}
        onSelectPrompt={onSelectPrompt}
      />,
    )

    // 推荐分类标签存在且置顶激活
    const recTab = screen.getByRole('tab', { name: '场景推荐' })
    await expect.element(recTab).toBeInTheDocument()
    await expect.element(recTab).toHaveAttribute('aria-selected', 'true')

    // 推荐大卡片展示并能响应点击发问
    const recCard = screen.getByTestId('prompt-card-studio-step-propose')
    await expect.element(recCard).toBeInTheDocument()
    await expect.element(screen.getByText('✏️ 修改建议')).toBeInTheDocument()
    await recCard.click()
    expect(onSelectPrompt).toHaveBeenCalledWith(
      '请对当前选中的步骤给出编写与配置优化建议。',
      'scenario.explain',
    )
  })

  it('M3: 当运行失败且选中报错步骤时，首帧卡片推荐当前步骤诊断与失败根因', async () => {
    const screen = await render(
      <PromptCards
        pageContext={{ page: 'run', runId: 'run-fail', stepId: 'step-err' }}
        boundContext={{
          page: 'run',
          runId: 'run-fail',
          selectedStepId: 'step-err',
          selectedStepFailed: true,
          statusTone: 'error',
          chips: [
            {
              id: 'run-step-diagnose',
              label: '📸 诊断当前步骤报错',
              question: '为什么当前选中的步骤会执行失败？请分析其错误与证据。',
              capabilityHint: 'run.diagnose',
            },
            {
              id: 'run-diagnose-rca',
              label: '🚨 诊断失败根因',
              question: '请结合执行日志、截图证据与错误信息，诊断本次运行失败的根本原因。',
              capabilityHint: 'run.diagnose',
            },
          ],
        }}
        capabilities={capabilities(['run.diagnose'])}
        onSelectPrompt={vi.fn()}
      />,
    )

    await expect.element(screen.getByTestId('prompt-card-run-step-diagnose')).toBeInTheDocument()
    await expect.element(screen.getByTestId('prompt-card-run-diagnose-rca')).toBeInTheDocument()
  })
})
