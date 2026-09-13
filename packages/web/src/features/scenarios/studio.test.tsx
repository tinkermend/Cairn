import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RunDetailDto, ScenarioCapabilities, ScenarioDetailDto, TargetDto } from '@cairn/shared'
import { scenarioCapabilitiesFor } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ApiRequestError } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'
import { DETERMINISTIC_STUDIO_TYPES } from './step-registry'
import { ScenarioDetailPage } from './detail'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const STEP_ID = '55555555-5555-4555-8555-555555555555'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '77777777-7777-4777-8777-777777777777'
const EXTRACT_ID = '66666666-6666-4666-8666-666666666666'
const ECHO_ID = '88888888-8888-4888-8888-888888888888'
const LATER_ID = '99999999-9999-4999-8999-999999999999'
const AI_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const mocks = vi.hoisted(() => ({
  fetchScenarios: vi.fn(),
  fetchScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn(),
  saveScenarioDraft: vi.fn(),
  publishScenario: vi.fn(),
  trialScenario: vi.fn(),
  fetchTarget: vi.fn(),
  fetchTargets: vi.fn(),
  fetchTargetAccounts: vi.fn(),
}))

const runMocks = vi.hoisted(() => ({
  fetchRun: vi.fn(),
  fetchRunEvidence: vi.fn(),
}))

