import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { TargetMapPage } from './page'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchTarget: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  fetchMapSummary: vi.fn(),
  fetchMapObjects: vi.fn(),
  fetchMapPages: vi.fn(),
  fetchMapObject: vi.fn(),
  fetchMapChanges: vi.fn(),
  fetchMapImpacts: vi.fn(),
  fetchMapReferences: vi.fn(),
  fetchMapTerms: vi.fn(),
  createMapTerm: vi.fn(),
  updateMapTerm: vi.fn(),
  retireMapTerm: vi.fn(),
  fetchMapConsumptionPolicy: vi.fn(),
  updateMapConsumptionPolicy: vi.fn(),
  fetchMapJobPolicy: vi.fn(),
  updateMapJobPolicy: vi.fn(),
  fetchMapSafeEntries: vi.fn(),
  createMapSafeEntry: vi.fn(),
  previewMapJob: vi.fn(),
  createMapJob: vi.fn(),
  fetchExplorationPolicy: vi.fn(),
  updateExplorationPolicy: vi.fn(),
  previewExploration: vi.fn(),
  createExploration: vi.fn(),
  previewMapGovernance: vi.fn(),
  publishMapRelease: vi.fn(),
  submitMapGovernance: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTarget: mocks.fetchTarget,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))
vi.mock('@/lib/map-api', () => mocks)
vi.mock('@/lib/schedules-api', () => ({
  fetchSchedules: vi.fn(async () => ({ items: [] })),
  fetchSchedule: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  previewSchedule: vi.fn(),
  fetchScheduleOccurrences: vi.fn(async () => ({ items: [] })),
  fetchScheduleEvents: vi.fn(async () => ({ items: [] })),
}))
vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: vi.fn(async () => ({
    revision: 1,
    document: { mapScheduledRefreshEnabled: false, mapExplorationEnabled: false },
    updatedAt: '2026-09-16T00:00:00.000Z',
  })),
}))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({
      useParams: () => ({ targetId: TARGET_ID }),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

function signIn(
  permissions = ['target:read', 'map:read', 'map:review', 'map:publish']
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
  return render(
    <QueryClientProvider client={client}>
      <TargetMapPage />
    </QueryClientProvider>
  )
}

describe('目标知识页', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    vi.clearAllMocks()
    signIn()
    mocks.fetchTarget.mockResolvedValue({
      id: TARGET_ID,
      name: '演示商城',
      code: 'shop',
    })
    mocks.fetchMapSummary.mockResolvedValue({
      view: {
        viewRef: {
          kind: 'projection',
          projectionId: TARGET_ID,
          cursor: 0,
          revision: 1,
        },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
      projectionStatus: 'active',
      pageCount: 1,
      objectCount: 1,
      conflictCount: 0,
      unknownConditionCount: 0,
      changeCount: 0,
    })
    mocks.fetchMapObjects.mockResolvedValue({
      items: [
        {
          assetRef: {
            targetId: TARGET_ID,
            objectId: '44444444-4444-4444-8444-444444444444',
          },
          assetRefKey: 'p:x:o:44444444-4444-4444-8444-444444444444:i:x:d:0',
          name: '保存',
          routeTemplate: 'https://shop.example/orders',
          lifecycle: 'VERIFIED',
          dimensions: [
            {
              dimension: 'locator',
              verdict: 'confirmed',
              confirmedCount: 1,
              rejectedCount: 0,
              unknownCount: 0,
            },
          ],
          unknownFields: ['workspace'],
          changeCount: 0,
          evidenceAvailability: 'available',
        },
      ],
      view: {
        viewRef: {
          kind: 'projection',
          projectionId: TARGET_ID,
          cursor: 0,
          revision: 1,
        },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
    })
    mocks.fetchMapReferences.mockResolvedValue({
      items: [],
      restricted: false,
      scanStatus: 'idle',
      scanCompleteness: 'unknown',
    })
    mocks.fetchMapImpacts.mockResolvedValue({
      items: [],
      restricted: false,
      notes: [],
    })
    mocks.fetchMapTerms.mockResolvedValue({ items: [] })
    mocks.fetchMapConsumptionPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        mode: 'off',
        allowedStepTypes: ['extract', 'assert'],
        allowedAssetRefs: [],
        maxCandidateCount: 2,
        maxResolveMs: 1000,
        maxExtraAiCalls: 0,
        onUnavailable: 'baseline',
      },
      eligibility: null,
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.fetchMapJobPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        manualJobsEnabled: false,
        maxProbePages: 1,
        maxProbeObjects: 8,
        maxProbeActions: 8,
        maxProbeSeconds: 300,
        maxRefreshPages: 5,
        maxRefreshObjects: 20,
        maxRefreshActions: 20,
        maxRefreshSeconds: 900,
        sliceWorkSeconds: 20,
        defaultDepth: 'structure',
        staticRefreshDays: 7,
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.fetchMapSafeEntries.mockResolvedValue({ items: [] })
    mocks.fetchMapChanges.mockResolvedValue({
      items: [],
      view: {
        viewRef: {
          kind: 'projection',
          projectionId: TARGET_ID,
          cursor: 0,
          revision: 1,
        },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
    })
    mocks.fetchMapObject.mockResolvedValue({
      assetRef: {
        targetId: TARGET_ID,
        objectId: '44444444-4444-4444-8444-444444444444',
      },
      assetRefKey: 'p:x:o:44444444-4444-4444-8444-444444444444:i:x:d:0',
      lifecycle: 'VERIFIED',
      dimensions: [],
      unknownFields: ['workspace'],
      changeCount: 0,
      evidenceAvailability: 'available',
      implementations: [
        {
          implementationKey: 'impl:v1:zh',
          conditionUnknownFields: ['workspace'],
        },
      ],
      identityHistory: [],
      applicability: 'unknown',
    })
    mocks.fetchMapJobPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        manualJobsEnabled: false,
        maxProbePages: 1,
        maxProbeObjects: 8,
        maxProbeActions: 8,
        maxProbeSeconds: 300,
        maxRefreshPages: 5,
        maxRefreshObjects: 20,
        maxRefreshActions: 20,
        maxRefreshSeconds: 900,
        sliceWorkSeconds: 20,
        defaultDepth: 'structure',
        staticRefreshDays: 7,
      },
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.fetchMapSafeEntries.mockResolvedValue({ items: [] })
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
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
  })

  it('OMD02 中文桌面实现显示适用未知项，不以可信徽标概括', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('查看知识')).toBeVisible()
    await expect.element(screen.getByText('保存', { exact: true })).toBeVisible()
    await expect.element(screen.getByText(/workspace/)).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '发布此版本' }))
      .toBeVisible()

    await screen.getByRole('tab', { name: /地图维护/ }).click()
    await expect.element(screen.getByRole('heading', { name: '地图维护' })).toBeVisible()
    await expect.element(screen.getByText('手工作业关闭')).toBeVisible()

    await screen.getByRole('tab', { name: /知识资产/ }).click()
    await expect.element(screen.getByText('查看知识')).toBeVisible()
    await page.screenshot({
      path: '../../../../../.run/omd-review/desktop.png',
    })
  })

  it('OMD10 投影失败时保留说明且不伪装成无知识', async () => {
    mocks.fetchMapSummary.mockResolvedValue({
      view: {
        viewRef: {
          kind: 'projection',
          projectionId: TARGET_ID,
          cursor: 0,
          revision: 1,
        },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
      projectionStatus: 'failed',
      pageCount: 1,
      objectCount: 1,
      conflictCount: 0,
      unknownConditionCount: 0,
      changeCount: 0,
    })
    const screen = await renderPage()
    await expect.element(screen.getByText(/投影处理失败/)).toBeVisible()
    await expect.element(screen.getByText('保存', { exact: true })).toBeVisible()
  })

  it('无投影时说明不能发布，且不伪装成已有知识', async () => {
    mocks.fetchMapSummary.mockResolvedValue({
      view: {
        viewRef: { kind: 'missing' },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
      projectionStatus: 'missing',
      pageCount: 0,
      objectCount: 0,
      conflictCount: 0,
      unknownConditionCount: 0,
      changeCount: 0,
    })
    mocks.fetchMapObjects.mockResolvedValue({
      items: [],
      view: {
        viewRef: { kind: 'missing' },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
    })
    const screen = await renderPage()
    await expect.element(screen.getByText(/还没有知识投影/)).toBeVisible()
    await expect.element(screen.getByText('还没有目标知识')).toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '发布此版本' }))
      .toBeDisabled()
  })

  it('OME12 术语页签可达，空态保留输入', async () => {
    await page.viewport(390, 844)
    const screen = await renderPage()
    await screen.getByRole('button', { name: '术语' }).click()
    await expect.element(screen.getByText('还没有术语')).toBeVisible()
    await expect.element(screen.getByLabelText('术语名称')).toBeVisible()
  })

  it('OMD12 窄屏可选中对象并看到确认语义', async () => {
    await page.viewport(390, 844)
    const screen = await renderPage()
    await screen.getByText('保存', { exact: true }).click()
    await expect
      .element(screen.getByRole('button', { name: '确认语义' }))
      .toBeVisible()
    await expect
      .element(screen.getByRole('button', { name: '退役对象' }))
      .toBeVisible()
    await page.screenshot({
      path: '../../../../../.run/omd-review/mobile.png',
    })
  })
  it('退役按钮提交正确对象与理由，并在刷新后可恢复原值', async () => {
    mocks.previewMapGovernance.mockResolvedValue({
      baseRevision: 0,
      rejectReasons: [],
      affectedAssetKeys: [],
      visibleReferenceCount: 0,
      pendingConfirmationCount: 0,
      restricted: false,
    })
    mocks.submitMapGovernance.mockImplementation(async () => {
      const listing = await mocks.fetchMapObjects()
      mocks.fetchMapObjects.mockResolvedValue({
        ...listing,
        items: listing.items.map((item: object) => ({
          ...item,
          lifecycle: 'RETIRED',
          overlayLifecycle: 'RETIRED',
        })),
      })
      return { status: 'applied' }
    })
    const screen = await renderPage()
    await screen.getByRole('button', { name: '保存', exact: true }).click()
    await screen
      .getByRole('textbox', { name: '治理理由' })
      .fill('旧入口已经下线')
    await screen.getByRole('button', { name: '退役对象' }).click()
    await expect.poll(() => mocks.submitMapGovernance.mock.calls.length).toBe(1)
    expect(mocks.submitMapGovernance).toHaveBeenCalledWith(
      TARGET_ID,
      expect.objectContaining({
        kind: 'retire',
        reason: '旧入口已经下线',
        assetRef: expect.objectContaining({
          objectId: '44444444-4444-4444-8444-444444444444',
        }),
      })
    )
    await expect
      .element(screen.getByRole('button', { name: '恢复原值' }))
      .toBeVisible()
  })

  it('预览冲突保留理由且不提交，刷新知识可以恢复过期游标', async () => {
    mocks.previewMapGovernance.mockResolvedValue({
      baseRevision: 2,
      rejectReasons: ['revision_conflict'],
    })
    const screen = await renderPage()
    await screen.getByRole('button', { name: '保存', exact: true }).click()
    await screen.getByRole('textbox', { name: '治理理由' }).fill('保留这段理由')
    await screen.getByRole('button', { name: '确认语义' }).click()
    await expect
      .poll(() => mocks.previewMapGovernance.mock.calls.length)
      .toBe(1)
    expect(mocks.submitMapGovernance).not.toHaveBeenCalled()
    await expect
      .element(screen.getByRole('textbox', { name: '治理理由' }))
      .toHaveValue('保留这段理由')
    await screen.getByRole('button', { name: '刷新知识' }).click()
    await expect
      .poll(() => mocks.fetchMapObjects.mock.calls.length)
      .toBeGreaterThan(1)
  })
})
