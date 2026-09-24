import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { ContextLists } from './context-lists'

describe('ContextLists', () => {
  it('列表默认只显示前 20 行，展开后看到其余行', async () => {
    const rows = Array.from({ length: 22 }, (_, index) => ({ name: `第${index + 1}项` }))
    const screen = await render(<ContextLists context={{ alerts: rows, title: '不是列表' }} />)
    expect(screen.container.textContent).toMatch(/→ alerts（列表，22 项）/)
    expect(screen.container.textContent).toMatch(/第1项/)
    expect(screen.container.textContent).not.toMatch(/第21项/)
    await screen.getByRole('button', { name: '展开其余 2 行' }).click()
    expect(screen.container.textContent).toMatch(/第21项/)
    expect(screen.container.textContent).toMatch(/第22项/)
  })
})
