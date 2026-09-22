import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { GeneratorConfigEditor } from './generator-editor'
import type { DataGeneratorSpec } from '@cairn/shared'

describe('GeneratorConfigEditor', () => {
  it('renders activation button when generator is undefined', async () => {
    const onChange = vi.fn()
    const screen = await render(
      <GeneratorConfigEditor generator={undefined} onChange={onChange} />
    )

    const btn = screen.getByRole('button', { name: /配置动态生成规则/i })
    await expect.element(btn).toBeInTheDocument()
    await btn.click()

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'mock_preset',
        preset: 'phone_cn',
        unique: true,
      })
    )
  })

  it('renders preset configuration and preview when mock_preset is configured', async () => {
    const spec: DataGeneratorSpec = {
      kind: 'mock_preset',
      preset: 'phone_cn',
      unique: true,
    }
    const onChange = vi.fn()
    const screen = await render(
      <GeneratorConfigEditor generator={spec} onChange={onChange} />
    )

    await expect.element(screen.getByText('智能动态生成器')).toBeInTheDocument()
    await expect.element(screen.getByText(/批次内全局唯一/)).toBeInTheDocument()
    await expect.element(screen.getByText('求值预览')).toBeInTheDocument()
  })

  it('allows removing generator via delete button', async () => {
    const spec: DataGeneratorSpec = {
      kind: 'mock_preset',
      preset: 'name_cn',
      unique: false,
    }
    const onChange = vi.fn()
    const screen = await render(
      <GeneratorConfigEditor generator={spec} onChange={onChange} />
    )

    const deleteBtn = screen.getByRole('button', { name: /移除生成器/ })
    await expect.element(deleteBtn).toBeInTheDocument()
    await deleteBtn.click()

    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})
