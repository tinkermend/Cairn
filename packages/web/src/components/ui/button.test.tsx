import { useState } from 'react'
import '@/styles/index.css'
import { Check } from 'lucide-react'
import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Button } from './button'

function Sample({ icon }: { icon: boolean }) {
  const [loading, setLoading] = useState(false)
  return (
    <Button loading={loading} onClick={() => setLoading(true)}>
      {icon ? <Check /> : null}保存草稿
    </Button>
  )
}

it.each([true, false])(
  '加载保持按钮宽度、名称与禁用语义（图标：%s）',
  async (icon) => {
    const screen = await render(<Sample icon={icon} />)
    const button = screen.getByRole('button', { name: '保存草稿' })
    const width = button.element().getBoundingClientRect().width
    expect(getComputedStyle(button.element()).display).toBe('inline-flex')
    await button.click()
    await expect.element(button).toHaveAttribute('aria-busy', 'true')
    await expect.element(button).toBeDisabled()
    expect(button.element().getBoundingClientRect().width).toBe(width)
    expect(
      getComputedStyle(
        button.element().querySelector('[data-slot="button-label"]')!
      ).opacity
    ).toBe('0')
  }
)
