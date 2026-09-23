import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScenarioDetailDto, TargetDto } from '@cairn/shared'
import '@/styles/index.css'
import { StudioToolbar } from './studio-toolbar'
import { useAssistantStore } from '@/stores/assistant-store'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className, title, ...props }: any) => (
    <a href='#' className={className} title={title} {...props}>{children}</a>
  ),
}))

vi.mock('@/features/schedules/object-schedules', () => ({
  ObjectSchedules: ({ trigger, size }: { trigger?: (props: { onClick: () => void }) => React.ReactNode; size?: string }) => {
    if (trigger) {
      return trigger({ onClick: () => {} })
    }
    return <button data-testid='object-schedules-btn'>定时任务</button>
  },
}))

const mockScenario: ScenarioDetailDto = {
  id: 'sc-1',
  targetId: 'target-1',
  name: '测试用场景名称很长很长很长很长',
  latestVersionId: 'v-1',
  latestVersionNo: 1,
  status: 'active',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  draft: {
    revision: 1,
    document: { steps: [] },
  },
}

const mockTarget: TargetDto = {
  id: 'target-1',
  name: '目标电商中台',
  entryUrl: 'https://example.com',
  status: 'active',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

function renderToolbar(containerWidth = 1000) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <div style={{ width: `${containerWidth}px` }}>
        <StudioToolbar
          scenario={mockScenario}
          target={mockTarget}
          scenarioId={mockScenario.id}
          revision={1}
          dirty={false}
          hasDraftDirty={false}
          saving={false}
          publishing={false}
          canWrite={true}
          canTrial={true}
          canStartFormalRun={true}
          trialDisabledReason={undefined}
          canPublish={false}
          unpublishedDraft={false}
          compileOk={true}
          canReadTarget={true}
          canAssist={true}
          canPropose={true}
          canRecord={true}
          canDelete={true}
          disabled={false}
          onSave={() => {}}
          onPublish={() => {}}
          onStartTrial={() => {}}
          onOpenRun={() => {}}
          onOpenImport={() => {}}
          onOpenRename={() => {}}
          onToggleStatus={() => {}}
          onOpenRemove={() => {}}
          onOpenAssistant={() => {}}
          onLeave={() => {}}
        />
      </div>
    </QueryClientProvider>
  )
}

describe('StudioToolbar 容器响应式与侧边栏自适应', () => {
  it('当容器宽度较窄（模拟挂靠知识助手，宽 960px）时，次要操作收纳到「更多」下拉菜单', async () => {
    // 模拟挂靠助手侧边栏
    useAssistantStore.setState({ open: true, mode: 'docked', dockWidth: 400 })

    const screen = await renderToolbar(960)

    // 核心主操作保持平铺可达
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeInTheDocument()
    const moreBtn = screen.getByRole('button', { name: '更多' })
    await expect.element(moreBtn).toBeInTheDocument()

    // 外部工具栏未直接展示平铺的次要快捷按钮
    expect(screen.getByTestId('object-schedules-btn').elements()).toHaveLength(0)

    // 场景名称与上下文胶囊均正常展示，不发生溢出挤压
    await expect.element(screen.getByText('测试用场景名称很长很长很长很长')).toBeInTheDocument()
    await expect.element(screen.getByText('目标电商中台')).toBeInTheDocument()

    // 点击「更多」后，次要操作出现在下拉菜单中
    await moreBtn.click()
    await expect.element(screen.getByRole('menuitem', { name: '定时任务' })).toBeInTheDocument()
    await expect.element(screen.getByRole('menuitem', { name: '结果通知' })).toBeInTheDocument()
    await expect.element(screen.getByRole('menuitem', { name: '解释当前步骤' })).toBeInTheDocument()
    await expect.element(screen.getByRole('menuitem', { name: '修改建议' })).toBeInTheDocument()
  })

  it('当容器宽度充裕（无侧边栏或超宽屏，宽 1440px）时，次要操作平铺展开为独立按钮', async () => {
    useAssistantStore.setState({ open: false, mode: 'floating' })

    const screen = await renderToolbar(1440)

    // 快捷按钮直接在外部工具栏平铺展开
    await expect.element(screen.getByTestId('object-schedules-btn')).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: /结果通知/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /解释步骤/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /修改建议/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeInTheDocument()

    // 点击「更多」后，下拉菜单中不再重复显示这 4 个快捷操作
    const moreBtn = screen.getByRole('button', { name: '更多' })
    await moreBtn.click()
    expect(screen.getByRole('menuitem', { name: '定时任务' }).elements()).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: '结果通知' }).elements()).toHaveLength(0)
    // 但常规操作（如“运行已发布版本”）依然在更多菜单中
    await expect.element(screen.getByRole('menuitem', { name: '运行已发布版本' })).toBeInTheDocument()
  })

  it('当外部容器尺寸动态变化时，自适应平滑切换展示形态', async () => {
    useAssistantStore.setState({ open: false, mode: 'floating' })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div id='test-wrapper' style={{ width: '1500px' }}>
          <StudioToolbar
            scenario={mockScenario}
            target={mockTarget}
            scenarioId={mockScenario.id}
            revision={1}
            dirty={false}
            hasDraftDirty={false}
            saving={false}
            publishing={false}
            canWrite={true}
            canTrial={true}
            canStartFormalRun={true}
            trialDisabledReason={undefined}
            canPublish={false}
            unpublishedDraft={false}
            compileOk={true}
            canReadTarget={true}
            canAssist={true}
            canPropose={true}
            canRecord={true}
            canDelete={true}
            disabled={false}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={() => {}}
            onOpenRun={() => {}}
            onOpenImport={() => {}}
            onOpenRename={() => {}}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onOpenAssistant={() => {}}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>
    )

    // 大屏下展开
    await expect.element(screen.getByTestId('object-schedules-btn')).toBeInTheDocument()

    // 模拟挂靠助手侧边栏导致工作区容器宽度变窄为 900px
    const wrapper = document.getElementById('test-wrapper')
    if (wrapper) {
      wrapper.style.width = '900px'
    }

    // 等待 ResizeObserver 生效，快捷按钮收进更多
    await expect.poll(() => screen.getByTestId('object-schedules-btn').elements()).toHaveLength(0)
    await expect.element(screen.getByRole('button', { name: '更多' })).toBeInTheDocument()
  })
})