const router = vi.hoisted(() => ({
  search: { runId: undefined as string | undefined },
  navigate: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => mocks)
vi.mock('@/lib/targets-api', () => ({
  fetchTarget: mocks.fetchTarget,
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))
vi.mock('@/lib/runs-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runs-api')>()),
  fetchRun: runMocks.fetchRun,
  fetchRunEvidence: runMocks.fetchRunEvidence,
}))
vi.mock('@/components/layout/app-header', () => ({
  AppHeader: () => null,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({ scenarioId: SCENARIO_ID }),
    useSearch: () => router.search,
    useNavigate: () => router.navigate,
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

const defaultCapabilities: ScenarioCapabilities = scenarioCapabilitiesFor({ browserAiEnabled: false })

const openAiCapabilities: ScenarioCapabilities = {
  executableStepTypes: [...DETERMINISTIC_STUDIO_TYPES, 'ai_action', 'ai_extract', 'ai_assert'],
  unavailableReasons: [],
}

function trialRun(overrides: Partial<RunDetailDto> = {}): RunDetailDto {
  return {
    id: RUN_ID,
    status: 'QUEUED',
    cancelRequested: false,
    targetId: TARGET_ID,
    targetName: '演示商城',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: SCENARIO_ID,
    scenarioName: '打开商城',
    scenarioVersionId: '44444444-4444-4444-8444-444444444444',
    scenarioVersionKind: 'trial',
    createdAt: '2026-09-13T02:00:00.000Z',
    startedAt: '2026-09-13T02:00:01.000Z',
    finishedAt: null,
    evidenceStatus: 'PENDING',
    lease: null,
    placement: {
      state: 'not_applicable',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
    },
    snapshot: {
      schemaVersion: 1,
      runId: RUN_ID,
      targetId: TARGET_ID,
      scenarioId: SCENARIO_ID,
      scenarioVersionId: '44444444-4444-4444-8444-444444444444',
      steps: document.steps,
      input: {},
      createdAt: '2026-09-13T02:00:00.000Z',
    },
    context: {},
    stepRuns: [],
    ...overrides,
  }
}

function signIn(permissions = ['workflow:read', 'workflow:write', 'run:execute', 'target:read']) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(
    <QueryClientProvider client={client}>
      <ScenarioDetailPage />
    </QueryClientProvider>,
  )
  return { screen, client }
}

describe('Scenario Studio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    router.search = { runId: undefined }
    signIn()
    mocks.fetchScenario.mockResolvedValue(detail())
    mocks.fetchScenarioCapabilities.mockResolvedValue(defaultCapabilities)
    mocks.fetchTarget.mockResolvedValue(target)
    mocks.fetchTargets.mockResolvedValue({ items: [target] })
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    mocks.fetchScenarios.mockResolvedValue({ items: [detail()] })
    runMocks.fetchRun.mockResolvedValue(trialRun())
    runMocks.fetchRunEvidence.mockResolvedValue({ items: [] })
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
    const { screen } = await renderPage()
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
    const { screen } = await renderPage()
    await screen.getByLabelText('页面地址').fill('https://shop.example.com/search')
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await expect.element(screen.getByText(/他人已更新这份草稿/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
    await expect.element(screen.getByLabelText('页面地址')).toHaveValue('https://shop.example.com/search')
  })

  it('未选步骤时展示场景输入与全局诊断', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '查看场景输入与全局诊断' }).click()
    await expect.element(screen.getByRole('heading', { name: '输入与诊断' })).toBeInTheDocument()
    await expect.element(screen.getByRole('heading', { name: '场景输入' })).toBeInTheDocument()
    await expect.element(screen.getByRole('list', { name: '编译诊断' })).toBeInTheDocument()
    await expect.element(screen.getByText('含浏览器步骤的场景没有断言')).toBeInTheDocument()
  })

  it('未保存时试跑禁用而不是消失', async () => {
    const { screen } = await renderPage()
    await screen.getByLabelText('页面地址').fill('https://shop.example.com/search')
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeEnabled()
  })

  it('空地址只留在字段草稿，保存不会发出请求', async () => {
    const { screen } = await renderPage()
    await screen.getByLabelText('页面地址').fill('')
    await screen.getByRole('button', { name: '保存草稿' }).click()
    expect(mocks.saveScenarioDraft).not.toHaveBeenCalled()
    await expect.element(screen.getByLabelText('页面地址')).toHaveValue('')
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
    const { screen } = await renderPage()
    await expect.element(screen.getByText(/from=orderId/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument()
  })

  it('填写步骤不展示输出名称，引用可选尚未声明的键', async () => {
    const fill = {
      id: EXTRACT_ID,
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
    const { screen } = await renderPage()
    await expect.element(screen.getByLabelText('内容')).toBeInTheDocument()
    await expect.poll(() => screen.container.querySelector('#step-output-66666666-6666-4666-8666-666666666666')).toBeNull()
    await screen.getByLabelText('引用上下文').click()
    await expect.element(screen.getByRole('option', { name: '尚未声明的键' })).toBeInTheDocument()
  })

  it('上移下移会改顺序', async () => {
    const second = {
      id: EXTRACT_ID,
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
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: /填写/ }).click()
    await screen.getByRole('button', { name: '上移' }).click()
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await vi.waitFor(() => expect(mocks.saveScenarioDraft).toHaveBeenCalled())
    expect(mocks.saveScenarioDraft.mock.calls[0]![1].document.steps.map((step: { type: string }) => step.type)).toEqual([
      'fill',
      'navigate',
    ])
  })

  it('选中步骤后添加会插入其后，连续提取默认输出不重名', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '添加步骤' }).click()
    await screen.getByRole('menuitem', { name: '提取', exact: true }).click()
    await expect.element(screen.getByText(/输出 extracted/)).toBeInTheDocument()
    await screen.getByRole('button', { name: '添加步骤' }).click()
    await screen.getByRole('menuitem', { name: '提取', exact: true }).click()
    await expect.element(screen.getByText(/输出 extracted2/)).toBeInTheDocument()
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await vi.waitFor(() => expect(mocks.saveScenarioDraft).toHaveBeenCalled())
    const steps = mocks.saveScenarioDraft.mock.calls[0]![1].document.steps as { type: string; outputKey?: string }[]
    expect(steps.map((step) => step.type)).toEqual(['navigate', 'extract', 'extract'])
    expect(steps.map((step) => step.outputKey)).toEqual([undefined, 'extracted', 'extracted2'])
  })

  it('新绑定候选不含后序输出，失效引用仍保留', async () => {
    const extract = {
      id: EXTRACT_ID,
      name: '提取单号',
      type: 'extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'extracted',
      input: { target: { framePath: [], candidates: [{ by: 'label' as const, value: '单号' }] }, as: 'text' as const },
    }
    const echo = {
      id: ECHO_ID,
      name: '回显',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { from: 'gone' },
    }
    const later = {
      id: LATER_ID,
      name: '后序提取',
      type: 'extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'later',
      input: { target: { framePath: [], candidates: [{ by: 'label' as const, value: '金额' }] }, as: 'text' as const },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: { schemaVersion: 1, inputs: [], steps: [extract, echo, later] },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [extract, echo, later],
      }),
    )
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: /回显/ }).click()
    await screen.getByLabelText('引用上下文').click()
    await expect.element(screen.getByRole('option', { name: '失效引用 · gone' })).toBeInTheDocument()
    await expect.element(screen.getByRole('option', { name: '步骤 · 提取单号' })).toBeInTheDocument()
    await expect.element(screen.getByRole('option', { name: '步骤 · 后序提取' })).not.toBeInTheDocument()
  })

  it('有静态对象形状时 echo 才出现 fromField', async () => {
    const extract = {
      id: EXTRACT_ID,
      name: 'AI 提取',
      type: 'ai_extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'extracted',
      input: {
        instruction: '提取订单字段',
        outputSchema: {
          kind: 'object' as const,
          fields: [{ name: 'orderNo', type: 'string' as const, required: true }],
        },
      },
    }
    const echo = {
      id: ECHO_ID,
      name: '回显字段',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { from: 'extracted', fromField: 'orderNo' },
    }
    mocks.fetchScenarioCapabilities.mockResolvedValue(openAiCapabilities)
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: { schemaVersion: 1, inputs: [], steps: [extract, echo] },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [extract, echo],
      }),
    )
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: /回显字段/ }).click()
    await expect.element(screen.getByLabelText('输出字段')).toBeInTheDocument()
    await screen.getByLabelText('输出字段').click()
    await expect.element(screen.getByRole('option', { name: /orderNo/ })).toBeInTheDocument()
  })

  it('后台 refetch 发现新 revision 时不覆盖本地修改', async () => {
    const { screen, client } = await renderPage()
    await screen.getByLabelText('页面地址').fill('https://shop.example.com/search')
    client.setQueryData(['scenarios', SCENARIO_ID], detail({
      draft: {
        revision: 2,
        document,
        updatedAt: '2026-09-13T03:00:00.000Z',
        updatedBy: { id: 'acc-2', displayName: '他人' },
      },
    }))
    await expect.element(screen.getByText('服务端草稿已更新。本地修改仍保留，确认后才重载。')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('页面地址')).toHaveValue('https://shop.example.com/search')
  })

  it('改类型先确认，删除列出消费方，撤销只回退结构操作', async () => {
    const extract = {
      id: EXTRACT_ID,
      name: '提取单号',
      type: 'extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'extracted',
      input: { target: { framePath: [], candidates: [{ by: 'label' as const, value: '单号' }] }, as: 'text' as const },
    }
    const echo = {
      id: ECHO_ID,
      name: '回显',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { from: 'extracted' },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: { schemaVersion: 1, inputs: [], steps: [extract, echo] },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [extract, echo],
      }),
    )
    const { screen } = await renderPage()
    await screen.getByRole('combobox', { name: '步骤 1 类型' }).click()
    await screen.getByRole('option', { name: '填写' }).click()
    await expect.element(screen.getByText('更换步骤类型？')).toBeInTheDocument()
    await screen.getByRole('button', { name: '取消' }).click()
    await expect.element(screen.getByText(/输出 extracted/)).toBeInTheDocument()

    await screen.getByRole('button', { name: '删除' }).click()
    await expect.element(screen.getByText(/后续 回显 引用了它的输出/)).toBeInTheDocument()
    await screen.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
    await expect.element(screen.getByRole('button', { name: /回显/ })).toBeInTheDocument()
    await screen.getByLabelText('步骤名称').fill('回显已改名')
    await screen.getByRole('button', { name: '撤销结构操作' }).click()
    await expect.element(screen.getByRole('button', { name: /提取单号/ })).toBeInTheDocument()
  })

  it('输入框内的 Alt 方向键不会重排', async () => {
    const second = {
      id: EXTRACT_ID,
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
    const { screen } = await renderPage()
    const url = screen.getByLabelText('页面地址')
    await url.click()
    const node = screen.container.querySelector('#studio-field-55555555-5555-4555-8555-555555555555-input-url')
    node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await expect.element(screen.getByRole('button', { name: '上移' })).toBeDisabled()
  })

  it('默认步骤库不出现可添加的 AI 类型', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '添加步骤' }).click()
    await expect.element(screen.getByRole('menuitem', { name: /AI 操作/ })).toBeDisabled()
    await expect.element(screen.getByRole('menuitem', { name: '导航' })).toBeEnabled()
  })

  it('缺 ai:execute 时仍可发布，文案与能力未开放不同', async () => {
    mocks.fetchScenarioCapabilities.mockResolvedValue(openAiCapabilities)
    const aiDoc = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [
        {
          id: AI_ID,
          name: 'AI 操作',
          type: 'ai_action' as const,
          effectType: 'SIDE_EFFECT' as const,
          input: { instruction: '点击查询' },
        },
      ],
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draftDirty: true,
        steps: aiDoc.steps,
        draft: {
          revision: 1,
          document: aiDoc,
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
      }),
    )
    const { screen } = await renderPage()
    await expect.element(screen.getByText(/缺少 AI 执行权限。仍可保存和发布/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '试跑' })).toBeDisabled()
    await expect.element(screen.getByRole('button', { name: '发布' })).toBeEnabled()
  })

  it('能力未开放的既有 AI 草稿不能试跑或发布', async () => {
    const aiDoc = {
      schemaVersion: 1 as const,
      inputs: [],
      steps: [
        {
          id: AI_ID,
          name: 'AI 操作',
          type: 'ai_action' as const,
          effectType: 'SIDE_EFFECT' as const,
          input: { instruction: '点击查询' },
        },
      ],
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draftDirty: true,
        steps: aiDoc.steps,
        draft: {
          revision: 1,
          document: aiDoc,
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
      }),
    )
    const { screen } = await renderPage()
    await expect.element(screen.getByText(/类型尚未开放/)).toBeInTheDocument()
    await expect.element(screen.getByText(/试跑不可用：先修复编译错误/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '发布' })).toBeDisabled()
  })

  it('发布冲突与保存冲突同一套处理', async () => {
    mocks.publishScenario.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'req-pub',
      }),
    )
    mocks.fetchScenario.mockResolvedValue(detail({ draftDirty: true }))
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '发布' }).click()
    await expect.element(screen.getByText(/他人已更新这份草稿/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument()
  })

  it('试跑成功后用 replace 写入 runId，不离开 Studio', async () => {
    mocks.trialScenario.mockResolvedValue(trialRun())
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '试跑' }).click()
    await screen.getByRole('button', { name: '开始试跑' }).click()
    await vi.waitFor(() => expect(mocks.trialScenario).toHaveBeenCalledTimes(1))
    expect(mocks.trialScenario.mock.calls[0]![1]).toMatchObject({
      revision: 1,
      idempotencyKey: expect.stringMatching(/^trial-/),
    })
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        replace: true,
        to: '/scenarios/$scenarioId',
        params: { scenarioId: SCENARIO_ID },
        search: { runId: RUN_ID },
      }),
    )
    await expect.element(screen.getByText('打开商城')).toBeInTheDocument()
  })

  it('试跑 409 保留草稿并提示重载', async () => {
    mocks.trialScenario.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'req-trial',
      }),
    )
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '试跑' }).click()
    await screen.getByRole('button', { name: '开始试跑' }).click()
    await expect.element(screen.getByText(/他人已更新这份草稿/)).toBeInTheDocument()
  })

  it('带 runId 时展示可折叠试跑摘要和最近获取时间', async () => {
    signIn(['workflow:read', 'workflow:write', 'run:execute', 'run:read', 'target:read'])
    router.search = { runId: RUN_ID }
    const { screen } = await renderPage()
    await expect.element(screen.getByRole('heading', { name: '试跑结果' })).toBeInTheDocument()
    await expect.element(screen.getByText(/最近获取/)).toBeInTheDocument()
    await expect.element(screen.getByText('试跑版本')).toBeInTheDocument()
    await expect.element(screen.getByText(/结果来自 Snapshot/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
    await expect.element(screen.getByText('打开完整运行详情')).toBeInTheDocument()
    await screen.getByRole('button', { name: '刷新' }).click()
    await vi.waitFor(() => expect(runMocks.fetchRun).toHaveBeenCalled())
  })

  it('工作区主列不会横向撑破容器', async () => {
    const { screen } = await renderPage()
    await expect.element(screen.getByText('打开商城')).toBeInTheDocument()
    const main = screen.container.querySelector('main')
    expect(main).toBeTruthy()
    expect(main!.scrollWidth).toBeLessThanOrEqual(main!.clientWidth + 1)
  })

  it('无 run:read 或不匹配的 Run 不影响草稿', async () => {
    router.search = { runId: RUN_ID }
    const { screen } = await renderPage()
    await expect.element(screen.getByText('没有运行读取权限，不能展示试跑结果。草稿不受影响。')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('页面地址')).toHaveValue('https://shop.example.com')
  })
})
