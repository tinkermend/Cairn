import { beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Can } from './can'
import { useAuthStore } from '@/stores/auth-store'

describe('Can', () => {
  beforeEach(() => {
    useAuthStore.getState().auth.reset()
  })

  it('没有登录主体时隐藏 children', async () => {
    const { getByText } = await render(
      <Can permission='role:write' fallback={<span>hidden</span>}>
        <button type='button'>Create role</button>
      </Can>
    )
    await expect.element(getByText('hidden')).toBeInTheDocument()
    await expect.element(getByText('Create role')).not.toBeInTheDocument()
  })

  it('有权限时渲染 children', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'a',
      displayName: 'Admin',
      email: null,
      roles: ['admin'],
      permissions: ['role:write'],
    })
    const { getByText } = await render(
      <Can permission='role:write'>
        <button type='button'>Create role</button>
      </Can>
    )
    await expect.element(getByText('Create role')).toBeInTheDocument()
  })

  it('缺权限时渲染 fallback', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'v',
      displayName: 'Viewer',
      email: null,
      roles: ['viewer'],
      permissions: ['role:read'],
    })
    const { getByText } = await render(
      <Can permission='role:write' fallback={<span>hidden</span>}>
        <button type='button'>Create role</button>
      </Can>
    )
    await expect.element(getByText('hidden')).toBeInTheDocument()
    await expect.element(getByText('Create role')).not.toBeInTheDocument()
  })

  it('allOf 缺一项时隐藏', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'o',
      displayName: 'Ops',
      email: null,
      roles: ['custom'],
      permissions: ['run:execute'],
    })
    const { getByText } = await render(
      <Can allOf={['run:execute', 'target:read', 'workflow:read']} fallback={<span>hidden</span>}>
        <button type='button'>创建运行</button>
      </Can>,
    )
    await expect.element(getByText('hidden')).toBeInTheDocument()
    await expect.element(getByText('创建运行')).not.toBeInTheDocument()
  })

  it('allOf 齐备时渲染 children', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'o',
      displayName: 'Ops',
      email: null,
      roles: ['operator'],
      permissions: ['run:execute', 'target:read', 'workflow:read'],
    })
    const { getByText } = await render(
      <Can allOf={['run:execute', 'target:read', 'workflow:read']}>
        <button type='button'>创建运行</button>
      </Can>,
    )
    await expect.element(getByText('创建运行')).toBeInTheDocument()
  })
})
