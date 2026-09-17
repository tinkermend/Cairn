import { describe, expect, it, beforeEach } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { readCursorPageState, useCursorPage } from './use-cursor-page'

describe('readCursorPageState', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('把 JSON 序列化后的 null 空游标读成首页', () => {
    sessionStorage.setItem(
      'sessions-list',
      JSON.stringify({ pageIndex: 0, cursors: [null], pageSize: 20 }),
    )
    const saved = readCursorPageState('sessions-list', 20)
    expect(saved.pageIndex).toBe(0)
    expect(saved.cursors[0]).toBeUndefined()
    expect(saved.pageSize).toBe(20)
  })

  it('当前页缺少游标时退回首页', () => {
    sessionStorage.setItem('page', JSON.stringify({ pageIndex: 2, cursors: ['abc', null], pageSize: 10 }))
    const saved = readCursorPageState('page', 20)
    expect(saved.pageIndex).toBe(0)
    expect(saved.pageSize).toBe(10)
  })
})

describe('useCursorPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('恢复已写入的 null 游标后仍返回 undefined', async () => {
    sessionStorage.setItem(
      'sessions-list',
      JSON.stringify({ pageIndex: 0, cursors: [null], pageSize: 20 }),
    )
    const { result } = await renderHook(() => useCursorPage(20, 'sessions-list'))
    expect(result.current.cursor).toBeUndefined()
    expect(result.current.pageIndex).toBe(0)
  })
})
