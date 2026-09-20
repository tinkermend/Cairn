import {
  CAPABILITY_GROUP_LABELS,
  CONSOLE_CAPABILITIES,
  SYSTEM_ROLE_DEFINITIONS,
  previewCapabilities,
  type CapabilityGroup,
} from '@cairn/shared'
import { describe, expect, it } from 'vitest'
import type { AuthUser } from '@/stores/auth-store'
import { filterNavItems } from '@/lib/rbac'
import { personalSettingsGroup, personalSettingsNav, sidebarData } from './sidebar-data'

function user(permissions: readonly string[]): AuthUser {
  return { id: 'u1', displayName: '测试', email: null, roles: [], permissions: [...permissions] }
}

function visibleTitles(group: CapabilityGroup, subject: AuthUser) {
  const nav = group === 'other'
    ? personalSettingsGroup
    : sidebarData.navGroups.find((item) => item.title === (group === 'overview' ? '' : CAPABILITY_GROUP_LABELS[group]))!
  return filterNavItems(nav.items, subject).map((item) => item.title)
}

describe('侧栏导航', () => {
  it('编写、执行、目标资源与平台管理分别组织，个人设置移到账户菜单', () => {
    expect(sidebarData.navGroups.map((group) => group.title)).toEqual([
      '', '场景编排', '执行与结果', '目标资源', '平台运维', '平台管理',
    ])
    expect(sidebarData.navGroups.flatMap((group) => group.items).some((item) => item.title === '个人设置')).toBe(false)
    expect(personalSettingsNav.items.map((item) => item.title)).toEqual(['个人资料', '修改密码'])
  })

  it('角色能力预览与实际导航逐组一致，包括个人设置', () => {
    for (const role of Object.values(SYSTEM_ROLE_DEFINITIONS)) {
      const subject = user(role.permissions)
      const preview = previewCapabilities(subject.permissions)
      for (const group of Object.keys(preview.menus) as CapabilityGroup[]) {
        expect(visibleTitles(group, subject), `${role.key} / ${group}`).toEqual(preview.menus[group])
      }
    }
  })

  it('移动入口不扩大权限：凭据仍需目标读取权限，运维不等于管理权限', () => {
    expect(visibleTitles('resources', user(['credential:read']))).toEqual([])
    expect(visibleTitles('resources', user(['credential:read', 'target:read']))).toEqual(['目标系统', '目标账号凭据'])
    expect(visibleTitles('operations', user(['session:read']))).toEqual(['执行节点'])
    expect(visibleTitles('operations', user(['monitor:read']))).toEqual(['平台监控'])
    expect(visibleTitles('governance', user(SYSTEM_ROLE_DEFINITIONS.operator.permissions))).toEqual([])
    expect(visibleTitles('other', user([]))).toEqual([])
    expect(visibleTitles('other', user(['settings:read']))).toEqual(['个人设置'])
  })

  it('审计入口允许操作审计或登录审计中的任一权限', () => {
    expect(visibleTitles('governance', user(['audit:read']))).toEqual(['审计日志'])
    expect(visibleTitles('governance', user(['audit:login']))).toEqual(['审计日志'])
    expect(visibleTitles('governance', user(['account:read']))).toEqual(['控制台用户'])
  })

  it('录制草稿和动作库各自保留写入与模块读取条件', () => {
    expect(visibleTitles('workbench', user(SYSTEM_ROLE_DEFINITIONS.operator.permissions))).not.toContain('录制草稿')
    expect(visibleTitles('workbench', user(SYSTEM_ROLE_DEFINITIONS.author.permissions))).toContain('录制草稿')
    expect(visibleTitles('workbench', user(['workflow:read']))).not.toContain('动作库')
    expect(visibleTitles('workbench', user(['module:read']))).toEqual(['动作库'])
  })

  it('每个导航入口与能力地图的权限契约一致，且没有丢失入口', () => {
    const menus = CONSOLE_CAPABILITIES.filter((item) => item.kind === 'menu')
    const navigation = [...sidebarData.navGroups, personalSettingsGroup].flatMap((group) => group.items)
    expect(navigation.map((item) => item.title).sort()).toEqual(menus.map((item) => item.label).sort())
    for (const item of navigation) {
      const capability = menus.find((menu) => menu.label === item.title)!
      if (item.anyOf?.length) {
        expect(item.anyOf).toEqual(capability.anyOf)
      } else if (item.permission) {
        expect(capability.allOf).toEqual(item.permission === 'credential:read'
          ? ['credential:read', 'target:read']
          : [item.permission])
      } else {
        expect(capability.id).toBe('menu.home')
        expect(capability.allOf).toEqual([])
      }
    }
  })
})
