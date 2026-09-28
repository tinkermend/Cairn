import type { ReactNode } from 'react'
import type { TargetDescriptor, TargetObservation } from '@cairn/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { withPickedSemantic, TargetFields } from './target'
import { AuthoringObserveProvider, useAuthoringObserve } from '../observe'
import { createBlankStep } from '../step-registry'
import { fetchScenarioCapabilities } from '@/lib/scenarios-api'
import { observeSession } from '@/lib/sessions-api'

vi.mock('@/lib/sessions-api', () => ({
  observeSession: vi.fn(async () => ({
    outcome: 'NOT_FOUND',
    page: { url: 'https://shop.example' },
    diagnostics: { outcome: 'NOT_FOUND', candidatesTried: [] },
    source: 'managed',
  })),
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarioCapabilities: vi.fn(async () => ({
    executableStepTypes: ['click'],
    unavailableReasons: [],
    defaults: {
      browserAiEnabled: false,
      execution: { defaultTimeoutMs: 30_000, defaultRetryLimit: 0 },
    },
    authoringSchemaVersions: [1, 2],
    actionModules: true,
    resolution: {
      ceiling: 'deterministic_only',
      default: 'prefer_deterministic',
      aiRungAvailable: false,
      reasons: [{ code: 'AI_DISABLED', message: '浏览器仿真 AI 未启用' }],
      waitKindsAvailable: ['time', 'visible', 'hidden', 'url', 'text'],
    },
  })),
}))

function harness(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={client}>
      <AuthoringObserveProvider enabled={false} onApplyTarget={() => undefined}>
        {ui}
      </AuthoringObserveProvider>
    </QueryClientProvider>
  )
}

