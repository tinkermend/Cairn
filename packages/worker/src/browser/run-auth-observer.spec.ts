import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { targetAuthProfileDefinitionSchema } from '@cairn/shared'
import { observeRunAuthPage } from './run-auth-observer'
function page() {
  const p = new EventEmitter() as any
  p.address = 'https://app.example/orders'
  p.url = () => p.address
  p.locator = vi.fn(() => ({ first: () => ({ isVisible: async () => false }) }))
  return p
}
it('完全静置且不在登录页时不发信号', async () => {
  const p = page(), signal = vi.fn()
  const observer = observeRunAuthPage({ page: p, loginUrl: 'https://app.example/login', onSignal: signal })
  await observer.inspect()
  expect(signal).not.toHaveBeenCalled()
  observer.dispose()
})

it('被动跳转立即关门且 URL 不携带令牌', () => {
  const p = page(), signal = vi.fn()
  const observer = observeRunAuthPage({ page: p, loginUrl: 'https://app.example/login', onSignal: signal })
  p.address = 'https://app.example/login?token=secret'; p.emit('framenavigated')
  expect(signal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'navigated_to_login', summary: 'https://app.example/login' }))
  observer.dispose(); p.emit('framenavigated'); expect(signal).toHaveBeenCalledTimes(1)
})
it('仅冻结的认证端点失效响应触发；普通 401 不触发，不主动请求', async () => {
  const p = page(), signal = vi.fn()
  const definition = targetAuthProfileDefinitionSchema.parse({ verify: { mode: 'http', path: '/auth', success: { status: 200 }, failure: { status: 401 } }, scope: { origins: ['https://app.example'], pathPrefixes: ['/auth'] }, renew: 'none' })
  const observer = observeRunAuthPage({ page: p, definition, onSignal: signal })
  p.emit('response', { url: () => 'https://app.example/orders', status: () => 401 })
  await observer.inspect(); expect(signal).not.toHaveBeenCalled()
  p.emit('response', { url: () => 'https://app.example/auth', status: () => 401 })
  await observer.inspect(); expect(signal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'auth_endpoint_expired' }))
  observer.dispose()
})
it('页面失效定位只读取当前 DOM', async () => {
  const p = page(), signal = vi.fn()
  p.locator.mockReturnValue({ first: () => ({ isVisible: async () => true }) })
  const definition = targetAuthProfileDefinitionSchema.parse({ verify: { mode: 'page', path: '/auth', success: { locator: { by: 'css', value: '.user' } }, failure: { locator: { by: 'id', value: 'login' } } }, scope: { origins: ['https://app.example'], pathPrefixes: ['/auth'] }, renew: 'none' })
  const observer = observeRunAuthPage({ page: p, definition, onSignal: signal })
  await observer.inspect(); expect(signal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'login_form_visible' })); observer.dispose()
})
