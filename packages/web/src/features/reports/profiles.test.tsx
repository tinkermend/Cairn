import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DEFAULT_REPORT_CONFIG } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ApiRequestError } from '@/lib/api-client'
import { ReportProfileEditor } from './profiles'
import '@/styles/index.css'

const profile = { id: 'profile-1', targetId: 'target-1', name: '测试配置', revision: 1, editScope: 'scenario' as const, config: DEFAULT_REPORT_CONFIG }
const mocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('@/hooks/use-permissions', () => ({ useCan: () => true }))
vi.mock('./config-fields', () => ({ ReportConfigFields: () => null }))
vi.mock('@/lib/reports-api', () => ({
  fetchReportProfiles: vi.fn(async () => ({ items: [profile], nextCursor: null })),
  fetchReportProfile: vi.fn(async () => profile),
  fetchReportProfileVersions: vi.fn(async () => ({ items: [], nextCursor: null })),
  fetchScenarioReportDefaults: vi.fn(),
  saveScenarioReportDefaults: vi.fn(),
  saveReportProfile: mocks.save,
}))

describe('报告配置档冲突反馈', () => {
  it('保存被既有绑定阻止后，在编辑区列出可见与无权查看的绑定', async () => {
    mocks.save.mockRejectedValueOnce(new ApiRequestError(409, {
      code: 'REPORT_PROFILE_BINDINGS_INCOMPATIBLE', message: '存在不兼容绑定', requestId: 'test',
      details: { total: 2, bindings: [
        { kind: 'scenario', source: 'RUN', id: 'scenario-1', name: '登录检查', variables: ['suiteName'] },
        { kind: 'member', source: 'RUN', hidden: true, variables: ['suiteName'] },
      ] },
    }))
    const screen = await render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ReportProfileEditor targetId='target-1' editScope='scenario' /></QueryClientProvider>)
    await screen.getByText('管理报告配置档').click()
    await screen.getByRole('combobox', { name: '选择已有配置档（留空新建）' }).click()
    await screen.getByRole('option', { name: /测试配置/ }).click()
    await expect.element(screen.getByRole('combobox', { name: '默认报告标题' })).toHaveValue(DEFAULT_REPORT_CONFIG.title)
    await screen.getByRole('combobox', { name: '默认报告标题' }).fill('{suiteName}')
    await screen.getByRole('button', { name: '保存新版本' }).click()
    await expect.element(screen.getByText(/上次保存已阻止：2 处/)).toBeVisible()
    await expect.element(screen.getByRole('link', { name: '查看场景' })).toHaveAttribute('href', '/scenarios/scenario-1')
    await expect.element(screen.getByText(/无读取权限/)).toBeVisible()
  })
})