describe('TargetFields', () => {
  it('点选结果在语义为空时按候选预填描述', () => {
    expect(
      withPickedSemantic({
        framePath: [],
        candidates: [{ by: 'role', value: 'button', name: '查询' }],
      }).semantic,
    ).toBe('名为「查询」的按钮')
  })

  it('已保存的目标描述在输入框里也不带图标字体', async () => {
    const screen = await render(
      harness(
        <TargetFields
          target={{
            framePath: [],
            semantic: '名为「\uEAF3 配置管理 \uE6DF」的菜单项',
            candidates: [{ by: 'role', value: 'menuitem', name: '\uEAF3 配置管理 \uE6DF' }],
          }}
          onChange={vi.fn()}
        />,
      ),
    )
    await expect.element(screen.getByLabelText('要找的页面元素')).toHaveValue('名为「配置管理」的菜单项')
    await screen.unmount()
  })

  it('已有语义里的图标字体私用区会被清掉', () => {
    expect(
      withPickedSemantic({
        framePath: [],
        semantic: '名为「\uEAF3 配置管理 \uE6DF」的菜单项',
        candidates: [{ by: 'role', value: 'menuitem', name: '\uEAF3 配置管理 \uE6DF' }],
      }).semantic,
    ).toBe('名为「配置管理」的菜单项')
  })

  it('新建等待默认是元素可见而不是固定时间', () => {
    const step = createBlankStep('wait')
    expect(step.type).toBe('wait')
    expect(step.type === 'wait' && step.input.kind).toBe('visible')
  })

  it('解析方式只在摘要卡里出现一次；目标为空时不显示', async () => {
    const empty = await render(
      harness(<TargetFields target={{ framePath: [], candidates: [] }} onChange={vi.fn()} />),
    )
    await expect.element(empty.getByLabelText('要找的页面元素')).toBeInTheDocument()
    await expect.element(empty.getByText('规则', { exact: true })).not.toBeInTheDocument()
    await empty.unmount()

    const filled = await render(
      harness(
        <TargetFields
          target={{ framePath: [], semantic: '查询按钮', candidates: [{ by: 'label', value: '查询' }] }}
          onChange={vi.fn()}
        />,
      ),
    )
    // getByText 命中多个元素会直接报错，所以这一句同时断言了「只出现一次」
    await expect.element(filled.getByText('规则', { exact: true })).toBeInTheDocument()
  })

  it('允许 AI 兜底但 AI 未开放时，「不可用」提示跟着摘要卡的徽标走', async () => {
    const capabilities = vi.mocked(fetchScenarioCapabilities)
    const original = capabilities.getMockImplementation()!
    capabilities.mockImplementation(async (...args) => {
      const base = await original(...args)
      return { ...base, resolution: { ...base.resolution!, ceiling: 'prefer_ai' as const } }
    })
    try {
      const screen = await render(
        harness(
          <TargetFields
            target={{ framePath: [], semantic: '查询按钮', candidates: [{ by: 'label', value: '查询' }] }}
            onChange={vi.fn()}
          />,
        ),
      )
      await expect.element(screen.getByText('规则 · AI 兜底')).toBeInTheDocument()
      await expect.element(screen.getByText('当前未开放 AI 解析')).toBeInTheDocument()
    } finally {
      capabilities.mockImplementation(original)
    }
  })

  it('主字段是语义描述，候选默认折叠', async () => {
    const onChange = vi.fn()
    const screen = await render(
      harness(
        <TargetFields
          target={{ framePath: [], candidates: [{ by: 'label', value: '查询' }] }}
          onChange={onChange}
        />,
      ),
    )
    await expect.element(screen.getByLabelText('要找的页面元素')).toBeInTheDocument()
    await expect.element(screen.getByText('规则', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '高级：规则候选、锚点与定位顺序' })).toBeInTheDocument()
    await expect.element(screen.getByLabelText('定位值 1')).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '高级：规则候选、锚点与定位顺序' }).click()
    await expect.element(screen.getByLabelText('定位值 1')).toBeInTheDocument()
  })

  it('已连接会话时「在页面上指认」进入点选而不是只校验高亮', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          sessionId='01a0c2ad-c1d0-77df-b50b-aa247c7f28f2'
          enabled
          authoring={{
            indicate: 'open',
            highlight: 'open',
            debugHold: 'open',
            assist: 'closed',
            stepTypesExtra: [],
          }}
          onApplyTarget={() => undefined}
        >
          <TargetFields target={{ framePath: [], candidates: [] }} onChange={vi.fn()} />
        </AuthoringObserveProvider>
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '在页面上指认' }).click()
    await vi.waitFor(() =>
      expect(observeSession).toHaveBeenCalledWith('01a0c2ad-c1d0-77df-b50b-aa247c7f28f2', {
        op: 'highlight',
      }),
    )
    await expect.element(screen.getByRole('button', { name: '在画面上点选…' })).toBeInTheDocument()
  })

  it('多处匹配把读到的内容做成可写入的选择', async () => {
    const onApplyTarget = vi.fn()
    vi.mocked(observeSession).mockResolvedValueOnce({
      outcome: 'AMBIGUOUS',
      target: { framePath: [], candidates: [{ by: 'css', value: 'span.text-nowrap' }] },
      page: { url: 'https://ops.example/panel' },
      preview: { text: '25%' },
      diagnostics: { outcome: 'AMBIGUOUS', candidatesTried: [] },
      source: 'managed',
      alternatives: [
        { index: 0, reason: '匹配 2 个：25%', label: '25%' },
        { index: 1, reason: '匹配 60 个：db2', label: 'db2' },
      ],
    })
    function PickOnce() {
      const observe = useAuthoringObserve()
      return (
        <button type='button' onClick={() => observe.pickAt(10, 20)}>
          模拟点选
        </button>
      )
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          sessionId='01a0c2ad-c1d0-77df-b50b-aa247c7f28f2'
          enabled
          authoring={{
            indicate: 'open',
            highlight: 'open',
            debugHold: 'open',
            assist: 'closed',
            stepTypesExtra: [],
          }}
          onApplyTarget={onApplyTarget}
        >
          <TargetFields target={{ framePath: [], candidates: [] }} onChange={vi.fn()} />
          <PickOnce />
        </AuthoringObserveProvider>
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '模拟点选' }).click()
    await expect.element(screen.getByText(/画面上读到「25%」/)).toBeInTheDocument()
    await screen.getByRole('button', { name: 'db2' }).click()
    await vi.waitFor(() =>
      expect(onApplyTarget).toHaveBeenCalledWith(
        {
          framePath: [],
          candidates: [{ by: 'text', value: 'db2' }],
          semantic: 'db2',
        },
        { previewText: 'db2' },
      ),
    )
    expect(screen.container.textContent).not.toMatch(/将要点：/)
  })

  it('点选唯一命中后对账可见字与将要点，不拿 testId 充数', async () => {
    const onChange = vi.fn()
    const found: TargetObservation = {
      outcome: 'FOUND',
      target: {
        framePath: [],
        candidates: [
          { by: 'testId', value: 'menu-db' },
          { by: 'role', value: 'button', name: '数据库服务' },
        ],
      },
      page: { url: 'https://ops.example/' },
      preview: { text: '数据库' },
      diagnostics: {
        outcome: 'FOUND' as const,
        candidatesTried: [
          { index: 0, by: 'testId', value: 'menu-db', matches: 0 },
          { index: 1, by: 'role', value: 'button', matches: 1 },
        ],
      },
      source: 'managed' as const,
    }
    vi.mocked(observeSession).mockResolvedValue(found)
    function PickOnce() {
      const observe = useAuthoringObserve()
      return (
        <button type='button' onClick={() => observe.pickAt(10, 20)}>
          模拟点选
        </button>
      )
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          sessionId='01a0c2ad-c1d0-77df-b50b-aa247c7f28f2'
          enabled
          authoring={{
            indicate: 'open',
            highlight: 'open',
            debugHold: 'open',
            assist: 'closed',
            stepTypesExtra: [],
          }}
          onApplyTarget={vi.fn()}
        >
          <TargetFields
            target={{
              framePath: [],
              candidates: [{ by: 'role', value: 'button', name: '数据库服务' }],
            }}
            onChange={onChange}
          />
          <PickOnce />
        </AuthoringObserveProvider>
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '模拟点选' }).click()
    await expect.element(screen.getByText(/将要点：角色 button「数据库服务」/)).toBeInTheDocument()
    await expect.element(screen.getByText(/画面上读到：「数据库」/)).toBeInTheDocument()
    await expect.element(screen.getByText(/和画面上的字不一样/)).toBeInTheDocument()
    expect(screen.container.textContent).not.toMatch(/测试ID "menu-db"/)
    await expect.element(screen.getByRole('button', { name: '改用画面上的字' })).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(observeSession).toHaveBeenCalledWith('01a0c2ad-c1d0-77df-b50b-aa247c7f28f2', {
        op: 'highlight',
        target: found.target,
      }),
    )
  })

  it('改用画面上的字后多处匹配会回滚原来的定位', async () => {
    const onChange = vi.fn()
    vi.mocked(observeSession).mockClear()
    const original: TargetDescriptor = {
      framePath: [],
      candidates: [{ by: 'role', value: 'button', name: '数据库服务' }],
    }
    const found: TargetObservation = {
      outcome: 'FOUND',
      target: original,
      page: { url: 'https://ops.example/' },
      preview: { text: '数据库' },
      diagnostics: {
        outcome: 'FOUND',
        candidatesTried: [{ index: 0, by: 'role', value: 'button', matches: 1 }],
      },
      source: 'managed',
    }
    vi.mocked(observeSession)
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce({
        outcome: 'AMBIGUOUS',
        target: { framePath: [], candidates: [{ by: 'text', value: '数据库' }] },
        page: { url: 'https://ops.example/' },
        preview: { text: '数据库' },
        diagnostics: { outcome: 'AMBIGUOUS', candidatesTried: [] },
        source: 'managed',
        alternatives: [{ index: 0, reason: '匹配 2 个：数据库', label: '数据库' }],
      })
    function PickOnce() {
      const observe = useAuthoringObserve()
      return (
        <button type='button' onClick={() => observe.pickAt(10, 20)}>
          模拟点选
        </button>
      )
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <AuthoringObserveProvider
          sessionId='01a0c2ad-c1d0-77df-b50b-aa247c7f28f2'
          enabled
          authoring={{
            indicate: 'open',
            highlight: 'open',
            debugHold: 'open',
            assist: 'closed',
            stepTypesExtra: [],
          }}
          onApplyTarget={vi.fn()}
        >
          <TargetFields target={original} onChange={onChange} />
          <PickOnce />
        </AuthoringObserveProvider>
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '模拟点选' }).click()
    await expect.element(screen.getByRole('button', { name: '改用画面上的字' })).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(observeSession).toHaveBeenCalledWith('01a0c2ad-c1d0-77df-b50b-aa247c7f28f2', {
        op: 'highlight',
        target: original,
      }),
    )
    await screen.getByRole('button', { name: '改用画面上的字' }).click()
    await vi.waitFor(() => {
      expect(onChange.mock.calls.some((call) => call[0]?.candidates?.[0]?.by === 'text')).toBe(true)
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]
      expect(lastCall?.[0]).toEqual(original)
    })
  })

  it('标题后呈现小问号图标，默认隐藏长段说明，hover 时通过气泡提示展示说明', async () => {
    const screen = await render(
      harness(
        <TargetFields
          target={{ framePath: [], candidates: [{ by: 'label', value: '提交' }] }}
          onChange={vi.fn()}
        />,
      ),
    )
    // 静态说明不再直接占用垂直空间
    expect(screen.container.textContent).not.toMatch(/描述页面元素，不写点击或填写动作/)

    // 问号按钮存在
    const helpBtn = screen.getByRole('button', { name: '查看说明' })
    await expect.element(helpBtn).toBeInTheDocument()

    // 悬停后展示说明
    await helpBtn.hover()
    await expect
      .element(screen.getByText(/描述页面元素，不写点击或填写动作/))
      .toBeInTheDocument()
  })
})
