import { useState } from 'react'
import type { JsonValue } from '@cairn/shared'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { KeyValueEditor } from './key-value-editor'
import { MemberInputDialog } from './member-input-dialog'
import '@/styles/index.css'

function ControlledKeyValueEditor({ initial }: { initial: Record<string, JsonValue> }) {
  const [val, setVal] = useState<Record<string, JsonValue>>(initial)
  return (
    <div>
      <KeyValueEditor value={val} onChange={setVal} />
      <div data-testid='result'>{JSON.stringify(val)}</div>
    </div>
  )
}

describe('KeyValueEditor & MemberInputDialog 参数编排增强组件', () => {
  it('仅在字符串参数中插入前序输出，并保留数字参数类型', async () => {
    function Fixture() {
      const [val, setVal] = useState<Record<string, JsonValue>>({ token: '前缀', count: 3 })
      return <><KeyValueEditor value={val} onChange={setVal} referenceOptions={[{ value: '${stage[s1].members[m1].output.summary}', label: '第一阶段业务结论', description: '前序输出' }]} /><output data-testid='stage-input'>{JSON.stringify(val)}</output></>
    }
    await render(<Fixture />)
    await page.getByRole('button', { name: '插入输出' }).click()
    await page.getByRole('option', { name: /第一阶段业务结论/ }).click()
    await expect.element(page.getByTestId('stage-input')).toHaveTextContent('"count":3')
    await expect.element(page.getByTestId('stage-input')).toHaveTextContent('stage[s1].members[m1].output.summary')
  })
  it('支持键值对增删改，并自动识别数字、布尔与普通字符串类型', async () => {
    await render(<ControlledKeyValueEditor initial={{ region: 'cn-north-1', count: 10 }} />)

    const key1 = page.getByLabelText('参数名 1')
    const val1 = page.getByLabelText('参数值 1')
    await expect.element(key1).toHaveValue('region')
    await expect.element(val1).toHaveValue('cn-north-1')

    const key2 = page.getByLabelText('参数名 2')
    const val2 = page.getByLabelText('参数值 2')
    await expect.element(key2).toHaveValue('count')
    await expect.element(val2).toHaveValue('10')

    // Add a new row
    const addBtn = page.getByRole('button', { name: '添加参数' })
    await addBtn.click()

    const newKeyInput = page.getByLabelText('参数名 3')
    await newKeyInput.fill('isEnabled')

    const newValueInput = page.getByLabelText('参数值 3')
    await newValueInput.fill('true')

    await expect.element(page.getByTestId('result')).toHaveTextContent('"isEnabled":true')
    await expect.element(page.getByTestId('result')).toHaveTextContent('"count":10')
  })

  it('支持切换至原始 JSON 模式编辑', async () => {
    await render(<ControlledKeyValueEditor initial={{ foo: 'bar' }} />)

    const switchBtn = page.getByRole('button', { name: '转为 JSON' })
    await switchBtn.click()

    await expect.element(page.getByRole('button', { name: '转为表格' })).toBeVisible()
  })

  it('MemberInputDialog: 正确弹出并保存成员参数独立覆盖', async () => {
    const handleSave = vi.fn()
    const member = {
      memberId: 'm1',
      ordinal: 0,
      scenarioId: '22222222-2222-4222-8222-222222222222',
      scenarioVersionId: '22222222-2222-4222-8222-222222222223',
      displayName: '子场景A',
      input: { customKey: 'valA' },
    }

    await render(
      <MemberInputDialog
        open={true}
        onOpenChange={() => {}}
        member={member}
        onSave={handleSave}
      />,
    )

    await expect.element(page.getByText('成员参数覆盖 · 子场景A')).toBeVisible()
    await expect.element(page.getByLabelText('参数名 1')).toHaveValue('customKey')
    await expect.element(page.getByLabelText('参数值 1')).toHaveValue('valA')

    const saveBtn = page.getByRole('button', { name: '保存覆盖' })
    await saveBtn.click()

    expect(handleSave).toHaveBeenCalledWith('m1', expect.objectContaining({ customKey: 'valA' }))
  })

  it('MemberInputDialog: 长标题与复杂参数下弹窗排版整洁无溢出', async () => {
    const member = {
      memberId: 'm_stress',
      ordinal: 1,
      scenarioId: 'sc-stress-01',
      scenarioVersionId: '00000000-0000-0000-0000-000000000001',
      displayName: 'modelapi中转站-API限流与高频压测异常检测',
      input: {
        rateLimit: '100req/s',
        alertThreshold: 0.05,
      },
    }

    await render(
      <MemberInputDialog
        open={true}
        onOpenChange={() => {}}
        member={member}
        onSave={() => {}}
      />,
    )
    await page.viewport(1440, 900)

    await expect.element(page.getByText('成员参数覆盖 · modelapi中转站-API限流与高频压测异常检测')).toBeVisible()
    await page.screenshot({ path: '__screenshots__/member-input-dialog-preview.png' })
  })

  it('MemberInputDialog: 切换至 JSON 模式下排版整洁无溢出', async () => {
    const member = {
      memberId: 'm_stress',
      ordinal: 1,
      scenarioId: 'sc-stress-01',
      scenarioVersionId: '00000000-0000-0000-0000-000000000001',
      displayName: 'modelapi中转站-API限流与高频压测异常检测',
      input: {
        rateLimit: '100req/s',
        alertThreshold: 0.05,
      },
    }

    await render(
      <MemberInputDialog
        open={true}
        onOpenChange={() => {}}
        member={member}
        onSave={() => {}}
      />,
    )
    await page.viewport(1440, 900)

    const jsonBtn = page.getByRole('button', { name: '转为 JSON' })
    await jsonBtn.click()

    await expect.element(page.getByText('原始 JSON 格式编辑')).toBeVisible()
    await page.screenshot({ path: '__screenshots__/member-input-dialog-json-preview.png' })
  })
})
