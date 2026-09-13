import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ScenarioDetailDto, TargetDto } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { ScenarioDetailPage } from './detail'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const STEP_ID = '55555555-5555-4555-8555-555555555555'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchScenarios: vi.fn(),
  fetchScenario: vi.fn(),
  saveScenarioDraft: vi.fn(),
  publishScenario: vi.fn(),
  trialScenario: vi.fn(),
  fetchTarget: vi.fn(),
  fetchTargets: vi.fn(),
  fetchTargetAccounts: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => mocks)
vi.mock('@/lib/targets-api', () => ({
  fetchTarget: mocks.fetchTarget,
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))
vi.mock('@/components/layout/app-header', () => ({
  AppHeader: () => null,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({ scenarioId: SCENARIO_ID }),
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

const document = {
  schemaVersion: 1 as const,
  inputs: [] as { key: string; label: string }[],
  steps: [
    {
      id: STEP_ID,
      name: '打开页面',
      type: 'navigate' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: { url: 'https://shop.example.com' },
    },
  ],
}

function detail(overrides: Partial<ScenarioDetailDto> = {}): ScenarioDetailDto {
  return {
    id: SCENARIO_ID,
    targetId: TARGET_ID,
    name: '打开商城',
    status: 'active',
    latestVersionId: '44444444-4444-4444-8444-444444444444',
    latestVersionNo: 1,
    stepCount: 1,
    draftDirty: false,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
    steps: document.steps,
    published: {
      versionId: '44444444-4444-4444-8444-444444444444',
      versionNo: 1,
      definition: document,
      compilerVersion: 1,
      createdAt: '2026-09-13T00:00:00.000Z',
    },
    draft: {
      revision: 1,
      document,
      updatedAt: '2026-09-13T00:00:00.000Z',
      updatedBy: { id: 'acc-1', displayName: '测试' },
    },
    compile: { ok: true, compilerVersion: 1, diagnostics: [] },
    ...overrides,
  }
}

const target: TargetDto = {
  id: TARGET_ID,
  code: 'demo-shop',
  name: '演示商城',
  entryUrl: 'https://shop.example.com',
  loginUrl: null,
  authMethod: 'password',
  captchaMode: 'none',
  status: 'active',
  loginFields: null,
  accountCount: 1,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: ['workflow:read', 'workflow:write', 'run:execute', 'target:read'],
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ScenarioDetailPage />
    </QueryClientProvider>,
  )
}

describe('Scenario Studio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signIn()
    mocks.fetchScenario.mockResolvedValue(detail())
    mocks.fetchTarget.mockResolvedValue(target)
    mocks.fetchTargets.mockResolvedValue({ items: [target] })
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    mocks.fetchScenarios.mockResolvedValue({ items: [detail()] })
    mocks.saveScenarioDraft.mockImplementation(async (_id: string, body: { revision: number; document: typeof document }) =>
      detail({
        draft: {
          revision: body.revision + 1,
          document: body.document,
          updatedAt: '2026-09-13T01:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        draftDirty: true,
      }),
    )
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('改地址后保存带上当前 revision 与文档', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('打开商城')).toBeInTheDocument()
    const url = screen.getByLabelText('页面地址')
    await url.fill('https://shop.example.com/search')
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await vi.waitFor(() => expect(mocks.saveScenarioDraft).toHaveBeenCalledTimes(1))
    expect(mocks.saveScenarioDraft.mock.calls[0]![1]).toMatchObject({
      revision: 1,
      document: {
        steps: [{ type: 'navigate', input: { url: 'https://shop.example.com/search' } }],
      },
    })
  })

  it('保存冲突时保留本地输入并提示重新加载', async () => {
    mocks.saveScenarioDraft.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'req-conflict',
      }),
    )
    const screen = await renderPage()
    await screen.getByLabelText('页面地址').fill('https://shop.example.com/search')
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await expect.element(screen.getByText(/他人已更新这份草稿/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    await expect.element(screen.getByLabelText('页面地址')).toHaveValue('https://shop.example.com/search')
  })

  it('未选步骤时展示场景输入与全局诊断', async () => {
    const screen = await renderPage()
    await screen.getByRole('button', { name: '查看场景输入与全局诊断' }).click()
    await expect.element(screen.getByRole('heading', { name: '输入与诊断' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '场景输入' })).toBeInTheDocument()
    await expect.element(screen.getByRole('list', { name: '编译诊断' })).toBeInTheDocument()
    await expect.element(screen.getByText('含浏览器步骤的场景没有断言')).toBeInTheDocument()
  })

  it('未保存时试跑禁用而不是消失', async () => {
    const screen = await renderPage()
    await screen.getByLabelText('页面地址').fill('https://shop.example.com/search')
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled()
  })

  it('编译错误时试跑不可用，保存仍可用', async () => {
    const broken = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [
        {
          id: STEP_ID,
          name: '读单号',
          type: 'echo' as const,
          effectType: 'READ_ONLY' as const,
          input: { from: 'orderId' },
        },
      ],
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        steps: broken.steps,
        draft: {
          revision: 1,
          document: broken,
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        compile: {
          ok: false,
          compilerVersion: 1,
          diagnostics: [
            {
              code: 'SCENARIO_UNRESOLVED_REF',
              severity: 'error',
              message: '步骤「读单号」的 from=orderId 不是已声明输入或更早步骤的 outputKey',
              stepId: STEP_ID,
            },
          ],
        },
      }),
    )
    const screen = await renderPage()
    await expect.element(screen.getByText(/from=orderId/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument()
  })

  it('填写步骤不展示输出名称，引用可选尚未声明的键', async () => {
    const fill = {
      id: '66666666-6666-4666-8666-666666666666',
      name: '填写',
      type: 'fill' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: {
        target: { framePath: [], candidates: [{ by: 'label' as const, value: '关键字' }] },
        value: '订单',
      },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: { schemaVersion: 1, inputs: [], steps: [fill] },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [fill],
      }),
    )
    const screen = await renderPage()
    await expect.element(screen.getByLabelText('内容')).toBeInTheDocument()
    await expect.poll(() => screen.container.querySelector('#step-output-66666666-6666-4666-8666-666666666666')).toBeNull()
    await screen.getByLabelText('引用上下文').click()
    await expect.element(screen.getByRole('option', { name: '尚未声明的键' })).toBeInTheDocument()
  })

  it('上移下移会改顺序', async () => {
    const second = {
      id: '66666666-6666-4666-8666-666666666666',
      name: '填写',
      type: 'fill' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: {
        target: { framePath: [], candidates: [{ by: 'label' as const, value: '关键字' }] },
        value: '订单',
      },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: { schemaVersion: 1, inputs: [], steps: [document.steps[0]!, second] },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [document.steps[0]!, second],
      }),
    )
    const screen = await renderPage()
    await screen.getByRole('button', { name: /填写/ }).click()
    await screen.getByRole('button', { name: '上移' }).click()
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await vi.waitFor(() => expect(mocks.saveScenarioDraft).toHaveBeenCalled())
    expect(mocks.saveScenarioDraft.mock.calls[0]![1].document.steps.map((step: { type: string }) => step.type)).toEqual([
      'fill',
      'navigate',
    ])
  })
})
