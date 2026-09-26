import { describe, expect, it, vi } from 'vitest'
import { attachPageWithRetry, closeApplication } from '../attach-lifecycle'

describe('CRX 页面挂接恢复', () => {
  it('导航换掉 Frame 后释放失败的 debugger session，再重新初始化 Page', async () => {
    const calls: string[] = []
    const attach = vi.fn(async () => {
      calls.push('attach')
      if (attach.mock.calls.length === 1) throw new Error('Frame has been detached.')
    })
    const detach = vi.fn(async () => {
      calls.push('vendor detach')
      throw new Error('Frame has been detached.')
    })
    const forceDetach = vi.fn(async () => { calls.push('debugger detach') })
    const wait = vi.fn(async () => { calls.push('tab ready') })

    await attachPageWithRetry({ attach, detach }, 18, wait, forceDetach)

    expect(calls).toEqual(['attach', 'vendor detach', 'debugger detach', 'tab ready', 'attach'])
    expect(forceDetach).toHaveBeenCalledWith(18)
  })

  it('权限等持久错误立即返回，不会反复挂接或解除别的调试器', async () => {
    const attach = vi.fn(async () => { throw new Error('Another debugger is already attached') })
    const detach = vi.fn(async () => {})
    const forceDetach = vi.fn(async () => {})
    const wait = vi.fn(async () => {})

    await expect(attachPageWithRetry({ attach, detach }, 18, wait, forceDetach)).rejects.toThrow(
      'Another debugger is already attached',
    )
    expect(attach).toHaveBeenCalledOnce()
    expect(forceDetach).not.toHaveBeenCalled()
  })

  it('目标 Frame 一直消失时最多尝试三次，最终将错误返回给面板', async () => {
    const attach = vi.fn(async () => { throw new Error('Frame has been detached.') })
    const detach = vi.fn(async () => {})
    const forceDetach = vi.fn(async () => {})
    const wait = vi.fn(async () => {})

    await expect(attachPageWithRetry({ attach, detach }, 18, wait, forceDetach)).rejects.toThrow(
      'Frame has been detached',
    )
    expect(attach).toHaveBeenCalledTimes(3)
    expect(forceDetach).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })
})

describe('CRX 关闭恢复', () => {
  it('vendor close 在已脱离 Frame 上抛错，仍关闭 Context 让下次 start 可重建', async () => {
    const close = vi.fn(async () => { throw new Error('Frame has been detached.') })
    const contextClose = vi.fn(async () => {})
    await expect(closeApplication({ close, context: () => ({ close: contextClose }) })).resolves.toBeUndefined()
    expect(contextClose).toHaveBeenCalledOnce()
  })

  it('两层关闭都失败时保留原始错误', async () => {
    const error = new Error('Frame has been detached.')
    await expect(closeApplication({
      close: async () => { throw error },
      context: () => ({ close: async () => { throw new Error('context failed') } }),
    })).rejects.toBe(error)
  })

  it('hide 与错误清理同时发生时只关闭一次', async () => {
    let resolveClose!: () => void
    const close = vi.fn(() => new Promise<void>(resolve => { resolveClose = resolve }))
    const app = { close, context: () => ({ close: vi.fn(async () => {}) }) }
    const first = closeApplication(app)
    const second = closeApplication(app)
    expect(first).toBe(second)
    resolveClose()
    await Promise.all([first, second])
    expect(close).toHaveBeenCalledOnce()
  })
})
