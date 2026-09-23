import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { MaintenancePage } from '../index'
import { IncidentDetailPage } from '../detail'

const mocks = vi.hoisted(() => ({
  params: { incidentId: 'inc-101' },
  search: { view: 'incidents' } as Record<string, any>,
  navigate: vi.fn(),
  fetchIncidents: vi.fn(),
  fetchIncidentDetail: vi.fn(),
  fetchIncidentSignals: vi.fn(),
  fetchAssetReliability: vi.fn(),
  dismissIncident: vi.fn(),
  silenceIncident: vi.fn(),
  splitIncident: vi.fn(),
  resolveIncident: vi.fn(),
  fetchIncidentImpact: vi.fn(),
  executeBatchUpgrade: vi.fn(),
  fetchUpgradeJob: vi.fn(),
  fetchTargets: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => mocks.params,
    useSearch: () => mocks.search,
    useNavigate: () => mocks.navigate,
    Link: ({ children, to }: { children: React.ReactNode; to?: string }) => <a href={to ?? '#'}>{children}</a>,
  }
})

vi.mock('@/lib/reliability-api', () => ({
  fetchIncidents: mocks.fetchIncidents,
  fetchIncidentDetail: mocks.fetchIncidentDetail,
  fetchIncidentSignals: mocks.fetchIncidentSignals,
  fetchAssetReliability: mocks.fetchAssetReliability,
  dismissIncident: mocks.dismissIncident,
  silenceIncident: mocks.silenceIncident,
  splitIncident: mocks.splitIncident,
  resolveIncident: mocks.resolveIncident,
  fetchIncidentImpact: mocks.fetchIncidentImpact,
  executeBatchUpgrade: mocks.executeBatchUpgrade,
  fetchUpgradeJob: mocks.fetchUpgradeJob,
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
}))

