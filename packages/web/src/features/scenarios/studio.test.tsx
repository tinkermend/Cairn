import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  runPlacement,
  scenarioCapabilitiesFor,
  type RunDetailDto,
  type RunObservation,
  type ScenarioCapabilities,
  type ScenarioDetailDto,
  type TargetDto,
} from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import { ScenarioDetailPage } from './detail'

const SCENARIO_ID = '33333333-3333-4333-8333-333333333333'
const STEP_ID = '55555555-5555-4555-8555-555555555555'
const TARGET_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '77777777-7777-4777-8777-777777777777'
const EXTRACT_ID = '66666666-6666-4666-8666-666666666666'
const ECHO_ID = '88888888-8888-4888-8888-888888888888'
const AI_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RECORDING_DRAFT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const IMPORTED_STEP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const mocks = vi.hoisted(() => ({
  fetchScenarios: vi.fn(),
  fetchScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn(),
  saveScenarioDraft: vi.fn(),
  publishScenario: vi.fn(),
  trialScenario: vi.fn(),
  createRecordingBinding: vi.fn(),
  fetchRecordingImports: vi.fn(),
  previewRecordingImport: vi.fn(),
  applyRecordingImport: vi.fn(),
  updateScenario: vi.fn(),
  deleteScenario: vi.fn(),
  previewDeleteScenario: vi.fn(),
  fetchTarget: vi.fn(),
  fetchTargets: vi.fn(),
  fetchTargetAccounts: vi.fn(),
}))

const runMocks = vi.hoisted(() => ({
  fetchRunObservation: vi.fn(),
  subscribeRunEvents: vi.fn(),
  debugRun: vi.fn(),
  observeRun: vi.fn(),
  fetchManagedBrowser: vi.fn(),
  subscribeBrowserFrames: vi.fn(),
}))

const router = vi.hoisted(() => ({
  search: {
    runId: undefined as string | undefined,
    import: undefined as string | undefined,
  },
  navigate: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', async (original) => ({
  ...(await original<typeof import('@/lib/scenarios-api')>()),
  ...mocks,
}))
vi.mock('@/lib/extension-bridge', () => ({
  notifyExtensionStart: vi.fn(async () => null),
  configuredExtensionId: () => '',
}))
vi.mock('@/lib/recordings-api', () => ({
  closeRecordingBinding: vi.fn(async () => ({ id: 'bind-1' })),
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTarget: mocks.fetchTarget,
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))
vi.mock('@/lib/runs-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runs-api')>()),
  fetchRunObservation: runMocks.fetchRunObservation,
  subscribeRunEvents: runMocks.subscribeRunEvents,
  debugRun: runMocks.debugRun,
  observeRun: runMocks.observeRun,
  fetchManagedBrowser: runMocks.fetchManagedBrowser,
  subscribeBrowserFrames: runMocks.subscribeBrowserFrames,
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
    purpose: 'user',
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

const defaultCapabilities: ScenarioCapabilities = scenarioCapabilitiesFor({
  browserAiEnabled: false,
})

const openAiCapabilities: ScenarioCapabilities = scenarioCapabilitiesFor({
  browserAiEnabled: true,
})

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
    outcomeStatus: 'NOT_EVALUATED',
    lease: null,
    debugMode: 'runThrough',
    outcomeResults: [],
    placement: runPlacement({
      state: 'not_applicable',
      sessionId: null,
      ownerWorkerId: null,
      sessionStatus: null,
    }),
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

function trialObservation(run: RunDetailDto = trialRun()): RunObservation {
  return {
    run,
    evidence: { items: [] },
    eventSeq: 1,
    earliestEventSeq: 1,
  }
}

function hangSubscribe() {
  runMocks.subscribeRunEvents.mockImplementation(
    async (
      id: string,
      input: {
        signal: AbortSignal
        handlers: { onControl?: (control: { kind: string }) => void }
      }
    ) => {
      input.handlers.onControl?.({
        kind: 'ready',
        runId: id,
        eventSeq: 1,
        earliestEventSeq: 1,
        realtime: true,
      } as never)
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve()
          return
        }
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  )
}

