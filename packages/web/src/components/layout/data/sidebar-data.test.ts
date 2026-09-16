import {
  CONSOLE_CAPABILITIES,
  SYSTEM_ROLE_DEFINITIONS,
  previewCapabilities,
  type PermissionCode,
} from '@cairn/shared'
import { describe, expect, it } from 'vitest'
import type { AuthUser } from '@/stores/auth-store'
import { filterNavItems } from '@/lib/rbac'
import { sidebarData } from './sidebar-data'

const workbench = sidebarData.navGroups.find(
  (group) => group.title === '工作台'
)!
const governance = sidebarData.navGroups.find(
  (group) => group.title === '治理'
)!

function user(permissions: string[]): AuthUser {
  return { id: 'u1', displayName: '测试', email: null, roles: [], permissions }
}

function visibleTitles(
  group: (typeof sidebarData.navGroups)[number],
  subject: AuthUser | null
) {
  return filterNavItems(group.items, subject).flatMap((item) => [
    item.title,
    ...(item.items?.map((child) => child.title) ?? []),
  ])
}

describe('侧栏导航', () => {
  it('工作台只放业务入口，录制草稿要 write', () => {
    expect(workbench.items.map((item) => item.title)).toEqual([
      '首页',
      '目标系统',
      '浏览器会话',
      '场景',
      '动作库',
      '录制草稿',
      '运行',
      '自动复查',
    ])
    expect(
      workbench.items.find((item) => item.title === '录制草稿')?.permission
    ).toBe('workflow:write')
    expect(workbench.items.some((item) => item.title === '用户')).toBe(false)
  })

  it('治理组按权限显隐，无治理权限时整组为空', () => {
    expect(governance.items.map((item) => item.title)).toEqual([
      '用户',
      '角色',
      '开放服务',
      '平台配置',
      '执行节点',
      '审计',
    ])
    const audit = governance.items.find((item) => item.title === '审计')
    expect(audit && 'url' in audit ? audit.url : undefined).toBe('/audit')
    expect(audit && 'items' in audit ? audit.items : undefined).toBeUndefined()
    expect(audit && 'anyOf' in audit ? audit.anyOf : undefined).toEqual([
      'audit:read',
      'audit:login',
    ])
    expect(
      visibleTitles(
        governance,
        user(['target:read', 'workflow:read', 'run:read'])
      )
    ).toEqual([])
    expect(visibleTitles(governance, user(['account:read']))).toEqual(['用户'])
    expect(visibleTitles(governance, user(['audit:read']))).toEqual(['审计'])
    expect(visibleTitles(governance, user(['audit:login']))).toEqual(['审计'])
  })

  it('执行者只见业务与设置，不见录制；治理仅见执行节点', () => {
    const operator = user([...SYSTEM_ROLE_DEFINITIONS.operator.permissions])
    expect(visibleTitles(workbench, operator)).toEqual([
      '首页',
      '目标系统',
      '浏览器会话',
      '场景',
      '动作库',
      '运行',
      '自动复查',
    ])
    expect(visibleTitles(governance, operator)).toEqual(['执行节点'])
  })

  it('编写者能看见录制草稿', () => {
    const author = user([...SYSTEM_ROLE_DEFINITIONS.author.permissions])
    expect(visibleTitles(workbench, author)).toContain('录制草稿')
    expect(visibleTitles(governance, author)).toEqual(['执行节点'])
  })

  it('动作库需要模块读取权限', () => {
    expect(
      visibleTitles(workbench, user(['target:read', 'workflow:read']))
    ).not.toContain('动作库')
    expect(
      visibleTitles(workbench, user(['target:read', 'module:read']))
    ).toContain('动作库')
  })

  it('带 permission 的侧栏项能在能力地图找到相同 allOf；首页是唯一例外', () => {
    const menus = CONSOLE_CAPABILITIES.filter((item) => item.kind === 'menu')
    for (const group of sidebarData.navGroups) {
      for (const item of group.items) {
        if (item.anyOf?.length) {
          const required = item.anyOf
          const match = menus.find(
            (menu) =>
              menu.label === item.title &&
              menu.anyOf &&
              [...menu.anyOf].sort().join() === [...required].sort().join()
          )
          expect(match, `${item.title} 缺少 anyOf 能力地图`).toBeTruthy()
        } else if (item.permission) {
          const match = menus.find(
            (menu) =>
              menu.allOf.length === 1 && menu.allOf[0] === item.permission
          )
          expect(match, `${item.title} 缺少能力地图`).toBeTruthy()
        } else if (!item.items) {
          expect(item.title).toBe('首页')
        }
        for (const node of item.items ?? []) {
          if (!node.permission) {
            expect(group.title).toBe('其他')
            continue
          }
          const match = menus.find(
            (menu) =>
              menu.allOf.length === 1 && menu.allOf[0] === node.permission
          )
          expect(match, `${node.title} 缺少能力地图`).toBeTruthy()
        }
      }
    }
  })

  it('系统角色预览菜单与侧栏可见项一致（跳过首页）', () => {
    for (const key of ['author', 'operator', 'viewer'] as const) {
      const subject = user([...SYSTEM_ROLE_DEFINITIONS[key].permissions])
      const preview = previewCapabilities(subject.permissions)
      const sidebarMenus = [
        ...visibleTitles(workbench, subject).filter(
          (title) => title !== '首页'
        ),
        ...visibleTitles(governance, subject),
      ]
      const previewMenus = [
        ...preview.menus.workbench.filter((title) => title !== '首页'),
        ...preview.menus.governance,
      ]
      expect(previewMenus).toEqual(sidebarMenus)
      expect(preview.menus.other).toEqual(
        subject.permissions.includes('settings:read' as PermissionCode)
          ? ['设置']
          : []
      )
    }
  })

  it('工作台在目标系统之后出现浏览器会话', () => {
    const titles = workbench.items.map((item) => item.title)
    expect(titles.indexOf('浏览器会话')).toBe(titles.indexOf('目标系统') + 1)
    const sessions = workbench.items.find((item) => item.title === '浏览器会话')
    expect(sessions && 'url' in sessions ? sessions.url : null).toBe(
      '/sessions'
    )
  })
})
