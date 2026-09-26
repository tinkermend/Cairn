import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
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
})
