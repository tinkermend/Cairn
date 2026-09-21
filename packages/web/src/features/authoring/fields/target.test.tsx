import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { withPickedSemantic } from './target'
import { TargetFields } from './target'
import { AuthoringObserveProvider } from '../observe'
import { createBlankStep } from '../step-registry'

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

  it('新建等待默认是元素可见而不是固定时间', () => {
    const step = createBlankStep('wait')
    expect(step.type).toBe('wait')
    expect(step.type === 'wait' && step.input.kind).toBe('visible')
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
    await expect.element(screen.getByLabelText('目标')).toBeInTheDocument()
    await expect.element(screen.getByText('规则')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '高级：候选、锚点与解析档位' })).toBeInTheDocument()
    await expect.element(screen.getByLabelText('定位值 1')).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '高级：候选、锚点与解析档位' }).click()
    await expect.element(screen.getByLabelText('定位值 1')).toBeInTheDocument()
  })
})
