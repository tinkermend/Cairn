import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { PermissionMatrix } from './permission-matrix'

describe('PermissionMatrix', () => {
  it('groups catalog permissions by resource', async () => {
    const { getByText, getByLabelText } = await render(
      <PermissionMatrix value={['workflow:read']} onChange={vi.fn()} />
    )
    await expect.element(getByText('场景', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('控制台账号', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('目标系统', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('浏览器会话', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('浏览器 AI', { exact: true })).toBeInTheDocument()
    await expect.element(getByText('查看目标系统')).toBeInTheDocument()
    await expect.element(getByText('核查暂停的运行')).toBeInTheDocument()
    await expect.element(getByText('Target', { exact: true })).not.toBeInTheDocument()
    await expect.element(getByLabelText('workflow:read')).toBeChecked()
    await expect.element(getByLabelText('workflow:write')).not.toBeChecked()
  })

  it('toggles a permission via onChange', async () => {
    const onChange = vi.fn()
    const { getByLabelText } = await render(
      <PermissionMatrix value={['workflow:read']} onChange={onChange} />
    )
    await userEvent.click(getByLabelText('workflow:write'))
    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining(['workflow:read', 'workflow:write'])
    )
  })

  it('does not toggle when disabled', async () => {
    const onChange = vi.fn()
    const { getByLabelText } = await render(
      <PermissionMatrix
        value={['workflow:read']}
        onChange={onChange}
        disabled
      />
    )
    await expect.element(getByLabelText('workflow:write')).toBeDisabled()
  })
})
