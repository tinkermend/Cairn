import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlatformConfigDocument, ScenarioAuthoringDocumentV2 } from '@cairn/shared'
import { ScenarioSettingsDialog } from './scenario-settings-dialog'

const samplePlatform = {
  schemaVersion: 6,
  platformAi: {
    enabled: true,
    baseUrl: 'https://ai.example.com',
    model: 'text-model-1',
    secretRef: { provider: 'cairn', secretId: 'sec_1' },
  },
  browserAi: {
    enabled: true,
    baseUrl: 'https://vision.example.com',
    model: 'vision-model-1',
    modelFamily: 'doubao-vl',
    secretRef: { provider: 'cairn', secretId: 'sec_2' },
    defaultResolution: 'prefer_deterministic',
    resolutionCeiling: 'prefer_ai',
  },
  runtimeInvariants: { allowEachStepProbe: false },
  locator: {
    defaultPlan: { v: 2, order: ['rule', 'text_ai', 'vision_ai'] },
    limits: { v: 2, allowed: ['rule', 'text_ai', 'vision_ai'] },
  },
} as unknown as PlatformConfigDocument

const sampleDoc: ScenarioAuthoringDocumentV2 = {
  authoringSchemaVersion: 2,
  schemaVersion: 1,
  locatorProtocol: 2,
  locatorPlan: { v: 2, order: ['rule', 'text_ai'] },
  inputs: [],
  nodes: [],
}

describe('ScenarioSettingsDialog 场景配置弹窗', () => {
  it('正确渲染定位策略与报告配置两个 Tab，并展示场景默认定位顺序', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const onChange = vi.fn()
    const onOpenChange = vi.fn()

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ScenarioSettingsDialog
          open={true}
          onOpenChange={onOpenChange}
          scenarioId='sc-1'
          targetId='target-1'
          document={sampleDoc}
          platform={samplePlatform}
          onChange={onChange}
        />
      </QueryClientProvider>,
    )

    // 验证弹窗标题与描述
    await expect.element(screen.getByRole('heading', { name: '场景配置' })).toBeInTheDocument()
    await expect.element(screen.getByText('管理本场景全局运行策略、页面元素定位基线与运行报告配置。')).toBeInTheDocument()

    // 验证 Tab 切换项
    await expect.element(screen.getByRole('tab', { name: '定位策略' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '报告配置' })).toBeInTheDocument()

    // 默认展示定位策略卡片
    await expect.element(screen.getByText('场景默认定位顺序')).toBeInTheDocument()
    await expect.element(screen.getByText(/四级继承机制/)).toBeInTheDocument()

    // 点击完成按钮关闭弹窗
    await screen.getByRole('button', { name: '完成' }).click()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
