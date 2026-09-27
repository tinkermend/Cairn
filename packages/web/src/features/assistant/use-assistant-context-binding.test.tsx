import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
import { normalizeAssistantPageContext } from '@cairn/shared'
import { useAssistantContextBinding } from './use-assistant-context-binding'
import { useAssistantStore, type AssistantBoundContext } from '@/stores/assistant-store'

function TestBindingComponent({
  id,
  context,
}: {
  id: string
  context: AssistantBoundContext
}) {
  useAssistantContextBinding(context)
  return <div data-testid={`bound-${id}`}>{context.page}</div>
}

describe('useAssistantContextBinding & ownerToken anti-race guard (CQ-02)', () => {
  it('prevents stale component unmount from wiping freshly bound context of new component', async () => {
    const contextRun: AssistantBoundContext = {
      page: 'run',
      entityId: 'run-1111',
      runId: 'run-1111',
    }

    const contextStudio: AssistantBoundContext = {
      page: 'studio',
      entityId: 'sc-2222',
      scenarioId: 'sc-2222',
    }

    function TestApp() {
      const [showA, setShowA] = useState(true)
      const [showB, setShowB] = useState(false)

      return (
        <div>
          {showA && <TestBindingComponent id='compA' context={contextRun} />}
          {showB && <TestBindingComponent id='compB' context={contextStudio} />}
          <button
            type='button'
            onClick={() => {
              // B mounts first, A unmounts
              setShowB(true)
              setShowA(false)
            }}
          >
            Switch
          </button>
        </div>
      )
    }

    const screen = await render(<TestApp />)

    // 初始状态由 Component A 绑定
    expect(useAssistantStore.getState().boundContext?.page).toBe('run')
    expect(useAssistantStore.getState().pageContext?.page).toBe('run')
    expect(useAssistantStore.getState().pageContext?.version).toBe(2)

    // 切换到 Component B
    const switchBtn = screen.getByRole('button', { name: 'Switch' })
    await switchBtn.click()

    // 此时 Component B 已经挂载，且 Component A 卸载不会把 Component B 的上下文擦除为 null
    expect(useAssistantStore.getState().boundContext?.page).toBe('studio')
    expect(useAssistantStore.getState().boundContext?.scenarioId).toBe('sc-2222')
    expect(useAssistantStore.getState().pageContext?.page).toBe('studio')
  })

  it('M2: 实时上下文切换：在单步聚焦与草稿修改状态更新时，boundContext 与 chips 实时自愈同步', async () => {
    function DynamicStudioApp() {
      const [selectedStepId, setSelectedStepId] = useState<string | undefined>(undefined)
      const [isDirty, setIsDirty] = useState(false)

      useAssistantContextBinding({
        page: 'studio',
        scenarioId: 'sc-test',
        selectedStepId,
        isDirty,
        chips: selectedStepId
          ? [
              {
                id: 'studio-step-propose',
                label: '✏️ 修改建议',
                question: '请对当前选中的步骤给出编写与配置优化建议。',
                capabilityHint: 'scenario.propose-step',
              },
            ]
          : [
              {
                id: 'studio-scenario-explain',
                label: '💡 解释场景全貌',
                question: '请解释当前场景的业务流程。',
                capabilityHint: 'scenario.explain',
              },
            ],
      })

      return (
        <div>
          <button type='button' onClick={() => setSelectedStepId('step-100')}>
            Select Step 100
          </button>
          <button type='button' onClick={() => setIsDirty(true)}>
            Mark Dirty
          </button>
        </div>
      )
    }

    const screen = await render(<DynamicStudioApp />)

    // 初始：全局场景态，推荐解释场景
    expect(useAssistantStore.getState().boundContext?.selectedStepId).toBeUndefined()
    expect(useAssistantStore.getState().boundContext?.chips?.[0].label).toBe('💡 解释场景全貌')

    // 切换单步聚焦
    await screen.getByRole('button', { name: 'Select Step 100' }).click()
    expect(useAssistantStore.getState().boundContext?.selectedStepId).toBe('step-100')
    expect(useAssistantStore.getState().boundContext?.chips?.[0].label).toBe('✏️ 修改建议')
    expect(useAssistantStore.getState().pageContext?.stepId).toBe('step-100')

    // 标记草稿为脏
    await screen.getByRole('button', { name: 'Mark Dirty' }).click()
    expect(useAssistantStore.getState().boundContext?.isDirty).toBe(true)
    expect(normalizeAssistantPageContext(useAssistantStore.getState().pageContext)?.draft?.isDirty).toBe(true)
  })
})
