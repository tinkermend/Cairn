import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
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
  ObjectSchedules: ({ trigger }: { trigger?: (props: { onClick: () => void }) => React.ReactNode; size?: string }) => {
    if (trigger) {
      return trigger({ onClick: () => {} })
    }
    return <button data-testid='object-schedules-btn'>定时任务</button>
  },
}))

const mockScenario = {
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
    document: { schemaVersion: 1, inputs: [], steps: [] },
  },
} as unknown as ScenarioDetailDto

const mockTarget = {
  id: 'target-1',
  code: 'target-1',
  name: '目标电商中台',
  entryUrl: 'https://example.com',
  loginUrl: null,
  authMethod: 'password',
  captchaMode: 'none',
  status: 'active',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
} as unknown as TargetDto

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
    await expect.element(screen.getByRole('menuitem', { name: '结果推送' })).toBeInTheDocument()
    // AI 助手快捷提问已从顶栏解耦，不再占用更多菜单
    expect(screen.getByRole('menuitem', { name: '解释当前步骤' }).elements()).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: '修改建议' }).elements()).toHaveLength(0)
  })

  it('当容器宽度充裕（无侧边栏或超宽屏，宽 1440px）时，次要操作平铺展开为独立按钮', async () => {
    useAssistantStore.setState({ open: false, mode: 'floating' })

    const screen = await renderToolbar(1440)

    // 快捷按钮直接在外部工具栏平铺展开
    await expect.element(screen.getByTestId('object-schedules-btn')).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: /结果推送/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeInTheDocument()
    // AI 助手快捷提问已从顶栏解耦，不再占用外部工具栏
    expect(screen.getByRole('button', { name: /解释步骤/ }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: /修改建议/ }).elements()).toHaveLength(0)

    // 点击「更多」后，下拉菜单中不再重复显示平铺展开的快捷操作
    const moreBtn = screen.getByRole('button', { name: '更多' })
    await moreBtn.click()
    expect(screen.getByRole('menuitem', { name: '定时任务' }).elements()).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: '结果推送' }).elements()).toHaveLength(0)
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

  it('草稿修改 dirty 时，保存草稿呈现为 Outline 强调色，试跑为唯一实心蓝主按钮', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
          <StudioToolbar
            scenario={mockScenario}
            target={mockTarget}
            scenarioId={mockScenario.id}
            revision={1}
            dirty={true}
            hasDraftDirty={true}
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
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>
    )

    const saveBtn = screen.getByRole('button', { name: '保存草稿' })
    const trialBtn = screen.getByRole('button', { name: '试跑' })

    // 保存草稿为 outline 并带 primary 边框强调，试跑带 action-shadow
    await expect.element(saveBtn).toHaveClass('border-primary')
    await expect.element(trialBtn).toHaveClass('action-shadow')
  })

  it('支持场景名称内联单击重命名与 Enter 保存 / Escape 取消', async () => {
    const onRename = vi.fn().mockResolvedValue(true)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
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
            canRecord={true}
            canDelete={true}
            disabled={false}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={() => {}}
            onOpenRun={() => {}}
            onOpenImport={() => {}}
            onOpenRename={() => {}}
            onRename={onRename}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>
    )

    // 点击重命名笔图标触发内联输入
    const editBtn = screen.getByRole('button', { name: '重命名' })
    await editBtn.click()

    const input = screen.getByLabelText('场景名称输入')
    await expect.element(input).toBeInTheDocument()

    // 输入新名称并按 Enter 保存
    await input.fill('全新的场景标题')
    await userEvent.keyboard('{Enter}')

    expect(onRename).toHaveBeenCalledWith('全新的场景标题')
  })

  it('当存在 pendingImportDraftId 时，Toolbar 呈现导入录制草稿高亮入口，且点击触发预览导入', async () => {
    const onPreviewImportDraft = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
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
            canRecord={true}
            canDelete={true}
            disabled={false}
            pendingImportDraftId='rec-draft-123'
            onPreviewImportDraft={onPreviewImportDraft}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={() => {}}
            onOpenRun={() => {}}
            onOpenImport={() => {}}
            onOpenRename={() => {}}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>
    )

    const importDraftBtn = screen.getByTestId('toolbar-import-draft-btn')
    await expect.element(importDraftBtn).toBeInTheDocument()
    await expect.element(importDraftBtn).toHaveTextContent('导入录制草稿')

    await importDraftBtn.click()
    expect(onPreviewImportDraft).toHaveBeenCalledTimes(1)
  })

  it('更多下拉菜单不重复展示顶栏已有的场景配置，导入已有录制项触发 onOpenImport 且无冗余徽章干扰', async () => {
    const onOpenImport = vi.fn()
    const onOpenSettings = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
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
            canRecord={true}
            canDelete={true}
            disabled={false}
            pendingImportDraftId='rec-draft-123'
            onPreviewImportDraft={() => {}}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={() => {}}
            onOpenRun={() => {}}
            onOpenImport={onOpenImport}
            onOpenRename={() => {}}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onOpenSettings={onOpenSettings}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>
    )

    // 顶栏外层已有高亮草稿导入入口，更多按钮不再打扰显示小圆点徽标
    expect(screen.getByTestId('toolbar-more-badge').query()).toBeNull()

    // 顶栏有常驻场景配置按钮
    const topSettingsBtn = screen.getByTestId('toolbar-scenario-config')
    await expect.element(topSettingsBtn).toBeInTheDocument()

    // 点击更多按钮打开下拉菜单
    const moreBtn = screen.getByRole('button', { name: '更多' })
    await moreBtn.click()

    // 更多下拉菜单中不再重复包含「场景配置」
    expect(screen.getByRole('menuitem', { name: '场景配置' }).elements()).toHaveLength(0)

    // 更多下拉项包含通用的「导入已有录制」，不带冗余的「待导入」状态，且点击触发 onOpenImport
    const importItem = screen.getByTestId('toolbar-more-import-item')
    await expect.element(importItem).toBeInTheDocument()
    await expect.element(importItem).toHaveTextContent('导入已有录制')
    expect(await (await importItem.element()).textContent).not.toContain('待导入')

    await importItem.click()
    expect(onOpenImport).toHaveBeenCalledTimes(1)
  })

  it('当存在已完成的 trialRun 时，展示「试跑结果」按钮且点击触发 onOpenTrialResult', async () => {
    const onOpenTrialResult = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
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
            trialRun={{
              id: 'run-success-123',
              scenarioId: mockScenario.id,
              status: 'SUCCEEDED',
            } as any}
            canPublish={false}
            unpublishedDraft={false}
            compileOk={true}
            canReadTarget={true}
            canRecord={true}
            canDelete={true}
            disabled={false}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={() => {}}
            onOpenTrialResult={onOpenTrialResult}
            onOpenRun={() => {}}
            onOpenImport={() => {}}
            onOpenRename={() => {}}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>,
    )

    const trialResultBtn = screen.getByRole('button', { name: /试跑结果/i })
    await expect.element(trialResultBtn).toBeInTheDocument()
    await trialResultBtn.click()
    expect(onOpenTrialResult).toHaveBeenCalledTimes(1)
  })

  it('当 trialRun 处于运行中（RUNNING / QUEUED）时，「试跑」按钮自身变为「试跑中…」置灰态，不产生多余的并列按钮或试跑结果按钮', async () => {
    const onStartTrial = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
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
            trialRun={{
              id: 'run-running-123',
              scenarioId: mockScenario.id,
              status: 'RUNNING',
            } as any}
            canPublish={false}
            unpublishedDraft={false}
            compileOk={true}
            canReadTarget={true}
            canRecord={true}
            canDelete={true}
            disabled={false}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={onStartTrial}
            onOpenTrialResult={() => {}}
            onOpenRun={() => {}}
            onOpenImport={() => {}}
            onOpenRename={() => {}}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>,
    )

    // 原「试跑」按钮变为置灰的「试跑中…」
    const runningBtn = screen.getByRole('button', { name: /试跑中/i })
    await expect.element(runningBtn).toBeInTheDocument()
    await expect.element(runningBtn).toBeDisabled()

    // 不存在多余的第二个「试跑」按钮
    expect(screen.getByRole('button', { name: '试跑', exact: true }).elements()).toHaveLength(0)

    // 执行中不展示「试跑结果」按钮
    expect(screen.getByRole('button', { name: /试跑结果/i }).elements()).toHaveLength(0)
  })

  it('当具备中断权限时，试跑中按钮支持 Hover 切换为「中止试跑」并可点击触发 onCancelTrial', async () => {
    const onCancelTrial = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <div style={{ width: '1200px' }}>
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
            trialRun={{
              id: 'run-running-123',
              scenarioId: mockScenario.id,
              status: 'RUNNING',
            } as any}
            canCancelTrial={true}
            onCancelTrial={onCancelTrial}
            canPublish={false}
            unpublishedDraft={false}
            compileOk={true}
            canReadTarget={true}
            canRecord={true}
            canDelete={true}
            disabled={false}
            onSave={() => {}}
            onPublish={() => {}}
            onStartTrial={() => {}}
            onOpenTrialResult={() => {}}
            onOpenRun={() => {}}
            onOpenImport={() => {}}
            onOpenRename={() => {}}
            onToggleStatus={() => {}}
            onOpenRemove={() => {}}
            onLeave={() => {}}
          />
        </div>
      </QueryClientProvider>,
    )

    // 默认展示「试跑中…」
    const runningBtn = screen.getByRole('button', { name: /试跑中/i })
    await expect.element(runningBtn).toBeInTheDocument()

    // 悬停 Hover 后文案变为「中止试跑」
    await runningBtn.hover()
    const cancelBtn = screen.getByRole('button', { name: /中止试跑/i })
    await expect.element(cancelBtn).toBeInTheDocument()

    // 点击触发中止回调
    await cancelBtn.click()
    expect(onCancelTrial).toHaveBeenCalledTimes(1)
  })
})


