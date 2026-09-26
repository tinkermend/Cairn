import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import '@/styles/index.css'
import type { ScenarioDocument, Step } from '@cairn/shared'
import { PublishDiffDrawer } from './publish-diff-drawer'

describe('PublishDiffDrawer', () => {
  const step1: Step = {
    id: '00000000-0000-4000-8000-000000000001',
    name: '打开页面',
    type: 'navigate',
    effectType: 'READ_ONLY',
    input: { url: 'https://example.com' },
  }

  const step2: Step = {
    id: '00000000-0000-4000-8000-000000000002',
    name: '输入用户名',
    type: 'fill',
    effectType: 'SIDE_EFFECT',
    input: {
      target: { framePath: [], candidates: [{ by: 'css', value: '#username' }] },
      value: 'admin',
    },
  }

  it('open: false 时不渲染任何抽屉元素', async () => {
    const screen = await render(
      <PublishDiffDrawer
        open={false}
        scenarioName='测试场景'
        draftDoc={{ schemaVersion: 1, inputs: [], steps: [step1] }}
        publishing={false}
        onClose={() => {}}
        onConfirmPublish={() => {}}
      />,
    )

    await expect.element(screen.getByTestId('publish-diff-drawer-root')).not.toBeInTheDocument()
  })

  it('初始发布时正确展示 v1 标识与新增步骤统计，点击确认发布触发回调', async () => {
    const onConfirmPublish = vi.fn()
    const draftDoc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [{ key: 'targetUser', label: '目标用户' }],
      steps: [step1],
    }

    const screen = await render(
      <PublishDiffDrawer
        open={true}
        scenarioName='自动化巡检流程'
        draftDoc={draftDoc}
        publishing={false}
        onClose={() => {}}
        onConfirmPublish={onConfirmPublish}
      />,
    )

    await expect.element(screen.getByText('发布版本确认')).toBeInTheDocument()
    await expect.element(screen.getByText('初始版本 · v1')).toBeInTheDocument()
    await expect.element(screen.getByText(/全新发布，共计/)).toBeInTheDocument()

    const confirmBtn = screen.getByText('确认并正式发布')
    await confirmBtn.click()

    expect(onConfirmPublish).toHaveBeenCalled()
  })

  it('增量修改时展示版本跃迁（v2 → v3）与修改卡片', async () => {
    const baselineDoc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [step1],
    }
    const modifiedStep1: Step = {
      ...step1,
      name: '打开测试首页',
    }
    const draftDoc: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [modifiedStep1, step2], // 修改了 step1，新增了 step2
    }

    const screen = await render(
      <PublishDiffDrawer
        open={true}
        scenarioName='核心业务流'
        currentVersionNo={2}
        baselineDoc={baselineDoc}
        draftDoc={draftDoc}
        publishing={false}
        onClose={() => {}}
        onConfirmPublish={() => {}}
      />,
    )

    await expect.element(screen.getByText('v2 → v3')).toBeInTheDocument()
    await expect.element(screen.getByText('+ 1 新增')).toBeInTheDocument()
    await expect.element(screen.getByText('~ 1 修改')).toBeInTheDocument()
    await expect.element(screen.getByText('步骤：打开测试首页')).toBeInTheDocument()
    await expect.element(screen.getByText('步骤：输入用户名')).toBeInTheDocument()
  })
})
