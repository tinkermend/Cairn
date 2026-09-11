import { describe, expect, it } from 'vitest'
import type { AuthUser } from '@/stores/auth-store'
import { visibleByPermission } from '@/lib/rbac'
import { sidebarData } from './sidebar-data'

const workbench = sidebarData.navGroups.find((group) => group.title === '工作台')!

function user(permissions: string[]): AuthUser {
  return { id: 'u1', displayName: '测试', email: null, roles: [], permissions }
}

describe('侧栏导航', () => {
  /** 验收 31：两个新入口必须在工作台里，并各自带读权限。 */
  it('场景与运行在工作台内，且按读权限显隐', () => {
    const scenarios = workbench.items.find((item) => item.title === '场景')
    const runs = workbench.items.find((item) => item.title === '运行')
    expect(scenarios?.url).toBe('/scenarios')
    expect(scenarios?.permission).toBe('workflow:read')
    expect(runs?.url).toBe('/runs')
    expect(runs?.permission).toBe('run:read')

    const visible = visibleByPermission(workbench.items, user(['workflow:read', 'run:read']))
    expect(visible.map((item) => item.title)).toEqual(expect.arrayContaining(['场景', '运行']))

    // 没有读权限就看不见。真正的拒绝在 api，这里只是不给入口。
    // 首页不挂权限，所以只断言这两个入口消失，不断言整组为空。
    for (const subject of [user([]), null]) {
      const titles = visibleByPermission(workbench.items, subject).map((item) => item.title)
      expect(titles).not.toContain('场景')
      expect(titles).not.toContain('运行')
    }
  })

  /**
   * 验收 38：本期不做会话处置面。
   * 浏览器会话是执行面的资源，控制台给入口就等于暗示可以在这儿处置它。
   */
  it('不出现会话入口', () => {
    const titles = sidebarData.navGroups.flatMap((group) =>
      group.items.flatMap((item) => {
        const subs = Array.isArray(item.items) ? item.items : []
        return [item.title, ...subs.map((sub) => sub.title)]
      }),
    )
    expect(titles.filter((title) => title.includes('会话'))).toEqual([])
    expect(JSON.stringify(sidebarData)).not.toMatch(/sessions?|会话/)
  })
})
