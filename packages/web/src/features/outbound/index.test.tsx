import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { OutboundPage } from './index'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({ tab: 'records' }),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: any) =>
    selector({
      auth: {
        user: {
          id: 'user-1',
          name: '管理员',
          permissions: [
            'outbound:read',
            'outbound:operate',
            'notification:read',
            'notification:operate',
            'platform-config:read',
            'platform-config:write',
            'workflow:read',
            'workflow:write',
            'monitor:read',
            'target:read',
            'run:read',
          ],
        },
      },
    }),
}))

vi.mock('@/lib/outbound-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outbound-api')>()),
  fetchOutboundEvents: vi.fn(async () => ({
    items: [
      {
        id: 'event-1',
        type: 'run.finished',
        runId: 'run-12345678-aaaa-bbbb-cccc-dddddddddddd',
        targetId: 'target-1',
        scenarioId: 'scenario-1',
        alertId: null,
        state: 'ready',
        reason: null,
        occurredAt: '2026-09-21T00:00:00.000Z',
        observedAt: '2026-09-21T00:00:01.000Z',
        payload: {
          title: '订单业务巡检：通过',
          status: 'SUCCEEDED',
          outcomeStatus: 'PASS',
          evidenceStatus: 'COMPLETE',
        },
        consoleUrl: null,
        deliveries: [
          {
            id: 'del-1',
            channelId: 'ch-1',
            channelName: '钉钉运维群',
            kind: 'webhook',
            recipientLabel: 'https://oapi.dingtalk.com/...',
            status: 'accepted',
            reason: null,
            automaticAttemptCount: 1,
            nextAttemptAt: null,
            closedAt: null,
            attempts: [],
          },
        ],
      },
      {
        id: 'event-2',
        type: 'alert.firing',
        runId: null,
        targetId: null,
        scenarioId: null,
        alertId: 'alert-87654321-aaaa-bbbb-cccc-dddddddddddd',
        state: 'ready',
        reason: null,
        occurredAt: '2026-09-21T00:05:00.000Z',
        observedAt: '2026-09-21T00:05:01.000Z',
        payload: {
          title: '连续失败率告警',
        },
        consoleUrl: null,
        deliveries: [
          {
            id: 'del-2',
            channelId: 'ch-2',
            channelName: '应急邮件组',
            kind: 'email',
            recipientLabel: 'ops@example.com',
            status: 'failed',
            reason: 'smtp_rejected',
            automaticAttemptCount: 5,
            nextAttemptAt: null,
            closedAt: null,
            attempts: [],
          },
        ],
      },
    ],
    nextCursor: null,
  })),
  fetchOutboundChannels: vi.fn(async () => ({
    revision: 1,
    enabled: true,
    consoleBaseUrl: 'https://cairn.example.com',
    smtp: {
      host: 'smtp.example.com',
      version: 1,
      enabled: true,
      revoked: false,
    },
    channels: [
      {
        id: 'ch-1',
        name: '钉钉运维群',
        kind: 'webhook',
        enabled: true,
        allowAlerts: true,
        targetIds: ['target-1'],
        version: 1,
        host: 'oapi.dingtalk.com',
        recipientCount: 0,
        format: 'cairn.outbound@1',
        replay: 'manual_on_unknown',
        revoked: false,
      },
      {
        id: 'ch-2',
        name: '应急邮件组',
        kind: 'email',
        enabled: true,
        allowAlerts: true,
        targetIds: ['target-1'],
        version: 1,
        host: 'smtp.example.com',
        recipientCount: 2,
        format: 'cairn.outbound@1',
        replay: 'manual_on_unknown',
        revoked: false,
      },
    ],
  })),
  subscribeOutbound: vi.fn(async () => {}),
  fetchNotificationEvents: vi.fn(async () => ({ items: [], nextCursor: null })),
  fetchNotificationChannels: vi.fn(async () => ({ revision: 1, enabled: true, channels: [] })),
  subscribeNotifications: vi.fn(async () => {}),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: vi.fn(async () => ({
    items: [{ id: 'target-1', name: '生产订单系统' }],
  })),
}))

describe('OutboundPage', () => {
  it('渲染消息推送页面与概览指标卡', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { getByText, getByRole } = await render(
      <QueryClientProvider client={queryClient}>
        <OutboundPage />
      </QueryClientProvider>
    )

    await expect
      .element(getByRole('heading', { name: '消息推送' }))
      .toBeInTheDocument()
    await expect
      .element(getByText('集中管理场景运行结果、告警与发送渠道。每个目的地的投递结果独立记录。'))
      .toBeInTheDocument()

    // 验证 CollectionSummary 指标
    await expect.element(getByText('本页记录')).toBeInTheDocument()
    await expect.element(getByText('待处理异常')).toBeInTheDocument()
    await expect.element(getByText('可用渠道')).toBeInTheDocument()

    // 验证筛选按钮
    await expect
      .element(getByRole('button', { name: '对方已接受' }))
      .toBeInTheDocument()
    await expect
      .element(getByRole('button', { name: '发送失败' }))
      .toBeInTheDocument()

    // 验证数据表格渲染
    await expect.element(getByText('订单业务巡检：通过')).toBeInTheDocument()
    await expect.element(getByText('连续失败率告警')).toBeInTheDocument()
    await expect.element(getByText('钉钉运维群 · 对方已接受')).toBeInTheDocument()
    await expect.element(getByText('应急邮件组 · 发送失败')).toBeInTheDocument()
  })
})
