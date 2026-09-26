import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ExplorationCard } from './exploration'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchExplorationPolicy: vi.fn(),
  updateExplorationPolicy: vi.fn(),
  fetchMapSafeEntries: vi.fn(),
  createMapSafeEntry: vi.fn(),
  previewExploration: vi.fn(),
  createExploration: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  fetchPlatformConfig: vi.fn(),
  fetchExploreCandidates: vi.fn(),
  reviewExploreCandidate: vi.fn(),
  runExploreCandidate: vi.fn(),
  reviewUnknownExploreJob: vi.fn(),
  fetchMapJob: vi.fn(),
}))

vi.mock('@/lib/map-api', () => mocks)
vi.mock('@/lib/targets-api', () => ({ fetchTargetAccounts: mocks.fetchTargetAccounts }))
vi.mock('@/lib/platform-config-api', () => ({ fetchPlatformConfig: mocks.fetchPlatformConfig }))

function signIn(
  permissions = ['target:read', 'map:read', 'map:explore', 'map:maintain'],
) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const screen = await render(
    <QueryClientProvider client={client}>
      <ExplorationCard targetId={TARGET_ID} />
    </QueryClientProvider>,
  )
  return screen
}

describe('有界探索卡片', () => {
  beforeEach(() => {
    mocks.fetchPlatformConfig.mockResolvedValue({
      revision: 1,
      document: { mapExplorationEnabled: false },
      updatedAt: '2026-09-16T00:00:00.000Z',
    })
    mocks.fetchExplorationPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        exploreEnabled: false,
        mode: 'allowlist',
        modelEnabled: false,
        maxHopDepth: 1,
        maxNewPages: 1,
        maxCandidates: 8,
        maxActions: 1,
        maxSeconds: 300,
        sliceWorkSeconds: 20,
        allowlist: [],
        seedRefs: [],
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.fetchMapSafeEntries.mockResolvedValue({ items: [] })
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    mocks.fetchExploreCandidates.mockResolvedValue({ items: [], totalGaps: 0 })
    mocks.fetchMapJob.mockResolvedValue({ jobId: 'j1', jobStatus: 'queued' })
    signIn()
  })

  it('默认显示关闭，不提供开始探索', async () => {
    await renderCard()
    await expect.element(page.getByText('有界探索')).toBeVisible()
    await expect.element(page.getByText(/平台关闭/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: '开始探索' })).toBeDisabled()
  })

  it('没有探索权限时只读提示', async () => {
    signIn(['target:read', 'map:read'])
    await renderCard()
    await expect.element(page.getByText('需要探索和维护权限才能触发探索。')).toBeVisible()
  })

  it('显示候选控件与审核试跑动作', async () => {
    mocks.fetchExploreCandidates.mockResolvedValue({
      items: [
        {
          id: 'c1',
          targetId: TARGET_ID,
          jobId: 'j1',
          runId: 'r1',
          sourcePresentationStateKey: 'pres-1',
          controlFingerprint: 'fp-1',
          accessibleName: '用户管理',
          role: 'link',
          ancestorPathJson: ['div', 'nav'],
          frameSelector: null,
          candidateCategory: 'explicit_url',
          targetUrl: 'https://example.com/users',
          targetDigest: null,
          targetHint: '/users',
          locatorDescriptorJson: null,
          collectorVersion: 1,
          evidenceStatus: 'complete',
          rejectionReason: null,
          status: 'discovered',
          createdAt: '2026-09-26T00:00:00.000Z',
        },
      ],
      totalGaps: 0,
    })
    await renderCard()
    await expect.element(page.getByText('导航线索与候选控件')).toBeVisible()
    const input = page.getByPlaceholder('输入探索作业 ID 审查')
    await input.fill('j1')
    await expect.element(page.getByText('用户管理')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '审核批准' })).toBeVisible()
  })
})
