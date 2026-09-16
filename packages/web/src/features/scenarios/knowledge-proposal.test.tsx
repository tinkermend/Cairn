import type { ComponentProps } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { RUNTIME_SCHEMA_VERSION, type AuthoringProposal } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import { KnowledgeProposal } from './knowledge-proposal'

const mocks = vi.hoisted(() => ({
  createKnowledgeProposal: vi.fn(),
  acceptKnowledgeProposal: vi.fn(),
  rejectKnowledgeProposal: vi.fn(),
  fetchKnowledgeProposal: vi.fn(),
}))

vi.mock('@/lib/knowledge-api', () => mocks)

const document = {
  schemaVersion: RUNTIME_SCHEMA_VERSION,
  inputs: [],
  steps: [
    {
      id: 'ffffffff-ffff-4fff-8fff-fffffffffff1',
      name: '基线',
      type: 'echo' as const,
      effectType: 'READ_ONLY' as const,
      input: { value: '基线' },
    },
  ],
}

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: ['ai:assist', 'workflow:write', 'map:read', 'target:read'],
  })
}

async function renderCard(
  overrides: Partial<ComponentProps<typeof KnowledgeProposal>> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <KnowledgeProposal
        scenarioId='11111111-1111-4111-8111-111111111111'
        draftRevision={1}
        document={document}
        onAccepted={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>
  )
}

let fixture: AuthoringProposal