describe('Maintenance Features', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    useAuthStore.getState().auth.setUser({
      id: 'u-admin',
      displayName: '运维管理员',
      email: 'admin@cairn.local',
      roles: ['admin'],
      permissions: ['reliability:read', 'reliability:write'],
    })

    mocks.fetchTargets.mockResolvedValue({
      items: [{ id: 'tgt-1', name: 'ERP结算中心' }],
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
    vi.clearAllMocks()
  })

  describe('MaintenancePage', () => {
    it('renders incidents list and collection summary HUD', async () => {
      mocks.search = { view: 'incidents' }
      mocks.fetchIncidents.mockResolvedValue({
        items: [
          {
            id: 'inc-101',
            targetId: 'tgt-1',
            groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
            scopeDigest: 'digest-001',
            severity: 'P2',
            status: 'DETECTED',
            title: '登录按钮定位器退化',
            firstSeenAt: '2026-09-23T00:00:00Z',
            lastSeenAt: '2026-09-23T01:00:00Z',
            memberCount: 3,
            revision: 1,
            silencedUntil: null,
            lineage: {
              targetId: 'tgt-1',
              targetName: 'ERP结算中心',
              scenarioId: 'sc-login',
              scenarioName: '登录用例',
              stepId: 'step-submit',
              stepName: '点击提交',
            },
          },
        ],
        nextCursor: undefined,
      })
      mocks.fetchAssetReliability.mockResolvedValue({
        items: [],
      })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <MaintenancePage />
        </QueryClientProvider>,
      )

      await expect.element(screen.getByText('自动化维护')).toBeInTheDocument()
      await expect.element(screen.getByText('登录按钮定位器退化')).toBeInTheDocument()
      await expect.element(screen.getByText('P2')).toBeInTheDocument()
      await expect.element(screen.getByText('已发现')).toBeInTheDocument()
      await expect.element(screen.getByText('3 次相关运行')).toBeInTheDocument()
    })

    it('renders asset reliability table in assets view', async () => {
      mocks.search = { view: 'assets' }
      mocks.fetchIncidents.mockResolvedValue({ items: [] })
      mocks.fetchAssetReliability.mockResolvedValue({
        items: [
          {
            assetId: 'sc-login',
            assetType: 'scenario',
            assetName: '登录结算全流程',
            targetId: 'tgt-1',
            targetName: 'ERP结算中心',
            sampleCount: 42,
            ewmaSuccessRate: 0.945,
            p95DurationMs: 2400,
            activeIncidentsCount: 1,
            highestSeverity: 'P2',
            lastEvaluatedAt: '2026-09-23T01:00:00Z',
            status: 'degraded',
          },
        ],
      })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <MaintenancePage />
        </QueryClientProvider>,
      )

      await expect.element(screen.getByText('登录结算全流程')).toBeInTheDocument()
      await expect.element(screen.getByText('42 次')).toBeInTheDocument()
      await expect.element(screen.getByText('94.5%')).toBeInTheDocument()
      await expect.element(screen.getByText('2400ms')).toBeInTheDocument()
      await expect.element(screen.getByText('退化', { exact: true })).toBeInTheDocument()
    })
  })

  describe('IncidentDetailPage', () => {
    it('renders incident detail overview and evidence signals ledger', async () => {
      mocks.params = { incidentId: 'inc-101' }
      mocks.search = { tab: 'overview' }

      mocks.fetchIncidentDetail.mockResolvedValue({
        incident: {
          id: 'inc-101',
          targetId: 'tgt-1',
          groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
          scopeDigest: 'digest-001',
          severity: 'P2',
          status: 'DETECTED',
          title: '登录按钮定位器退化',
          summary: '连续3次运行出现定位器降级',
          firstSeenAt: '2026-09-23T00:00:00Z',
          lastSeenAt: '2026-09-23T01:00:00Z',
          memberCount: 3,
          revision: 1,
          silencedUntil: null,
          lineage: {
            targetId: 'tgt-1',
            targetName: 'ERP结算中心',
            scenarioId: 'sc-login',
            scenarioName: '登录用例',
            stepId: 'step-submit',
            stepName: '点击提交',
          },
        },
        members: [
          {
            id: 'mem-1',
            incidentId: 'inc-101',
            runId: 'run-888',
            stepRunId: 'step-run-1',
            attemptId: 'att-1',
            firstSeenAt: '2026-09-23T00:00:00Z',
            lastSeenAt: '2026-09-23T01:00:00Z',
            occurrenceCount: 1,
            isExemplar: true,
            weight: 1,
            summary: {
              errorMessage: 'Element #submit-btn not visible within 5000ms',
            },
          },
        ],
      })

      mocks.fetchIncidentSignals.mockResolvedValue({
        items: [
          {
            id: 'sig-1',
            targetId: 'tgt-1',
            kind: 'locator_degraded',
            severity: 'warn',
            subjectRef: {
              kind: 'scenario_step',
              id: 'step-submit',
            },
            sourceRef: {
              kind: 'run',
              id: 'run-888',
              runId: 'run-888',
              attemptId: 'att-1',
            },
            occurredAt: '2026-09-23T00:00:00Z',
            scopeDigest: 'digest-001',
            availability: 'available',
            createdAt: '2026-09-23T00:00:00Z',
          },
        ],
      })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <IncidentDetailPage />
        </QueryClientProvider>,
      )

      await expect.element(screen.getByText('登录按钮定位器退化')).toBeInTheDocument()
      await expect.element(screen.getByText('ERP结算中心')).toBeInTheDocument()
      await expect.element(screen.getByText('登录用例')).toBeInTheDocument()
      await expect.element(screen.getByText('点击提交')).toBeInTheDocument()
      await expect.element(screen.getByText('连续3次运行出现定位器降级')).toBeInTheDocument()
    })

    it('renders impact tab members list', async () => {
      mocks.params = { incidentId: 'inc-101' }
      mocks.search = { tab: 'impact' }

      mocks.fetchIncidentDetail.mockResolvedValue({
        incident: {
          id: 'inc-101',
          targetId: 'tgt-1',
          groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
          scopeDigest: 'digest-001',
          severity: 'P2',
          status: 'DETECTED',
          title: '登录按钮定位器退化',
          summary: '连续3次运行出现定位器降级',
          firstSeenAt: '2026-09-23T00:00:00Z',
          lastSeenAt: '2026-09-23T01:00:00Z',
          memberCount: 1,
          revision: 1,
          silencedUntil: null,
          lineage: {
            targetId: 'tgt-1',
            targetName: 'ERP结算中心',
          },
        },
        members: [
          {
            id: 'mem-1',
            incidentId: 'inc-101',
            memberRef: 'run:run-888:attempt:1',
            memberType: 'attempt',
            joinedAt: '2026-09-23T01:00:00Z',
          },
        ],
      })

      mocks.fetchIncidentSignals.mockResolvedValue({ items: [] })
      mocks.fetchIncidentImpact.mockResolvedValue({
        incidentId: 'inc-101',
        targetId: 'tgt-1',
        impactedRuns: ['run-888'],
        affectedAssets: [
          {
            assetId: 'sc-order',
            assetType: 'scenario',
            assetName: '订单提交结账场景',
            moduleId: 'mod-login',
            moduleName: '用户登录模块',
            currentBindingVersionId: 'v-1',
            currentBindingVersionNo: 1,
            targetVersionId: 'v-2',
            targetVersionNo: 2,
            relation: 'confirmed',
            upgradeStatus: 'upgradeable',
          },
        ],
        summary: {
          totalScenarios: 1,
          upgradeableCount: 1,
          blockedCount: 0,
          alreadyLatestCount: 0,
          gapsCount: 0,
        },
        coverageGaps: [],
        generatedAt: '2026-09-23T01:00:00Z',
      })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <IncidentDetailPage />
        </QueryClientProvider>,
      )

      await expect.element(screen.getByText('关联运行与故障现场 (1)')).toBeInTheDocument()
      await expect.element(screen.getByText('Attempt #run-888')).toBeInTheDocument()
      await expect.element(screen.getByText('受影响下游资产与集中维护 (Affected Assets & Batch Maintenance)')).toBeInTheDocument()
      await expect.element(screen.getByText('订单提交结账场景')).toBeInTheDocument()
      await expect.element(screen.getByText('建议可升级: 1')).toBeInTheDocument()
    })

    it('supports batch upgrading affected scenarios from impact tab', async () => {
      mocks.params = { incidentId: 'inc-101' }
      mocks.search = { tab: 'impact' }

      mocks.fetchIncidentDetail.mockResolvedValue({
        incident: {
          id: 'inc-101',
          targetId: 'tgt-1',
          groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
          scopeDigest: 'digest-001',
          severity: 'P2',
          status: 'DETECTED',
          title: '登录按钮定位器退化',
          summary: '连续3次运行出现定位器降级',
          firstSeenAt: '2026-09-23T00:00:00Z',
          lastSeenAt: '2026-09-23T01:00:00Z',
          memberCount: 1,
          revision: 1,
          silencedUntil: null,
        },
        members: [],
      })
      mocks.fetchIncidentSignals.mockResolvedValue({ items: [] })
      mocks.fetchIncidentImpact.mockResolvedValue({
        incidentId: 'inc-101',
        targetId: 'tgt-1',
        impactedRuns: [],
        affectedAssets: [
          {
            assetId: 'sc-order',
            assetType: 'scenario',
            assetName: '订单提交结账场景',
            moduleId: 'mod-login',
            moduleName: '用户登录模块',
            currentBindingVersionId: 'v-1',
            currentBindingVersionNo: 1,
            targetVersionId: 'v-2',
            targetVersionNo: 2,
            relation: 'confirmed',
            upgradeStatus: 'upgradeable',
          },
        ],
        summary: {
          totalScenarios: 1,
          upgradeableCount: 1,
          blockedCount: 0,
          alreadyLatestCount: 0,
          gapsCount: 0,
        },
        coverageGaps: [],
        generatedAt: '2026-09-23T01:00:00Z',
      })
      mocks.executeBatchUpgrade.mockResolvedValue({
        jobId: 'job-999',
        incidentId: 'inc-101',
        targetId: 'tgt-1',
        moduleId: 'mod-login',
        toVersionId: 'v-2',
        status: 'completed',
        results: [
          {
            scenarioId: 'sc-order',
            scenarioName: '订单提交结账场景',
            status: 'upgraded',
          },
        ],
        createdAt: '2026-09-23T01:00:00Z',
        completedAt: '2026-09-23T01:00:01Z',
      })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <IncidentDetailPage />
        </QueryClientProvider>,
      )

      const upgradeBtn = screen.getByRole('button', { name: /批量升级选中场景/ })
      await expect.element(upgradeBtn).toBeInTheDocument()
      await upgradeBtn.click()

      expect(mocks.executeBatchUpgrade).toHaveBeenCalledWith('inc-101', expect.objectContaining({
        moduleId: 'mod-login',
        toVersionId: 'v-2',
        scenarioIds: ['sc-order'],
      }))

      await expect.element(screen.getByText('集中升级执行结果 (Batch Upgrade Receipt)')).toBeInTheDocument()
    })

    it('renders repairs guidance tab', async () => {
      mocks.params = { incidentId: 'inc-101' }
      mocks.search = { tab: 'repairs' }

      mocks.fetchIncidentDetail.mockResolvedValue({
        incident: {
          id: 'inc-101',
          targetId: 'tgt-1',
          groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
          scopeDigest: 'digest-001',
          severity: 'P2',
          status: 'DETECTED',
          title: '登录按钮定位器退化',
          summary: '连续3次运行出现定位器降级',
          firstSeenAt: '2026-09-23T00:00:00Z',
          lastSeenAt: '2026-09-23T01:00:00Z',
          memberCount: 1,
          revision: 1,
          silencedUntil: null,
          lineage: {
            targetId: 'tgt-1',
            targetName: 'ERP结算中心',
            scenarioId: 'sc-login',
            scenarioName: '登录用例',
            stepId: 'step-submit',
            stepName: '点击提交',
          },
        },
        members: [],
      })

      mocks.fetchIncidentSignals.mockResolvedValue({ items: [] })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <IncidentDetailPage />
        </QueryClientProvider>,
      )

      await expect.element(screen.getByText('人工安全维护与跳转指引')).toBeInTheDocument()
      await expect.element(screen.getByText('前往场景编排工作台')).toBeInTheDocument()
      await expect.element(screen.getByText('AI 受控自愈演进（AI-02 接管）')).toBeInTheDocument()
    })

    it('supports triggering triage dialog and opening confirmation modal', async () => {
      mocks.params = { incidentId: 'inc-101' }
      mocks.search = { tab: 'overview' }

      mocks.fetchIncidentDetail.mockResolvedValue({
        incident: {
          id: 'inc-101',
          targetId: 'tgt-1',
          groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
          scopeDigest: 'digest-001',
          severity: 'P2',
          status: 'DETECTED',
          title: '登录按钮定位器退化',
          summary: '连续3次运行出现定位器降级',
          firstSeenAt: '2026-09-23T00:00:00Z',
          lastSeenAt: '2026-09-23T01:00:00Z',
          memberCount: 1,
          revision: 1,
          silencedUntil: null,
        },
        members: [],
      })
      mocks.fetchIncidentSignals.mockResolvedValue({ items: [] })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <IncidentDetailPage />
        </QueryClientProvider>,
      )

      const dismissBtn = screen.getByRole('button', { name: /排除事件/ })
      await dismissBtn.click()

      await expect.element(screen.getByText('排除该可靠性事件')).toBeInTheDocument()
      await expect.element(screen.getByText('排除理由')).toBeInTheDocument()
    })

    it('supports triggering resolve dialog and confirming resolution', async () => {
      mocks.params = { incidentId: 'inc-101' }
      mocks.search = { tab: 'overview' }

      mocks.fetchIncidentDetail.mockResolvedValue({
        incident: {
          id: 'inc-101',
          targetId: 'tgt-1',
          groupingKey: 'gk:target:tgt-1:scenario:sc-login:step:step-submit:LOCATOR_DEGRADED',
          scopeDigest: 'digest-001',
          severity: 'P2',
          status: 'OBSERVING',
          title: '登录按钮定位器退化',
          summary: '连续3次运行出现定位器降级',
          firstSeenAt: '2026-09-23T00:00:00Z',
          lastSeenAt: '2026-09-23T01:00:00Z',
          memberCount: 1,
          revision: 1,
          silencedUntil: null,
        },
        members: [],
      })
      mocks.fetchIncidentSignals.mockResolvedValue({ items: [] })

      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <IncidentDetailPage />
        </QueryClientProvider>,
      )

      const resolveBtn = screen.getByRole('button', { name: /解决\/归档/ })
      await resolveBtn.click()

      await expect.element(screen.getByText('标记解决 / 归档事件')).toBeInTheDocument()
      await expect.element(screen.getByText('解决/归档理由')).toBeInTheDocument()
    })
  })
})
