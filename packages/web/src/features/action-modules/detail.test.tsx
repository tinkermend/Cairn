import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { compileModuleContent } from '@cairn/authoring'
import {
  actionModuleDetailSchema,
  moduleContentSchema,
  moduleWarningKey,
  scenarioCapabilitiesFor,
  type ActionModuleDetail,
} from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { ApiRequestError } from '@/lib/api-client'
import { SidebarProvider } from '@/components/ui/sidebar'
import { ActionModuleDetailPage } from './detail'

const mocks = vi.hoisted(() => ({
  fetchActionModule: vi.fn(),
  fetchActionModuleVersions: vi.fn(),
  fetchActionModuleVersion: vi.fn(),
  fetchModuleCapabilities: vi.fn(),
  saveActionModuleDraft: vi.fn(),
  publishActionModule: vi.fn(),
  updateActionModuleMeta: vi.fn(),
  trialActionModule: vi.fn(),
  fetchActionModuleReferences: vi.fn(),
  fetchActionModuleQuality: vi.fn(),
  fetchModuleInvocations: vi.fn(),
  updateActionModulePublication: vi.fn(),
  disableAffectedScenarios: vi.fn(),
  batchUpgradeActionModuleDrafts: vi.fn(),
  navigate: vi.fn(),
  canWrite: true,
}))
vi.mock('@/lib/action-modules-api', () => mocks)
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
}))
vi.mock('@/hooks/use-permissions', () => ({
  useCan: (permission: string) =>
    permission !== 'module:write' || mocks.canWrite,
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTarget: async () => ({ name: '复查目标' }),
}))
const moduleId = '11111111-1111-4111-8111-111111111111'
const stepId = '33333333-3333-4333-8333-333333333333'
const fixture = (): ActionModuleDetail =>
  actionModuleDetailSchema.parse({
    id: moduleId,
    targetId: '22222222-2222-4222-8222-222222222222',
    key: 'order.query',
    name: '查询订单',
    draftRevision: 1,
    tags: [],
    aliases: [],
    intentExamples: [],
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    draftContent: {
      contract: {
        inputs: [],
        outputs: [],
        preconditions: [],
        postconditions: [
          { meaning: '页面显示结果', verification: { kind: 'step', stepId } },
        ],
        effectCeiling: 'READ_ONLY',
      },
      implementations: [
        {
          implementationKey: 'default',
          kind: 'structured_steps',
          steps: [
            {
              id: stepId,
              name: '检查结果',
              type: 'assert',
              effectType: 'READ_ONLY',
              input: { expect: { kind: 'text_contains', value: '订单' } },
            },
          ],
          outputMapping: {},
        },
      ],
    },
  })