describe('知识建议', () => {
  beforeEach(async () => {
    await page.viewport(390, 844)
    signIn()
    vi.resetAllMocks()
    fixture = {
      proposalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      targetId: '11111111-1111-4111-8111-111111111111',
      scenarioId: '11111111-1111-4111-8111-111111111111',
      proposalStatus: 'needs_input',
      question: '按订单号查询状态',
      baseline: {
        draftRevision: 1,
        documentDigest: 'a'.repeat(64),
        selectedTermRevisions: [],
        selectedModuleVersionIds: [],
        platformAiConfigRevision: 0,
      },
      diffs: [],
      diagnostics: [
        {
          code: 'KNOWLEDGE_ALIAS_AMBIGUOUS',
          message: '同一别名对应多个术语，请先选定 termId。',
        },
      ],
      sources: [],
      unknowns: [],
      termCandidates: [
        {
          termId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          revision: 1,
          canonicalName: '销售订单',
          aliases: ['订单'],
          meaning: '前台',
        },
        {
          termId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          revision: 1,
          canonicalName: '采购订单',
          aliases: ['订单'],
          meaning: '采购',
        },
      ],
      suggestedModules: [],
      suggestedBindings: [],
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    }
    mocks.createKnowledgeProposal.mockResolvedValue(fixture)
  })

  it('OME04/12 歧义术语要求选择，错误后保留输入', async () => {
    const screen = await renderCard()
    await expect.element(screen.getByLabelText('知识建议需求')).toBeVisible()
    await screen.getByRole('button', { name: '生成知识建议' }).click()
    await expect
      .element(screen.getByRole('button', { name: '销售订单' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '采购订单' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '接受到草稿' }))
      .toBeDisabled()
    await expect
      .element(screen.getByLabelText('知识建议需求'))
      .toHaveValue('根据已有知识按订单号查询状态')
    await screen.getByRole('button', { name: '销售订单' }).click()
    expect(mocks.createKnowledgeProposal).toHaveBeenLastCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        selectedTermIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'],
      })
    )
  })
  it('完整展示复制步骤和来源，显式接受只写回返回的草稿', async () => {
    await page.viewport(1440, 1000)
    const onAccepted = vi.fn()
    const next = {
      ...document,
      steps: [
        ...document.steps,
        {
          ...document.steps[0]!,
          id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
          name: '核对订单状态与业务拒绝原因',
          input: { value: '中文长参数：仅查询当前订单，不提交修改' },
        },
      ],
    }
    fixture = {
      ...fixture,
      proposalStatus: 'proposed',
      diagnostics: [{ code: 'KNOWLEDGE_CONDITION_UNKNOWN', message: '尚无可执行的业务结果判据，接受后仍需补充。' }],
      unknowns: ['resultCriterion'],
      document: next,
      termCandidates: [],
      diffs: [{ fieldPath: ['steps', '1'], to: next.steps[1] }],
      sources: [
        {
          kind: 'module_version',
          moduleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          moduleVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          contentDigest: 'b'.repeat(64),
        },
      ],
    }
    mocks.createKnowledgeProposal.mockResolvedValue(fixture)
    mocks.acceptKnowledgeProposal.mockResolvedValue({
      proposal: { ...fixture, proposalStatus: 'accepted' },
      draftRevision: 2,
    })
    const screen = await renderCard({ onAccepted })
    await screen.getByRole('button', { name: '生成知识建议' }).click()
    await expect.element(screen.getByText('接受后的步骤（2 步）')).toBeVisible()
    await expect
      .element(
        screen.getByText('核对订单状态与业务拒绝原因 · echo · READ_ONLY', {
          exact: true,
        })
      )
      .toBeVisible()
    await screen.getByText('查看 1 处具体变更').click()
    await screen.getByText('做法版本', { exact: true }).click()
    await expect
      .element(screen.getByRole('link', { name: '查看做法与版本' }))
      .toBeVisible()
    await page.screenshot({
      path: '../../../../../.run/ome-review/proposal-desktop.png',
    })
    await screen.getByRole('button', { name: '接受到草稿' }).click()
    expect(onAccepted).toHaveBeenCalledWith(2, next)
    expect(mocks.acceptKnowledgeProposal).toHaveBeenCalledTimes(1)
  })

  it('多个做法可以选定版本，窄屏错误后保留需求与建议', async () => {
    fixture = {
      ...fixture,
      diagnostics: [
        {
          code: 'KNOWLEDGE_MODULE_AMBIGUOUS',
          message: '多个已发布做法匹配，请先选定模块版本。',
        },
      ],
      termCandidates: [],
      suggestedModules: [
        {
          moduleVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
          name: '查询销售订单',
          moduleId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
          contentDigest: 'a'.repeat(64),
          manualRequirement: false,
        },
        {
          moduleVersionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
          name: '查询采购订单',
          moduleId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
          contentDigest: 'b'.repeat(64),
          manualRequirement: false,
        },
      ],
    }
    mocks.createKnowledgeProposal.mockResolvedValue(fixture)
    const screen = await renderCard()
    await screen.getByRole('button', { name: '生成知识建议' }).click()
    await screen.getByRole('button', { name: '查询采购订单' }).click()
    expect(mocks.createKnowledgeProposal).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        selectedModuleVersionIds: ['cccccccc-cccc-4ccc-8ccc-ccccccccccc1'],
      })
    )
    await page.screenshot({
      path: '../../../../../.run/ome-review/proposal-mobile.png',
    })
  })

  it('未保存草稿不能生成或接受；已有建议仍能查看', async () => {
    const screen = await renderCard({ disabled: true })
    await expect
      .element(screen.getByRole('button', { name: '生成知识建议' }))
      .toBeDisabled()
    await expect
      .element(screen.getByRole('button', { name: '接受到草稿' }))
      .toBeDisabled()
    expect(mocks.createKnowledgeProposal).not.toHaveBeenCalled()
  })

  it('接受遇到 OCC 冲突后显示过期并保留具体变更', async () => {
    fixture = {
      ...fixture,
      proposalStatus: 'proposed',
      document,
      termCandidates: [],
      diffs: [{ fieldPath: ['steps', '0'], to: document.steps[0] }],
    }
    mocks.createKnowledgeProposal.mockResolvedValue(fixture)
    mocks.acceptKnowledgeProposal.mockRejectedValue(
      new ApiRequestError(409, {
        code: 'AUTHORING_PROPOSAL_STALE',
        message: '草稿已变化',
        requestId: 'request',
      })
    )
    const screen = await renderCard()
    await screen.getByRole('button', { name: '生成知识建议' }).click()
    await screen.getByRole('button', { name: '接受到草稿' }).click()
    await expect.element(screen.getByText('状态：已过期')).toBeVisible()
    await expect.element(screen.getByText('查看 1 处具体变更')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '接受到草稿' }))
      .toBeDisabled()
  })
})
