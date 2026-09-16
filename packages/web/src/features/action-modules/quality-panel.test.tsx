import type { ComponentProps } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import type { ModuleInvocationListItem, ModuleQualityResponse, ModuleQualityStats } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ActionModuleQualityPanel } from './quality-panel'

const moduleId = '11111111-1111-4111-8111-111111111111'
const runId = '44444444-4444-4444-8444-444444444444'
const invocationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const versionId = '33333333-3333-4333-8333-333333333333'

const mocks = vi.hoisted(() => ({
  fetchActionModuleQuality: vi.fn(),
  fetchModuleInvocations: vi.fn(),
}))

vi.mock('@/lib/action-modules-api', () => mocks)
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({
    children,
    params,
    search,
  }: ComponentProps<'a'> & { params?: { runId: string }; search?: { invocation?: string } }) => (
    <a href={`/runs/${params?.runId ?? ''}?invocation=${search?.invocation ?? ''}`}>{children}</a>
  ),
}))

function emptyStats(): ModuleQualityStats {
  return {
    calls: 0,
    verified: 0,
    failedImplementation: 0,
    failedVerification: 0,
    externalInfra: 0,
    needsReview: 0,
    notReached: 0,
    cancelled: 0,
    unknown: 0,
    insufficient: 0,
    retriedSuccess: 0,
    sampleCount: 0,
    verifiedRate: null,
    durationMsP50: null,
    durationMsP95: null,
    aiCalls: 0,
    aiCost: null,
    lastVerifiedAt: null,
  }
}

function quality(overrides: Partial<ModuleQualityResponse> = {}): ModuleQualityResponse {
  return {
    moduleId,
    versionId: null,
    windowDays: 7,
    groupBy: 'account',
    asOf: '2026-09-16T00:00:00.000Z',
    configRevision: 2,
    health: {
      signal: 'unknown',
      sampleCount: 0,
      verifiedRate: null,
      windowDays: 7,
      configRevision: 2,
      asOf: '2026-09-16T00:00:00.000Z',
      verificationInsufficient: false,
    },
    overall: emptyStats(),
    trial: emptyStats(),
    pendingBackfill: 0,
    ...overrides,
  }
}

function invocation(overrides: Partial<ModuleInvocationListItem> = {}): ModuleInvocationListItem {
  return {
    runId,
    invocationId,
    projectorVersion: 1,
    moduleId,
    moduleVersionId: versionId,
    runKind: 'published',
    targetId: '22222222-2222-4222-8222-222222222222',
    outcome: 'FAILED_VERIFICATION',
    attribution: 'MODULE',
    manualRequirementsUnverified: 2,
    verificationStrength: 'insufficient',
    retriedSuccess: false,
    finishedAt: '2026-09-16T01:00:00.000Z',
    aiCalls: 0,
    sourceRunEventSeq: 3,
    runHref: `/runs/${runId}?invocation=${invocationId}`,
    ...overrides,
  }
}

async function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ActionModuleQualityPanel
        moduleId={moduleId}
        versions={[
          {
            id: versionId,
            moduleId,
            versionNo: 1,
            content: {
              contract: {
                inputs: [],
                outputs: [],
                effectCeiling: 'READ_ONLY',
                preconditions: [],
                postconditions: [],
              },
              implementations: [{
                implementationKey: 'default',
                kind: 'structured_steps',
                steps: [{
                  id: invocationId,
                  name: '回显',
                  type: 'echo',
                  effectType: 'READ_ONLY',
                  outputKey: 'internal',
                  input: { value: 'ok' },
                }],
                outputMapping: {},
              }],
            },
            contentDigest: 'c',
            contractDigest: 'k',
            implementationDigest: 'i',
            compilerVersion: 1,
            executionMode: 'DETERMINISTIC',
            effectCeiling: 'READ_ONLY',
            publicationStatus: 'published',
            sourceDraftRevision: 1,
            createdBy: moduleId,
            createdAt: '2026-09-16T00:00:00.000Z',
          },
        ]}
      />
    </QueryClientProvider>,
  )
}

describe('动作模块运行质量页签', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchActionModuleQuality.mockResolvedValue(quality())
    mocks.fetchModuleInvocations.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      asOf: '2026-09-16T00:00:00.000Z',
    })
  })

  it('空态显示样本不足，不给通过率', async () => {
    const screen = await renderPanel()
    await expect.element(screen.getByText('通过率 样本不足（样本 0）')).toBeInTheDocument()
    await expect.element(screen.getByText('还没有可展示的模块调用结果。')).toBeInTheDocument()
    await expect.element(screen.getByText(/配置修订 2/)).toBeInTheDocument()
  })

  it('配置读取失败时展示错误，不回落默认值', async () => {
    mocks.fetchActionModuleQuality.mockRejectedValueOnce(new Error('平台配置不可用'))
    const screen = await renderPanel()
    await expect.element(screen.getByText('平台配置不可用')).toBeInTheDocument()
    await expect.element(screen.getByText('正式调用 0')).not.toBeInTheDocument()
  })

  it('AME-02/11 显示人工说明、验证强度不足，并带 invocation 深链', async () => {
    mocks.fetchActionModuleQuality.mockResolvedValue(
      quality({
        health: {
          signal: 'degraded',
          sampleCount: 10,
          verifiedRate: 0.7,
          windowDays: 7,
          configRevision: 2,
          asOf: '2026-09-16T00:00:00.000Z',
          verificationInsufficient: true,
        },
        overall: { ...emptyStats(), calls: 10, sampleCount: 10, verifiedRate: 0.7 },
        trial: { ...emptyStats(), calls: 1 },
      }),
    )
    mocks.fetchModuleInvocations.mockResolvedValue({
      items: [invocation()],
      total: 1,
      page: 1,
      pageSize: 20,
      asOf: '2026-09-16T00:00:00.000Z',
    })
    const screen = await renderPanel()
    await expect.element(screen.getByText('降级')).toBeInTheDocument()
    await expect.element(screen.getByText('验证失败')).toBeInTheDocument()
    await expect.element(screen.getByText('人工说明未验证 2 项 · 验证强度不足')).toBeInTheDocument()
    await expect.element(screen.getByText('试跑调用 1（单独统计，不计入正式通过率）')).toBeInTheDocument()
    await expect.element(screen.getByText(/验证强度不足，不参与退化判定/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: '打开运行' })
    await expect.element(link).toHaveAttribute('href', `/runs/${runId}?invocation=${invocationId}`)
  })

  it('AMF 按实现拆分并通过率、回退次数只读展示', async () => {
    mocks.fetchActionModuleQuality.mockResolvedValue(
      quality({
        fallback: { occurred: 2, succeeded: 1 },
        implementations: [
          { ...emptyStats(), implementationKey: 'default', calls: 4, sampleCount: 4, verifiedRate: 0.5 },
          { ...emptyStats(), implementationKey: 'alt', calls: 2, sampleCount: 2, verifiedRate: null },
        ],
      }),
    )
    const screen = await renderPanel()
    await expect.element(screen.getByText('回退发生 2 次 · 回退后成功 1 次')).toBeInTheDocument()
    await expect.element(screen.getByText('default')).toBeInTheDocument()
    await expect.element(screen.getByText('alt')).toBeInTheDocument()
    await expect.element(screen.getByText('50%')).toBeInTheDocument()
  })
})