async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <ActionModuleDetailPage moduleId={moduleId} />
      </SidebarProvider>
    </QueryClientProvider>
  )
  await expect
    .element(screen.getByRole('heading', { name: '查询订单', exact: true }))
    .toBeVisible()
  return { screen, client }
}
describe('AM-A action module editor review', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.canWrite = true
    await page.viewport(1440, 1000)
    const module = fixture()
    mocks.fetchActionModule.mockResolvedValue(module)
    mocks.fetchActionModuleVersions.mockResolvedValue({ items: [] })
    mocks.fetchModuleCapabilities.mockResolvedValue(
      scenarioCapabilitiesFor({ browserAiEnabled: false })
    )
    mocks.saveActionModuleDraft.mockImplementation(async (_id, body) => ({
      ...module,
      draftRevision: body.baseRevision + 1,
      draftContent: moduleContentSchema.parse(body.content),
    }))
    mocks.publishActionModule.mockResolvedValue(module)
    mocks.updateActionModuleMeta.mockImplementation(async (_id, body) => ({
      ...module,
      ...body,
      draftRevision: body.baseRevision + 1,
    }))
    mocks.fetchActionModuleQuality.mockResolvedValue({
      moduleId,
      versionId: null,
      windowDays: 7,
      groupBy: 'none',
      asOf: '2026-09-16T00:00:00.000Z',
      configRevision: 1,
      health: {
        signal: 'unknown',
        sampleCount: 0,
        verifiedRate: null,
        windowDays: 7,
        configRevision: 1,
        asOf: '2026-09-16T00:00:00.000Z',
        verificationInsufficient: false,
      },
      overall: {
        calls: 0,
        verified: 0,
        failedImplementation: 0,
        failedVerification: 0,
        externalInfra: 0,
        needsReview: 0,
        notReached: 0,
        cancelled: 0,
        unknown: 0,
        insufficient: 0,
        retriedSuccess: 0,
        sampleCount: 0,
        verifiedRate: null,
        durationMsP50: null,
        durationMsP95: null,
        aiCalls: 0,
        aiCost: null,
        lastVerifiedAt: null,
      },
      trial: {
        calls: 0,
        verified: 0,
        failedImplementation: 0,
        failedVerification: 0,
        externalInfra: 0,
        needsReview: 0,
        notReached: 0,
        cancelled: 0,
        unknown: 0,
        insufficient: 0,
        retriedSuccess: 0,
        sampleCount: 0,
        verifiedRate: null,
        durationMsP50: null,
        durationMsP95: null,
        aiCalls: 0,
        aiCost: null,
        lastVerifiedAt: null,
      },
      pendingBackfill: 0,
    })
    mocks.fetchModuleInvocations.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      asOf: '2026-09-16T00:00:00.000Z',
    })
    mocks.fetchActionModuleReferences.mockResolvedValue({
      items: [
        {
          scenarioId: '44444444-4444-4444-8444-444444444444',
          name: '场景甲',
          status: 'active',
          purpose: 'user',
          draftUses: [{ invocationId: stepId, versionNo: 1 }],
          publishedUses: [],
          lastRun: null,
          upgradeAvailable: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
    })
    mocks.updateActionModulePublication.mockResolvedValue({
      id: stepId,
      publicationStatus: 'deprecated',
    })
  })
  it('添加、编辑、排序步骤并保存当前内容；未保存时禁止发布', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '添加步骤', exact: true }).click()
    await expect
      .element(screen.getByRole('button', { name: '在页面上指认' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '校验高亮' }))
      .not.toBeInTheDocument()
    await screen.getByLabelText('步骤名称', { exact: true }).fill('新断言')
    await expect
      .element(screen.getByRole('button', { name: '发布新版本' }))
      .toBeDisabled()
    await screen.getByRole('button', { name: '上移', exact: true }).click()
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await expect
      .poll(() => mocks.saveActionModuleDraft.mock.calls.length)
      .toBe(1)
    const body = mocks.saveActionModuleDraft.mock.calls[0]![1]
    expect(body.baseRevision).toBe(1)
    expect(body.content.implementations[0].steps[0].name).toBe('新断言')
    expect(body.content.implementations[0].steps).toHaveLength(2)
    await expect
      .element(screen.getByRole('button', { name: '发布新版本' }))
      .toBeEnabled()
  })
  it('每条警告显式勾选；同码的第二条警告不能被自动确认', async () => {
    const module = fixture()
    module.draftContent!.contract.inputs = ['a', 'b'].map((key) => ({
      key,
      label: key,
      required: false,
      valueType: 'string',
    }))
    mocks.fetchActionModule.mockResolvedValue(module)
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '发布新版本' }).click()
    const warnings = compileModuleContent(module.draftContent!, {
      mode: 'release',
    }).diagnostics.filter((d) => d.severity === 'warning')
    await expect
      .element(screen.getByRole('button', { name: '确认发布' }))
      .toBeDisabled()
    await screen.getByLabelText(`确认警告：${warnings[0]!.message}`).click()
    await expect
      .element(screen.getByRole('button', { name: '确认发布' }))
      .toBeDisabled()
    await screen.getByLabelText(`确认警告：${warnings[1]!.message}`).click()
    await screen.getByRole('button', { name: '确认发布' }).click()
    await expect.poll(() => mocks.publishActionModule.mock.calls.length).toBe(1)
    expect(mocks.publishActionModule.mock.calls[0]![1]).toMatchObject({
      expectedRevision: 1,
      confirmedWarnings: warnings.map(moduleWarningKey),
      idempotencyKey: expect.any(String),
    })
  })
  it('OCC 冲突和后台刷新保留本地内容与原 revision，可比较远端', async () => {
    mocks.saveActionModuleDraft.mockRejectedValue(
      new ApiRequestError(409, {
        code: 'MODULE_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'review',
      })
    )
    const { screen, client } = await renderPage()
    await screen
      .getByLabelText('步骤名称', { exact: true })
      .fill('本地尚未保存')
    const remote = fixture()
    remote.draftRevision = 2
    remote.draftContent!.implementations[0]!.steps[0]!.name = '他人已保存'
    client.setQueryData(['action-module', moduleId], remote)
    await expect
      .element(screen.getByLabelText('步骤名称', { exact: true }))
      .toHaveValue('本地尚未保存')
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await expect
      .poll(() => mocks.saveActionModuleDraft.mock.calls.length)
      .toBe(1)
    expect(mocks.saveActionModuleDraft.mock.calls[0]![1].baseRevision).toBe(1)
    mocks.fetchActionModule.mockResolvedValue(remote)
    await screen.getByRole('button', { name: '加载远端用于比较' }).click()
    await expect.element(screen.getByText('远端修订 r2')).toBeVisible()
    await expect
      .element(screen.getByLabelText('步骤名称', { exact: true }))
      .toHaveValue('本地尚未保存')
  })
  it('前置条件和起止状态可编辑，人工说明始终标为未自动验证', async () => {
    const { screen } = await renderPage()
    for (const section of ['前置条件', '入口状态', '结束状态']) {
      await screen
        .getByRole('button', { name: `添加${section}`, exact: true })
        .click()
      await screen.getByLabelText(`${section} 1 含义`).fill(`${section}说明`)
    }
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await expect
      .poll(() => mocks.saveActionModuleDraft.mock.calls.length)
      .toBe(1)
    expect(
      mocks.saveActionModuleDraft.mock.calls[0]![1].content.contract
    ).toMatchObject({
      preconditions: [
        {
          meaning: '前置条件说明',
          verification: { kind: 'manual_requirement' },
        },
      ],
      entryState: { meaning: '入口状态说明' },
      exitState: { meaning: '结束状态说明' },
    })
  })
  it('版本内容使用冻结快照，查看时没有保存或添加步骤入口', async () => {
    const content = fixture().draftContent!
    content.implementations[0]!.steps[0]!.name = '历史断言'
    mocks.fetchActionModuleVersions.mockResolvedValue({
      items: [
        {
          id: stepId,
          moduleId,
          versionNo: 1,
          content,
          contentDigest: 'digest',
          contractDigest: 'contract',
          implementationDigest: 'impl',
          compilerVersion: 2,
          executionMode: 'DETERMINISTIC',
          effectCeiling: 'READ_ONLY',
          publicationStatus: 'published',
          sourceDraftRevision: 1,
          createdBy: moduleId,
          createdAt: '2026-09-16T00:00:00.000Z',
        },
      ],
    })
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '查看 v1 内容' }).click()
    const dialog = screen.getByRole('dialog')
    await expect
      .element(dialog.getByLabelText('步骤名称', { exact: true }))
      .toHaveValue('历史断言')
    await expect
      .element(dialog.getByLabelText('步骤名称', { exact: true }))
      .toBeDisabled()
    await expect
      .element(dialog.getByRole('button', { name: '添加步骤', exact: true }))
      .not.toBeInTheDocument()
  })
  it('只读身份没有保存入口，步骤字段禁用', async () => {
    mocks.canWrite = false
    const { screen } = await renderPage()
    await expect
      .element(screen.getByRole('button', { name: '保存草稿' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('步骤名称', { exact: true }))
      .toBeDisabled()
  })
  it('桌面与窄屏内容可达，键盘可操作发布确认', async () => {
    const { screen } = await renderPage()
    await page.viewport(390, 844)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(391)
    await screen.getByRole('button', { name: '发布新版本' }).click()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '发布新版本' }))
      .toHaveFocus()
  })
  it('点击试跑弹出输入参数弹窗并成功发起试跑并跳转', async () => {
    const trialRunDto = {
      id: '99999999-9999-4999-8999-999999999999',
      status: 'QUEUED',
    }
    mocks.trialActionModule.mockResolvedValue(trialRunDto)
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '试跑' }).click()
    const dialog = screen.getByRole('dialog')
    await expect.element(dialog.getByText('试跑模块草稿')).toBeInTheDocument()
    await dialog.getByRole('button', { name: '开始试跑' }).click()
    expect(mocks.trialActionModule).toHaveBeenCalledWith(
      moduleId,
      expect.objectContaining({
        inputs: {},
      })
    )
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/runs/$runId',
      params: { runId: trialRunDto.id },
    })
  })
  it('引用页签列出场景，弃用版本必须填写原因', async () => {
    const content = fixture().draftContent!
    mocks.fetchActionModuleVersions.mockResolvedValue({
      items: [
        {
          id: stepId,
          moduleId,
          versionNo: 1,
          content,
          contentDigest: 'digest',
          contractDigest: 'contract',
          implementationDigest: 'impl',
          compilerVersion: 2,
          executionMode: 'DETERMINISTIC',
          effectCeiling: 'READ_ONLY',
          publicationStatus: 'published',
          sourceDraftRevision: 1,
          createdBy: moduleId,
          createdAt: '2026-09-16T00:00:00.000Z',
        },
      ],
    })
    const { screen } = await renderPage()
    await screen.getByRole('tab', { name: '引用' }).click()
    await expect.element(screen.getByText('场景甲')).toBeInTheDocument()
    await screen.getByRole('tab', { name: '编辑' }).click()
    await screen.getByRole('button', { name: '弃用' }).click()
    await expect
      .element(screen.getByRole('button', { name: '弃用此版本' }))
      .toBeDisabled()
    await screen.getByLabelText('发布状态变更原因').fill('准备升级')
    await screen.getByRole('button', { name: '弃用此版本' }).click()
    await expect
      .poll(() => mocks.updateActionModulePublication.mock.calls.length)
      .toBe(1)
    expect(mocks.updateActionModulePublication.mock.calls[0]).toEqual([
      moduleId,
      stepId,
      { status: 'deprecated', reason: '准备升级' },
    ])
  })

  it('运行质量页签展示空态与健康提示', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('tab', { name: '运行质量' }).click()
    await expect
      .element(screen.getByText('还没有可展示的模块调用结果。'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('通过率 样本不足（样本 0）'))
      .toBeInTheDocument()
    expect(mocks.fetchActionModuleQuality).toHaveBeenCalled()
  })
})
