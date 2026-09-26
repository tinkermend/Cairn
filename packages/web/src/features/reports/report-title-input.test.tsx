import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { ReportTitleInput } from './report-title-input'
import '@/styles/index.css'

function Fixture({ source = 'RUN' as const }: { source?: 'RUN' | 'SUITE_RUN' }) {
  const [value, setValue] = useState('')
  return <><ReportTitleInput value={value} onChange={setValue} source={source} optional /><output data-testid='title'>{value}</output></>
}

describe('ReportTitleInput', () => {
  it('输入大括号提供解释并在光标位置插入来源可用变量', async () => {
    await render(<Fixture />)
    const input = page.getByRole('combobox', { name: '报告标题' })
    await input.fill('报告 {')
    await expect.element(input).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByRole('listbox', { name: '标题变量' })).toBeVisible()
    await page.getByRole('option', { name: /目标系统名称/ }).click()
    await expect.element(page.getByTestId('title')).toHaveTextContent('报告 {systemName}')
    await expect.element(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('确定来源时不插入不适用变量', async () => {
    await render(<Fixture source='RUN' />)
    await page.getByRole('button', { name: '插入变量' }).click()
    await expect.element(page.getByRole('listbox', { name: '标题变量' })).toBeVisible()
    const suite = page.getByRole('option', { name: /场景集名称/ })
    await expect.element(suite).toHaveAttribute('aria-disabled', 'true')
    await expect.element(page.getByTestId('title')).toHaveTextContent('')
  })

  it('按钮重复点击保持候选可见，选中后插入到光标处', async () => {
    await render(<Fixture />)
    const input = page.getByRole('combobox', { name: '报告标题' })
    await input.fill('标题')
    await input.click()
    await userEvent.keyboard('{Home}{ArrowRight}')
    const button = page.getByRole('button', { name: '插入变量' })
    await button.click()
    await expect.element(button).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByRole('listbox', { name: '标题变量' })).toBeVisible()
    await button.click()
    await expect.element(page.getByRole('listbox', { name: '标题变量' })).toBeVisible()
    await page.getByRole('option', { name: /执行日期 / }).click()
    await expect.element(page.getByTestId('title')).toHaveTextContent('标{executedDate}题')
  })

  it('键盘候选替换文本中间的未完成表达式，Tab 保持正常离开', async () => {
    await render(<Fixture />)
    const input = page.getByRole('combobox', { name: '报告标题' })
    await input.fill('前后')
    await input.click()
    await userEvent.keyboard('{Home}{ArrowRight}')
    await userEvent.type(input, '{{')
    await expect.element(input).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expect.element(page.getByTestId('title')).toHaveTextContent('前{scenarioName}后')
    await userEvent.keyboard('{Tab}')
    await expect.element(input).toHaveAttribute('aria-expanded', 'false')
  })
})
