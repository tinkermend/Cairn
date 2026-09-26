import { describe, expect, it } from 'vitest'
import { MENU_CATALOG, getMenuItem, requireMenuItem } from '../menus.js'
import { ASSISTANT_GUIDE_CATALOG } from '../assistant.js'
import { capabilityById } from '../rbac.js'

describe('MENU_CATALOG and routing consistency', () => {
  it('every menu in MENU_CATALOG has unique id and valid route', () => {
    const ids = new Set<string>()
    const routes = new Set<string>()

    for (const item of MENU_CATALOG) {
      expect(ids.has(item.id)).toBe(false)
      ids.add(item.id)
      expect(item.route.startsWith('/')).toBe(true)
      if (item.id === 'menu.evidence') {
        // menu.evidence 已在侧栏与能力地图中收归「运行记录」，保留契约仅用于深链重定向
        continue
      }
      // Check that RBAC capability exists
      const cap = capabilityById(item.id)
      expect(cap).toBeDefined()
      expect(cap.kind).toBe('menu')
    }
  })

  it('getMenuItem and requireMenuItem work properly', () => {
    const item = getMenuItem('menu.scenarios')
    expect(item).toBeDefined()
    expect(item?.route).toBe('/scenarios')
    expect(requireMenuItem('menu.scenarios').title).toBe('场景编排')
    expect(() => requireMenuItem('menu.nonexistent')).toThrow('未知菜单项 ID')
  })

  it('evidence entry in ASSISTANT_GUIDE_CATALOG points to /evidence', () => {
    const evidenceGuide = ASSISTANT_GUIDE_CATALOG.find((g) => g.topic === 'evidence')
    expect(evidenceGuide).toBeDefined()
    expect(evidenceGuide?.href).toBe('/evidence')
    expect(evidenceGuide?.capabilityId).toBe('menu.evidence')
  })
})
