import { describe, expect, it } from 'vitest'
import { mapConditionSnapshot } from '@cairn/shared'
import { applyCollectedSurface, collectAuthorizedSurface, isHardSurfaceGap } from './surface-collect.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const accountId = '66666666-6666-4666-8666-666666666666'

function capability() {
  return { frames: 'ok' as const, a11y: 'unknown' as const, canvas: 'unknown' as const, shadow: 'unknown' as const }
}

describe('规则化表面采集', () => {
  it('空白页与导航变化是硬缺口，未授权 Frame 不是', () => {
    expect(isHardSurfaceGap('NOT_APPLICABLE')).toBe(true)
    expect(isHardSurfaceGap('SURFACE_CHANGED')).toBe(true)
    expect(isHardSurfaceGap('CAPABILITY_MISSING')).toBe(false)
    expect(isHardSurfaceGap('TRUNCATED')).toBe(false)
  })

  it('把标题/地标写成可被投影消费的语义谓词', () => {
    const fields = applyCollectedSurface({
      collected: {
        title: '总览_智慧运维管理平台',
        heading: '总览',
        locale: 'zh-CN',
        viewport: { category: 'desktop', widthPx: 1440, heightPx: 900 },
        ready: true,
        empty: false,
        loading: false,
        nodeCount: 4,
        truncated: false,
        closedShadow: false,
        canvas: false,
        landmarks: [{ role: 'navigation', name: '侧栏' }, { role: 'main', name: 'main' }],
        named: [{ role: 'menuitem', name: '总览' }, { role: 'link', name: '告警' }],
      },
      condition: mapConditionSnapshot({ targetId, targetAccountId: accountId }),
      capability: capability(),
      stateSummary: { regions: { page: { ready: true } } },
    })
    expect(fields.semanticSummary.predicates).toEqual(
      expect.arrayContaining([
        { name: 'role', value: 'document' },
        { name: 'label', value: '总览_智慧运维管理平台' },
        { name: 'title', value: '总览_智慧运维管理平台' },
        { name: 'heading', value: '总览' },
        { name: 'namedCount', value: 2 },
      ]),
    )
    expect(fields.regionRefs.map((item) => item.key)).toEqual(['navigation', 'main'])
    expect(fields.conditionSnapshot.locale).toBe('zh-CN')
    expect(fields.conditionSnapshot.viewport?.category).toBe('desktop')
    expect(fields.conditionSnapshot.unknownFields).not.toContain('locale')
    expect(fields.structuralSummary.nodeCount).toBe(4)
    expect(fields.structuralSummary.truncated).toBe(false)
    expect(fields.surfaceCapability.a11y).toBe('ok')
  })

  it('canvas 或采集失败只记能力缺口，仍保留页面身份', () => {
    const fields = applyCollectedSurface({
      collected: {
        title: '订单',
        heading: '',
        locale: '',
        ready: true,
        empty: false,
        loading: false,
        nodeCount: 1,
        truncated: false,
        closedShadow: false,
        canvas: true,
        landmarks: [],
        named: [],
      },
      condition: mapConditionSnapshot({ targetId }),
      capability: capability(),
      stateSummary: { regions: {} },
      framesBlocked: true,
    })
    expect(fields.missingReasons).toEqual(['CAPABILITY_MISSING'])
    expect(fields.semanticSummary.predicates).toContainEqual({ name: 'label', value: '订单' })
    expect(fields.surfaceCapability.canvas).toBe('unsupported')
    expect(fields.regionRefs).toEqual([{ key: 'main', kind: 'region' }])
  })

  it('子菜单只取标题，不把子项粘成名字', () => {
    const text = (value: string) => ({ nodeType: 3, textContent: value })
    const el = (
      tag: string,
      attrs: Record<string, string> = {},
      children: unknown[] = [],
    ) => {
      const node: Record<string, unknown> = {
        tagName: tag,
        className: attrs.className ?? '',
        childNodes: [] as unknown[],
        children: [] as unknown[],
        getAttribute: (name: string) => attrs[name] ?? null,
      }
      const kids = children as Array<Record<string, unknown>>
      node.childNodes = kids
      node.children = kids.filter((item) => item.nodeType !== 3)
      node.childElementCount = (node.children as unknown[]).length
      node.textContent = kids
        .map((item) => (item.nodeType === 3 ? item.textContent : item.textContent))
        .join('')
      for (const child of node.children as Array<Record<string, unknown>>) {
        child.parent = node
      }
      return node
    }
    const submenu = el('LI', { role: 'menuitem', className: 'el-submenu' }, [
      el('DIV', { className: 'el-submenu__title' }, [
        el('I', { className: 'iconfont' }, []),
        el('SPAN', {}, [text('配置管理')]),
        el('I', { className: 'el-submenu__icon-arrow' }, []),
      ]),
      el('UL', { role: 'menu', className: 'el-menu el-menu--inline' }, [
        el('LI', { role: 'menuitem', className: 'el-menu-item' }, [el('SPAN', {}, [text('查询帮助')])]),
      ]),
    ])
    const user = el('DIV', { className: 'menuLiContainerItem' }, [text('退出登录')])
    const walk: unknown[] = []
    const collect = (node: Record<string, unknown>) => {
      walk.push(node)
      for (const child of (node.children as Array<Record<string, unknown>> | undefined) ?? []) collect(child)
    }
    collect(submenu)
    collect(user)
    const matches = (node: Record<string, unknown>, selector: string) => {
      const tag = String(node.tagName ?? '')
      const cls = String(node.className ?? '')
      const role = typeof node.getAttribute === 'function' ? node.getAttribute('role') : null
      if (selector === 'nav') return tag === 'NAV'
      if (selector.startsWith('[role="')) return role === selector.slice(7, -2)
      if (selector.startsWith('[class*="')) return cls.includes(selector.slice(9, -2))
      if (selector === 'a[href]') return tag === 'A' && Boolean(node.getAttribute?.('href'))
      if (selector === 'button') return tag === 'BUTTON'
      if (selector === 'h1' || selector === 'h2' || selector === 'h3') return tag === selector.toUpperCase()
      if (selector === 'header' || selector === 'main' || selector === 'aside' || selector === 'footer' || selector === 'form') {
        return tag === selector.toUpperCase()
      }
      return false
    }
    const document = {
      title: '页',
      readyState: 'complete',
      querySelector: () => null,
      querySelectorAll: (selector: string) => {
        const parts = selector.split(',').map((item) => item.trim())
        return walk.filter((node) => parts.some((part) => matches(node as Record<string, unknown>, part)))
      },
      getElementById: () => null,
    }
    const previous = {
      document: (globalThis as { document?: unknown }).document,
      getComputedStyle: (globalThis as { getComputedStyle?: unknown }).getComputedStyle,
      navigator: (globalThis as { navigator?: unknown }).navigator,
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    Object.defineProperty(globalThis, 'getComputedStyle', {
      configurable: true,
      value: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } })
    try {
      const collected = collectAuthorizedSurface(20)
      expect(collected.named).toEqual(
        expect.arrayContaining([
          { role: 'menuitem', name: '配置管理' },
          { role: 'menuitem', name: '查询帮助' },
          { role: 'menuitem', name: '退出登录' },
        ]),
      )
      expect(collected.named.some((item) => item.name.includes('配置管理') && item.name.includes('查询帮助'))).toBe(false)
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: previous.document })
      Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: previous.getComputedStyle })
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous.navigator })
    }
  })

  it('没有 document 时返回空表面，不抛错', () => {
    const collected = collectAuthorizedSurface(20)
    expect(collected).toMatchObject({
      title: '',
      heading: '',
      empty: true,
      nodeCount: 0,
      landmarks: [],
      named: [],
    })
  })
})
