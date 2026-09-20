import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { CredentialsPage } from './page'

vi.mock('@/lib/credentials-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/credentials-api')>()),
  fetchCredentials: vi.fn(async () => ({
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'target_password',
        source: 'target_account',
        name: '演示账号',
        safeIdentifier: 'alice',
        subjectLabel: '演示目标',
        targetId: '22222222-2222-4222-8222-222222222222',
        targetAccountId: '11111111-1111-4111-8111-111111111111',
        revision: 1,
        managementStatus: 'active',
        maintenanceStatus: 'due',
        maintenanceDueAt: '2026-09-01T00:00:00.000Z',
        validityStartedAt: '2026-01-01T00:00:00.000Z',
        validityPolicy: { mode: 'days', amount: 30, timeZone: 'UTC' },
        issuerExpiresAt: null,
        issuerExpirySource: 'unknown',
        verificationStatus: 'pending',
        identityBindingStatus: 'confirmed',
        ownerConsoleAccountId: null,
        ownerDisplayName: null,
        ownerStatus: 'unclaimed',
        session: {
          browser: 'unprepared',
          auth: 'unknown',
          identityState: 'UNVERIFIED',
          occupancy: 'idle',
          sessionId: null,
          generation: null,
          observedAt: null,
          lastAuthCheckedAt: null,
          lastAuthSuccessAt: null,
          occupyingLabel: null,
        },
        capabilities: {
          canReplace: true,
          canSetMaintenance: true,
          canVerify: true,
          canDisable: true,
          externallyRenewed: false,
        },
        currentVersionId: null,
        updatedAt: '2026-09-19T00:00:00.000Z',
        createdAt: '2026-09-19T00:00:00.000Z',
      },
    ],
    stats: {
      visible: 1,
      approaching: 0,
      due: 1,
      unknown: 0,
      authAbnormal: 0,
      pendingVerification: 1,
      unclaimed: 1,
    },
    asOf: '2026-09-19T00:00:00.000Z',
    realtime: true,
  })),
  createCredentialBatch: vi.fn(),
  submitCredentialBatchItem: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={String(to)}>{children}</a>
  ),
}))

describe('凭据列表页', () => {
  it('展示维护提醒而不是停运措辞', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { getByRole, getByText, getByLabelText } = await render(
      <QueryClientProvider client={client}>
        <CredentialsPage />
      </QueryClientProvider>
    )
    await expect
      .element(getByRole('heading', { name: '凭据管理' }))
      .toBeInTheDocument()
    await expect.element(getByText('演示账号')).toBeInTheDocument()
    await expect
      .element(getByLabelText('凭据列表').getByText('已到期'))
      .toBeInTheDocument()
    await expect
      .element(getByText('尚未启动浏览器 · 尚未检查登录'))
      .toBeInTheDocument()
    expect(document.body.textContent).toMatch(/用于提醒/)
    expect(document.body.textContent).not.toMatch(/模型|Webhook|材料版本/)
    expect(document.body.textContent).not.toMatch(/\bunknown\b/)
  })
})
