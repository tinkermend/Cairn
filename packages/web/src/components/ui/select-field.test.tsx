import { useState } from 'react'
import '@/styles/index.css'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { MultiSelectField } from './multi-select-field'
import {
  Select,
  SelectContent,
  SelectField,
  SelectFieldOption,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select'

describe('公共选择字段', () => {
  it('空值可重新选择，数字零与带前缀的业务值不被改写', async () => {
    const changed = vi.fn()
    function Form() {
      const [value, setValue] = useState<string | number>('')
      return (
        <>
          <label htmlFor='choice'>目标</label>
          <SelectField
            id='choice'
            value={value}
            onValueChange={(next) => {
              setValue(next)
              changed(next)
            }}
          >
            <SelectFieldOption value=''>全部目标</SelectFieldOption>
            <SelectFieldOption value={0}>第零项</SelectFieldOption>
            <SelectFieldOption value='value:production'>
              生产环境
            </SelectFieldOption>
          </SelectField>
        </>
      )
    }
    await render(<Form />)
    const trigger = page.getByRole('combobox', { name: '目标', exact: true })
    await expect.element(trigger).toHaveTextContent('全部目标')
    expect(changed).not.toHaveBeenCalled()
    for (const [label, value] of [
      ['第零项', '0'],
      ['生产环境', 'value:production'],
      ['全部目标', ''],
    ]) {
      await trigger.click()
      await page.getByRole('option', { name: label, exact: true }).click()
      await expect.element(trigger).toHaveTextContent(label!)
      expect(changed).toHaveBeenLastCalledWith(value)
    }
  })

  it('键盘跳过禁用选项，Escape 保留原值并返回焦点，联动重置不会触发回调', async () => {
    const changed = vi.fn()
    function Form() {
      const [value, setValue] = useState('first')
      return (
        <>
          <label htmlFor='keyboard-choice'>选择步骤</label>
          <SelectField
            id='keyboard-choice'
            value={value}
            onValueChange={(next) => {
              setValue(next)
              changed(next)
            }}
          >
            <SelectFieldOption value='first'>第一步</SelectFieldOption>
            <SelectFieldOption value='disabled' disabled>
              已停用
            </SelectFieldOption>
            <SelectFieldOption value='last'>最后一步</SelectFieldOption>
          </SelectField>
          <button onClick={() => setValue('first')}>切换上级对象</button>
        </>
      )
    }
    await render(<Form />)
    const trigger = page.getByRole('combobox', {
      name: '选择步骤',
      exact: true,
    })
    await trigger.click()
    await expect
      .element(page.getByRole('option', { name: '第一步', exact: true }))
      .toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect
      .element(page.getByRole('option', { name: '最后一步', exact: true }))
      .toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(changed).toHaveBeenLastCalledWith('last')
    await trigger.click()
    await userEvent.keyboard('{Home}')
    await expect
      .element(page.getByRole('option', { name: '第一步', exact: true }))
      .toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(trigger).toHaveTextContent('最后一步')
    await expect.element(trigger).toHaveFocus()
    expect(changed).toHaveBeenCalledTimes(1)
    await page.getByRole('button', { name: '切换上级对象' }).click()
    await expect.element(trigger).toHaveTextContent('第一步')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('继承 fieldset 禁用状态', async () => {
    const changed = vi.fn()
    await render(
      <fieldset disabled>
        <label htmlFor='disabled-choice'>通知条件</label>
        <SelectField id='disabled-choice' value='all' onValueChange={changed}>
          <SelectFieldOption value='all'>全部结果</SelectFieldOption>
        </SelectField>
      </fieldset>
    )
    await expect
      .element(page.getByRole('combobox', { name: '通知条件', exact: true }))
      .toBeDisabled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('异步选项加载前显示占位文字，加载后不会擅自选择第一项', async () => {
    const changed = vi.fn()
    function Form() {
      const [loaded, setLoaded] = useState(false)
      return (
        <>
          <SelectField
            aria-label='异步目标'
            value=''
            onValueChange={changed}
            placeholder='请选择目标'
          >
            {loaded ? (
              <>
                <SelectFieldOption value=''>全部目标</SelectFieldOption>
                <SelectFieldOption value='first'>首个目标</SelectFieldOption>
              </>
            ) : null}
          </SelectField>
          <button onClick={() => setLoaded(true)}>加载选项</button>
        </>
      )
    }
    await render(<Form />)
    const trigger = page.getByRole('combobox', {
      name: '异步目标',
      exact: true,
    })
    await expect.element(trigger).toHaveTextContent('请选择目标')
    await page.getByRole('button', { name: '加载选项' }).click()
    await expect.element(trigger).toHaveTextContent('全部目标')
    expect(changed).not.toHaveBeenCalled()
  })

  it('带 name 的 Select 按原始业务值参与 FormData 提交', async () => {
    const submitted = vi.fn()
    await render(
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submitted(new FormData(event.currentTarget).get('tls'))
        }}
      >
        <label htmlFor='tls-choice'>传输加密</label>
        <Select name='tls' defaultValue='starttls'>
          <SelectTrigger id='tls-choice'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='starttls'>STARTTLS</SelectItem>
            <SelectItem value='tls'>TLS</SelectItem>
          </SelectContent>
        </Select>
        <button type='submit'>保存</button>
      </form>
    )
    await page.getByRole('button', { name: '保存', exact: true }).click()
    expect(submitted).toHaveBeenLastCalledWith('starttls')
    await page.getByRole('combobox', { name: '传输加密', exact: true }).click()
    await page.getByRole('option', { name: 'TLS', exact: true }).click()
    await page.getByRole('button', { name: '保存', exact: true }).click()
    expect(submitted).toHaveBeenLastCalledWith('tls')
  })

  it('多选可连续选择、取消及清空，关闭后焦点返回字段', async () => {
    const changed = vi.fn()
    function Form() {
      const [value, setValue] = useState<string[]>([])
      return (
        <>
          <label htmlFor='sources'>来源场景</label>
          <MultiSelectField
            id='sources'
            value={value}
            placeholder='全部场景'
            onValueChange={(next) => {
              setValue(next)
              changed(next)
            }}
            options={[
              { value: 'orders', label: '订单核对' },
              { value: 'stock', label: '库存核对' },
              { value: 'retired', label: '已停用', disabled: true },
            ]}
          />
        </>
      )
    }
    await render(<Form />)
    const trigger = page.getByRole('button', { name: '来源场景', exact: true })
    await trigger.click()
    await page
      .getByRole('menuitemcheckbox', { name: '订单核对', exact: true })
      .click()
    await page
      .getByRole('menuitemcheckbox', { name: '库存核对', exact: true })
      .click()
    expect(changed).toHaveBeenLastCalledWith(['orders', 'stock'])
    await expect
      .element(
        page.getByRole('menuitemcheckbox', { name: '已停用', exact: true })
      )
      .toHaveAttribute('aria-disabled', 'true')
    await page
      .getByRole('menuitemcheckbox', { name: '订单核对', exact: true })
      .click()
    expect(changed).toHaveBeenLastCalledWith(['stock'])
    await userEvent.keyboard('{Escape}')
    await expect.element(trigger).toHaveFocus()
    await expect.element(trigger).toHaveTextContent('库存核对')
    await trigger.click()
    await page
      .getByRole('menuitemcheckbox', { name: '库存核对', exact: true })
      .click()
    expect(changed).toHaveBeenLastCalledWith([])
    await userEvent.keyboard('{Escape}')
    await expect.element(trigger).toHaveTextContent('全部场景')
  })
})