function signIn(
  permissions = [
    'workflow:read',
    'workflow:write',
    'run:execute',
    'target:read',
  ]
) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const screen = await render(
    <QueryClientProvider client={client}>
      <ScenarioDetailPage />
    </QueryClientProvider>
  )
  return { screen, client }
}

describe('Scenario Studio', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    router.search = { runId: undefined, import: undefined }
    signIn()
    mocks.fetchScenario.mockResolvedValue(detail())
    mocks.fetchScenarioCapabilities.mockResolvedValue(defaultCapabilities)
    mocks.fetchRecordingImports.mockResolvedValue({
      bindings: [],
      drafts: [],
      receipts: [],
    })
    mocks.fetchTarget.mockResolvedValue(target)
    mocks.fetchTargets.mockResolvedValue({ items: [target] })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        {
          id: 'acc-1',
          targetId: TARGET_ID,
          displayName: '管理员',
          username: 'admin',
          hasPassword: true,
          status: 'active',
          createdAt: '2026-09-13T00:00:00.000Z',
          updatedAt: '2026-09-13T00:00:00.000Z',
        },
      ],
    })
    mocks.fetchScenarios.mockResolvedValue({ items: [detail()] })
    runMocks.fetchRunObservation.mockResolvedValue(trialObservation())
    runMocks.fetchManagedBrowser.mockResolvedValue({
      runId: RUN_ID,
      runStatus: 'QUEUED',
      sessionId: null,
      sessionGeneration: null,
      ownerWorkerId: null,
      framesAvailable: false,
      viewingOtherPage: false,
      currentPage: null,
      pages: [],
      authHold: null,
      authControl: null,
      capabilities: {
        screencast: 'open',
        authInput: 'open',
        popupHandoff: 'open',
        chineseInsertText: 'open',
      },
      degradedReason: null,
    })
    runMocks.subscribeBrowserFrames.mockResolvedValue(undefined)
    runMocks.observeRun.mockResolvedValue({
      outcome: 'FOUND',
      page: { url: 'https://shop.example.com' },
      diagnostics: { outcome: 'FOUND', candidatesTried: [] },
      source: 'managed',
    })
    hangSubscribe()
    mocks.saveScenarioDraft.mockImplementation(
      async (
        _id: string,
        body: { revision: number; document: typeof document }
      ) =>
        detail({
          draft: {
            revision: body.revision + 1,
            document: body.document,
            updatedAt: '2026-09-13T01:00:00.000Z',
            updatedBy: { id: 'acc-1', displayName: '测试' },
          },
          draftDirty: true,
        })
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
    await vi.waitFor(() =>
      expect(mocks.saveScenarioDraft).toHaveBeenCalledTimes(1)
    )
    expect(mocks.saveScenarioDraft.mock.calls[0]![1]).toMatchObject({
      revision: 1,
      document: {
        steps: [
          {
            type: 'navigate',
            input: { url: 'https://shop.example.com/search' },
          },
        ],
      },
    })
  })

  it('保存冲突时保留本地输入并提示重新加载', async () => {
    mocks.saveScenarioDraft.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'req-conflict',
      })
    )
    const { screen } = await renderPage()
    await screen
      .getByLabelText('页面地址')
      .fill('https://shop.example.com/search')
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await expect
      .element(screen.getByText(/他人已更新这份草稿/))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '重新加载' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('页面地址'))
      .toHaveValue('https://shop.example.com/search')
  })

  it('未选步骤时展示场景输入与全局诊断', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '查看场景输入与全局诊断' }).click()
    await expect
      .element(screen.getByRole('heading', { name: '输入与诊断' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('heading', { name: '场景输入' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('list', { name: '编译诊断' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('含浏览器步骤的场景没有成功条件'))
      .toBeInTheDocument()
  })

  it('未保存时试跑禁用而不是消失', async () => {
    const { screen } = await renderPage()
    await screen
      .getByLabelText('页面地址')
      .fill('https://shop.example.com/search')
    await expect
      .element(screen.getByRole('button', { name: '试跑' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: '保存草稿' }))
      .toBeEnabled()
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
              message:
                '步骤「读单号」的 from=orderId 不是已声明输入或更早步骤的 outputKey',
              stepId: STEP_ID,
            },
          ],
        },
      })
    )
    const { screen } = await renderPage()
    await expect.element(screen.getByText(/from=orderId/)).toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '试跑' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: '保存草稿' }))
      .toBeInTheDocument()
  })

  it('上移下移会改顺序', async () => {
    const second = {
      id: EXTRACT_ID,
      name: '填写',
      type: 'fill' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'label' as const, value: '关键字' }],
        },
        value: '订单',
      },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: {
            schemaVersion: 1,
            inputs: [],
            steps: [document.steps[0]!, second],
          },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [document.steps[0]!, second],
      })
    )
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: /填写/ }).click()
    await screen.getByRole('button', { name: '上移' }).click()
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await vi.waitFor(() => expect(mocks.saveScenarioDraft).toHaveBeenCalled())
    expect(
      mocks.saveScenarioDraft.mock.calls[0]![1].document.steps.map(
        (step: { type: string }) => step.type
      )
    ).toEqual(['fill', 'navigate'])
  })

  it('选中步骤后添加会插入其后，连续提取默认输出不重名', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '添加步骤' }).click()
    await screen.getByRole('menuitem', { name: '提取', exact: true }).click()
    await expect.element(screen.getByText(/输出 extracted/)).toBeInTheDocument()
    await screen.getByRole('button', { name: '添加步骤' }).click()
    await screen.getByRole('menuitem', { name: '提取', exact: true }).click()
    await expect
      .element(screen.getByText(/输出 extracted2/))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: '保存草稿' }).click()
    await vi.waitFor(() => expect(mocks.saveScenarioDraft).toHaveBeenCalled())
    const steps = mocks.saveScenarioDraft.mock.calls[0]![1].document.steps as {
      type: string
      outputKey?: string
    }[]
    expect(steps.map((step) => step.type)).toEqual([
      'navigate',
      'extract',
      'extract',
    ])
    expect(steps.map((step) => step.outputKey)).toEqual([
      undefined,
      'extracted',
      'extracted2',
    ])
  })

  it('后台 refetch 发现新 revision 时不覆盖本地修改', async () => {
    const { screen, client } = await renderPage()
    await screen
      .getByLabelText('页面地址')
      .fill('https://shop.example.com/search')
    client.setQueryData(
      ['scenarios', SCENARIO_ID],
      detail({
        draft: {
          revision: 2,
          document,
          updatedAt: '2026-09-13T03:00:00.000Z',
          updatedBy: { id: 'acc-2', displayName: '他人' },
        },
      })
    )
    await expect
      .element(
        screen.getByText('服务端草稿已更新。本地修改仍保留，确认后才重载。')
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('页面地址'))
      .toHaveValue('https://shop.example.com/search')
  })

  it('改类型先确认，删除列出消费方，撤销只回退结构操作', async () => {
    const extract = {
      id: EXTRACT_ID,
      name: '提取单号',
      type: 'extract' as const,
      effectType: 'READ_ONLY' as const,
      outputKey: 'extracted',
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'label' as const, value: '单号' }],
        },
        as: 'text' as const,
      },
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
      })
    )
    const { screen } = await renderPage()
    await screen.getByRole('combobox', { name: '步骤 1 类型' }).click()
    await screen.getByRole('option', { name: '填写' }).click()
    await expect.element(screen.getByText('更换步骤类型？')).toBeInTheDocument()
    await screen.getByRole('button', { name: '取消' }).click()
    await expect.element(screen.getByText(/输出 extracted/)).toBeInTheDocument()

    await screen.getByRole('button', { name: '删除' }).click()
    await expect
      .element(screen.getByText(/后续 回显 引用了它的输出/))
      .toBeInTheDocument()
    await screen
      .getByRole('alertdialog')
      .getByRole('button', { name: '删除' })
      .click()
    await expect
      .element(screen.getByRole('button', { name: /回显/ }))
      .toBeInTheDocument()
    await screen.getByLabelText('步骤名称').fill('回显已改名')
    await screen.getByRole('button', { name: '撤销结构操作' }).click()
    await expect
      .element(screen.getByRole('button', { name: /提取单号/ }))
      .toBeInTheDocument()
  })

  it('输入框内的 Alt 方向键不会重排', async () => {
    const second = {
      id: EXTRACT_ID,
      name: '填写',
      type: 'fill' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'label' as const, value: '关键字' }],
        },
        value: '订单',
      },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        draft: {
          revision: 1,
          document: {
            schemaVersion: 1,
            inputs: [],
            steps: [document.steps[0]!, second],
          },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [document.steps[0]!, second],
      })
    )
    const { screen } = await renderPage()
    const url = screen.getByLabelText('页面地址')
    await url.click()
    const node = screen.container.querySelector(
      '#studio-field-55555555-5555-4555-8555-555555555555-input-url'
    )
    node?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
      })
    )
    await expect
      .element(screen.getByRole('button', { name: '上移' }))
      .toBeDisabled()
  })

  it('步骤卡用成功条件而不是断言步', async () => {
    const { screen } = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '成功条件' }))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: '添加条件' }).click()
    await expect
      .element(screen.getByLabelText('成功条件 1 含义'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '从页面选择' }))
      .toBeInTheDocument()
    expect(screen.container.textContent).not.toMatch(/断言条件|确定性断言/)
    await screen.getByRole('combobox', { name: '步骤 1 类型' }).click()
    await expect
      .element(screen.getByRole('option', { name: '断言' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('option', { name: 'AI 判断' }))
      .not.toBeInTheDocument()
  })

  it('默认步骤库不出现可添加的 AI 类型', async () => {
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '添加步骤' }).click()
    await expect
      .element(screen.getByRole('menuitem', { name: /AI 操作/ }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('menuitem', { name: '导航' }))
      .toBeEnabled()
    await expect
      .element(screen.getByRole('menuitem', { name: '断言' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('menuitem', { name: /AI 判断/ }))
      .not.toBeInTheDocument()
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
      })
    )
    const { screen } = await renderPage()
    await expect
      .element(screen.getByText(/缺少 AI 执行权限。仍可保存和发布/))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '试跑' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: '发布' }))
      .toBeEnabled()
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
      })
    )
    const { screen } = await renderPage()
    await expect.element(screen.getByText(/类型尚未开放/)).toBeInTheDocument()
    await expect
      .element(screen.getByText(/试跑不可用：先修复编译错误/))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '发布' }))
      .toBeDisabled()
  })

  it('发布冲突与保存冲突同一套处理', async () => {
    mocks.publishScenario.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'req-pub',
      })
    )
    mocks.fetchScenario.mockResolvedValue(detail({ draftDirty: true }))
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '发布' }).click()
    await expect
      .element(screen.getByText(/他人已更新这份草稿/))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '重新加载' }))
      .toBeInTheDocument()
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
      })
    )
    await expect.element(screen.getByText('打开商城')).toBeInTheDocument()
  })

  it('试跑 409 保留草稿并提示重载', async () => {
    mocks.trialScenario.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'SCENARIO_DRAFT_CONFLICT',
        message: '草稿已被他人更新',
        requestId: 'req-trial',
      })
    )
    const { screen } = await renderPage()
    await screen.getByRole('button', { name: '试跑' }).click()
    await screen.getByRole('button', { name: '开始试跑' }).click()
    await expect
      .element(screen.getByText(/他人已更新这份草稿/))
      .toBeInTheDocument()
  })

  it('带 runId 时展示可折叠试跑摘要和最近获取时间', async () => {
    signIn([
      'workflow:read',
      'workflow:write',
      'run:execute',
      'run:read',
      'target:read',
    ])
    router.search = { runId: RUN_ID, import: undefined }
    const { screen } = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '试跑结果' }))
      .toBeInTheDocument()
    await expect.element(screen.getByText(/最近获取/)).toBeInTheDocument()
    await expect.element(screen.getByText('试跑版本')).toBeInTheDocument()
    await expect
      .element(screen.getByText(/结果来自 Snapshot/))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '刷新' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('打开完整运行详情'))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: '刷新' }).click()
    await vi.waitFor(() =>
      expect(runMocks.fetchRunObservation).toHaveBeenCalled()
    )
    await expect.element(screen.getByText('连接正常')).toBeInTheDocument()
  })

  it('试跑摘要展示无法安全续跑与新建完整试跑', async () => {
    signIn([
      'workflow:read',
      'workflow:write',
      'run:execute',
      'run:read',
      'target:read',
    ])
    router.search = { runId: RUN_ID, import: undefined }
    runMocks.fetchRunObservation.mockResolvedValue(
      trialObservation(
        trialRun({
          status: 'FAILED',
          authCheckpoint: {
            schemaVersion: 1,
            status: 'unrecoverable',
            closedAt: '2026-09-16T04:00:00.000Z',
            trigger: {
              kind: 'navigated_to_login',
              at: '2026-09-16T04:00:00.000Z',
              summary: '已跳到登录页',
            },
            nextStepId: document.steps[0]!.id,
            nextOrdinal: 0,
            interruptedClassification: 'not_dispatched',
            contextVersion: 'a'.repeat(64),
            contextKeys: [],
            sessionGeneration: 1,
            fencingToken: '1',
            recoveryRule: {
              reuse: 'NEW_PAGE',
              entryUrl: 'https://shop.example.com/',
              allowedOrigins: ['https://shop.example.com'],
            },
            capability: 'LOGIN_VERIFIED',
            autoRecoveriesUsed: 0,
            manualRecoveriesUsed: 0,
            unrecoverableCode: 'AUTH_CONTEXT_NOT_RECOVERABLE',
          },
        })
      )
    )
    const { screen } = await renderPage()
    await expect
      .element(screen.getByText('登录已失效，本次运行无法安全续跑'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('link', { name: '新建完整试跑' }))
      .toBeInTheDocument()
  })

  it('HOLDING 试跑展示再试与结束，不出现在正式 runThrough', async () => {
    signIn([
      'workflow:read',
      'workflow:write',
      'run:execute',
      'run:read',
      'target:read',
    ])
    router.search = { runId: RUN_ID, import: undefined }
    const stepId = document.steps[0]!.id
    runMocks.fetchRunObservation.mockResolvedValue(
      trialObservation(
        trialRun({
          status: 'HOLDING',
          debugMode: 'holdOnFailure',
          checkpoint: {
            mode: 'holdOnFailure',
            reason: 'step_failed',
            stepId,
            stepOrdinal: 0,
            contextKeys: [],
            sessionGeneration: 1,
            fencingToken: '1',
            overlayRevision: 0,
          },
          stepRuns: [
            {
              id: '00000000-0000-4000-8000-0000000000a1',
              stepId,
              name: '打开登录页',
              type: 'navigate',
              ordinal: 0,
              status: 'FAILED',
              outcomeStatus: 'NOT_EVALUATED',
              startedAt: '2026-09-13T02:00:01.000Z',
              finishedAt: '2026-09-13T02:00:02.000Z',
              attempts: [
                {
                  id: '00000000-0000-4000-8000-0000000000a2',
                  attemptNo: 1,
                  status: 'FAILED',
                  startedAt: '2026-09-13T02:00:01.000Z',
                  finishedAt: '2026-09-13T02:00:02.000Z',
                  output: null,
                  error: {
                    code: 'TARGET_NOT_FOUND',
                    category: 'EXECUTOR',
                    retryable: false,
                    safeMessage: '未找到',
                  },
                },
              ],
            },
          ],
        })
      )
    )
    const { screen } = await renderPage()
    await expect
      .element(screen.getByRole('button', { name: '再试这一步' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '结束会话' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('挂起', { exact: true }))
      .toBeInTheDocument()
  })

  it('HOLDING 写回草稿后丢掉该步临时覆盖', async () => {
    signIn([
      'workflow:read',
      'workflow:write',
      'run:execute',
      'run:read',
      'target:read',
      'session:view',
    ])
    router.search = { runId: RUN_ID, import: undefined }
    const clickStep = {
      id: STEP_ID,
      name: '点击查询',
      type: 'click' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'label' as const, value: '查询' }],
        },
      },
    }
    const clickDocument = { ...document, steps: [clickStep] }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        steps: [clickStep],
        draft: {
          revision: 1,
          document: clickDocument,
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        published: {
          versionId: '44444444-4444-4444-8444-444444444444',
          versionNo: 1,
          definition: clickDocument,
          compilerVersion: 1,
          createdAt: '2026-09-13T00:00:00.000Z',
        },
      })
    )
    runMocks.fetchRunObservation.mockResolvedValue(
      trialObservation(
        trialRun({
          status: 'HOLDING',
          debugMode: 'holdOnFailure',
          debugOverlay: {
            revision: 1,
            stepOverrides: {
              [STEP_ID]: {
                target: {
                  framePath: [],
                  candidates: [{ by: 'testId', value: 'btn-search' }],
                },
              },
            },
          },
          checkpoint: {
            mode: 'holdOnFailure',
            reason: 'step_failed',
            stepId: STEP_ID,
            stepOrdinal: 0,
            contextKeys: [],
            sessionGeneration: 1,
            fencingToken: '1',
            overlayRevision: 1,
          },
          snapshot: {
            schemaVersion: 1,
            runId: RUN_ID,
            targetId: TARGET_ID,
            scenarioId: SCENARIO_ID,
            scenarioVersionId: '44444444-4444-4444-8444-444444444444',
            steps: [clickStep],
            input: {},
            createdAt: '2026-09-13T02:00:00.000Z',
          },
          stepRuns: [
            {
              id: '00000000-0000-4000-8000-0000000000a1',
              stepId: STEP_ID,
              name: '点击按钮',
              type: 'click',
              ordinal: 0,
              status: 'FAILED',
              outcomeStatus: 'NOT_EVALUATED',
              startedAt: '2026-09-13T02:00:01.000Z',
              finishedAt: '2026-09-13T02:00:02.000Z',
              attempts: [
                {
                  id: '00000000-0000-4000-8000-0000000000a2',
                  attemptNo: 1,
                  status: 'FAILED',
                  startedAt: '2026-09-13T02:00:01.000Z',
                  finishedAt: '2026-09-13T02:00:02.000Z',
                  output: null,
                  error: {
                    code: 'TARGET_NOT_FOUND',
                    category: 'EXECUTOR',
                    retryable: false,
                    safeMessage: '未找到',
                  },
                },
              ],
            },
          ],
        })
      )
    )
    const { screen } = await renderPage()
    await expect
      .element(screen.getByText('正在使用临时覆盖目标，只影响本次再试。'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '恢复原始快照' }))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: '写回草稿' }).click()
    await vi.waitFor(() =>
      expect(mocks.saveScenarioDraft).toHaveBeenCalledTimes(1)
    )
    await vi.waitFor(() =>
      expect(runMocks.observeRun).toHaveBeenCalledWith(RUN_ID, {
        op: 'highlight',
        clearOverlayStepId: STEP_ID,
      })
    )
  })

  it('编写观察能力位关闭时不出现指认和校验', async () => {
    mocks.fetchScenarioCapabilities.mockResolvedValue(
      scenarioCapabilitiesFor({
        browserAiEnabled: false,
        authoring: {
          indicate: 'closed',
          highlight: 'closed',
          debugHold: 'open',
          assist: 'closed',
          stepTypesExtra: ['select', 'keyboard', 'wait'],
        },
      })
    )
    const clickStep = {
      id: STEP_ID,
      name: '点击查询',
      type: 'click' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: {
        target: {
          framePath: [],
          candidates: [{ by: 'label' as const, value: '查询' }],
        },
      },
    }
    mocks.fetchScenario.mockResolvedValue(
      detail({
        steps: [clickStep],
        draft: {
          revision: 1,
          document: { ...document, steps: [clickStep] },
          updatedAt: '2026-09-13T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
      })
    )
    const { screen } = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '点击查询' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '在页面上指认' }))
      .not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '校验高亮' }))
      .not.toBeInTheDocument()
  })

  it('工作区主列不会横向撑破容器', async () => {
    const { screen } = await renderPage()
    await expect.element(screen.getByText('打开商城')).toBeInTheDocument()
    const main = screen.container.querySelector('main')
    expect(main).toBeTruthy()
    expect(main!.scrollWidth).toBeLessThanOrEqual(main!.clientWidth + 1)
  })

  it('无 run:read 或不匹配的 Run 不影响草稿', async () => {
    router.search = { runId: RUN_ID, import: undefined }
    const { screen } = await renderPage()
    await expect
      .element(
        screen.getByText('没有运行读取权限，不能展示试跑结果。草稿不受影响。')
      )
      .toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('页面地址'))
      .toHaveValue('https://shop.example.com')
  })

  it('未保存时不能开始录制', async () => {
    const { screen } = await renderPage()
    await screen
      .getByLabelText('页面地址')
      .fill('https://shop.example.com/search')
    await screen.getByRole('button', { name: '录制步骤' }).click()
    expect(mocks.createRecordingBinding).not.toHaveBeenCalled()
  })

  it('import 参数打开预览并回填到当前草稿', async () => {
    router.search = { runId: undefined, import: RECORDING_DRAFT_ID }
    mocks.previewRecordingImport.mockResolvedValue({
      recordingDraftId: RECORDING_DRAFT_ID,
      recordingName: '录制 shop.example.com',
      normalizerVersion: 'recording-normalizer@2',
      sourceVersion: 'playwright-crx@0.15.0',
      sourceDigest: 'a'.repeat(64),
      eventCount: 1,
      remainingStepCapacity: 31,
      currentRevision: 1,
      insertAnchor: { kind: 'start' },
      items: [
        {
          index: 0,
          sourceIndexes: [0],
          status: 'mapped',
          sourceAction: 'navigate',
          name: '打开 shop.example.com/orders',
          candidateStepType: 'navigate',
          input: { url: 'https://shop.example.com/orders' },
          diagnostics: [],
          ready: true,
          candidateStep: {
            id: '00000000-0000-4000-8000-000000000000',
            name: '打开 shop.example.com/orders',
            type: 'navigate',
            effectType: 'SIDE_EFFECT',
            input: { url: 'https://shop.example.com/orders' },
          },
        },
      ],
      diagnostics: [],
    })
    const imported = {
      id: IMPORTED_STEP_ID,
      name: '打开 shop.example.com/orders',
      type: 'navigate' as const,
      effectType: 'SIDE_EFFECT' as const,
      input: { url: 'https://shop.example.com/orders' },
    }
    mocks.applyRecordingImport.mockResolvedValue({
      receipt: {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        scenarioId: SCENARIO_ID,
        recordingDraftId: RECORDING_DRAFT_ID,
        sourceDigest: 'a'.repeat(64),
        normalizerVersion: 'recording-normalizer@2',
        baseRevision: 1,
        newRevision: 2,
        insertedStepIds: [IMPORTED_STEP_ID],
        sourceMap: [
          {
            sourceIndexes: [0],
            stepId: IMPORTED_STEP_ID,
            disposition: 'accept',
          },
        ],
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      scenario: detail({
        draftDirty: true,
        draft: {
          revision: 2,
          document: {
            schemaVersion: 1,
            inputs: [],
            steps: [document.steps[0]!, imported],
          },
          updatedAt: '2026-09-14T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
        steps: [document.steps[0]!, imported],
      }),
    })
    const { screen } = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '录制回填预览' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('打开 shop.example.com/orders'))
      .toBeInTheDocument()
    await screen.getByRole('button', { name: '回填 1 项' }).click()
    await vi.waitFor(() =>
      expect(mocks.applyRecordingImport).toHaveBeenCalledTimes(1)
    )
    expect(mocks.applyRecordingImport.mock.calls[0]![1]).toMatchObject({
      recordingDraftId: RECORDING_DRAFT_ID,
      baseRevision: 1,
      dispositions: [{ sourceIndexes: [0], disposition: 'accept' }],
    })
    await expect.element(screen.getByText('刚导入')).toBeInTheDocument()
  })

  it('录制判定默认不确认为成功条件', async () => {
    router.search = { runId: undefined, import: RECORDING_DRAFT_ID }
    mocks.previewRecordingImport.mockResolvedValue({
      recordingDraftId: RECORDING_DRAFT_ID,
      recordingName: '录制 shop.example.com',
      normalizerVersion: 'recording-normalizer@2',
      sourceVersion: 'playwright-crx@0.15.0',
      sourceDigest: 'b'.repeat(64),
      eventCount: 2,
      remainingStepCapacity: 30,
      currentRevision: 1,
      insertAnchor: { kind: 'start' },
      items: [
        {
          index: 0,
          sourceIndexes: [0],
          status: 'mapped',
          sourceAction: 'navigate',
          name: '打开 shop.example.com/orders',
          candidateStepType: 'navigate',
          input: { url: 'https://shop.example.com/orders' },
          diagnostics: [],
          ready: true,
          candidateStep: {
            id: '00000000-0000-4000-8000-000000000000',
            name: '打开 shop.example.com/orders',
            type: 'navigate',
            effectType: 'SIDE_EFFECT',
            input: { url: 'https://shop.example.com/orders' },
          },
        },
        {
          index: 1,
          sourceIndexes: [1],
          status: 'mapped',
          sourceAction: 'assertVisible',
          name: '断言可见',
          candidateStepType: 'assert',
          input: { expect: { kind: 'visible' } },
          diagnostics: [],
          ready: true,
          outcomeCandidate: {
            meaning: '对象可见',
            scope: 'step',
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'recorded',
            expect: { kind: 'visible' },
            reasons: [],
          },
          candidateStep: {
            id: '00000000-0000-4000-8000-000000000001',
            name: '断言可见',
            type: 'assert',
            effectType: 'READ_ONLY',
            input: { expect: { kind: 'visible' } },
          },
        },
      ],
      diagnostics: [],
    })
    mocks.applyRecordingImport.mockResolvedValue({
      receipt: {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        scenarioId: SCENARIO_ID,
        recordingDraftId: RECORDING_DRAFT_ID,
        sourceDigest: 'b'.repeat(64),
        normalizerVersion: 'recording-normalizer@2',
        baseRevision: 1,
        newRevision: 2,
        insertedStepIds: [IMPORTED_STEP_ID],
        sourceMap: [
          { sourceIndexes: [0], stepId: IMPORTED_STEP_ID, disposition: 'accept' },
          { sourceIndexes: [1], disposition: 'discard', reason: '未确认为成功条件' },
        ],
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      scenario: detail({
        draftDirty: true,
        draft: {
          revision: 2,
          document,
          updatedAt: '2026-09-14T00:00:00.000Z',
          updatedBy: { id: 'acc-1', displayName: '测试' },
        },
      }),
    })
    const { screen } = await renderPage()
    await expect.element(screen.getByText('成功条件候选', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '确认为成功条件' })).toBeInTheDocument()
    await screen.getByRole('button', { name: '回填 1 项' }).click()
    await vi.waitFor(() => expect(mocks.applyRecordingImport).toHaveBeenCalledTimes(1))
    expect(mocks.applyRecordingImport.mock.calls[0]![1].dispositions).toEqual([
      { sourceIndexes: [0], disposition: 'accept' },
      { sourceIndexes: [1], disposition: 'discard', reason: '未确认为成功条件' },
    ])
  })
})
