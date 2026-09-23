import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { StepTypeIcon } from './step-type-icon'

describe('StepTypeIcon', () => {
  it('渲染常见确定性步骤图标', async () => {
    const screen = await render(<StepTypeIcon type='click' />)
    expect(screen.container.querySelector('svg')).not.toBeNull()
  })

  it('渲染 AI 步骤图标', async () => {
    const screen = await render(<StepTypeIcon type='ai_action' />)
    expect(screen.container.querySelector('svg')).not.toBeNull()
  })

  it('未识别类型优雅回退默认图标', async () => {
    const screen = await render(<StepTypeIcon type='unknown_custom_type' />)
    expect(screen.container.querySelector('svg')).not.toBeNull()
  })
})
