import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { createRuntimeInvariant, type RuntimeInvariant } from '@cairn/shared'
import { RuntimeInvariantEditor } from './invariant-editor'

function EditorHarness() {
  const [invariants, setInvariants] = useState<RuntimeInvariant[]>([
    createRuntimeInvariant('auth_validity', '00000000-0000-4000-8000-000000000001'),
  ])
  return <RuntimeInvariantEditor invariants={invariants} onChange={setInvariants} />
}

function SurfaceEditorHarness({ allowEachStepProbe }: { allowEachStepProbe?: boolean }) {
  const [invariants, setInvariants] = useState<RuntimeInvariant[]>([
    createRuntimeInvariant('error_surface', '00000000-0000-4000-8000-000000000002'),
  ])
  return (
    <RuntimeInvariantEditor
      invariants={invariants}
      allowEachStepProbe={allowEachStepProbe}
      onChange={setInvariants}
    />
  )
}

describe('RuntimeInvariantEditor', () => {
  it('展示运行期约束并用业务语言说明认证默认应当成立', async () => {
    const screen = await render(<EditorHarness />)
    await expect.element(screen.getByRole('heading', { name: '运行期约束' })).toBeInTheDocument()
    expect(screen.container.textContent).toMatch(/登录保持有效/)
    await expect.element(screen.getByLabelText('一句话说明')).toBeInTheDocument()
    await screen.getByRole('button', { name: '高级' }).click()
    await expect.element(screen.getByText('应当')).toBeInTheDocument()
    expect(screen.container.textContent).not.toMatch(/每一步后探测/)
  })

  it('错误弹窗默认展示每一步后探测', async () => {
    const screen = await render(<SurfaceEditorHarness />)
    expect(screen.container.textContent).toMatch(/默认在每一步后检查当前页/)
    await screen.getByRole('button', { name: '高级' }).click()
    expect(screen.container.textContent).toMatch(/每一步后探测/)
  })
})
