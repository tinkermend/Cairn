import type { Page, Frame } from 'playwright'
import {
  computeControlFingerprint,
  sanitizeExplorationUrl,
  type ExplorationCandidate,
  type TargetDescriptor,
  type TargetStateRule,
} from '@cairn/shared'

export const UNSAFE_ACTION_PATTERN = /(提交|保存|删除|审批|支付|发布|上传|下载|导出|注销|退出|重启|重置|停止|启动|submit|save|delete|approve|pay|publish|upload|download|export|logout|signout|restart|reboot|reset|stop|shutdown)/i

export type RawCollectedElement = {
  role: string
  name: string
  ancestorPath: string[]
  href?: string
  ariaExpanded?: boolean
  ariaControls?: string
  ariaCurrent?: string
  ariaSelected?: boolean
  dataRoute?: string
  stableSelector?: string
  frameName?: string
}

export type RawSurfaceScan = {
  title: string
  headings: string[]
  breadcrumbs: string[]
  tabs: string[]
  openAncestorPaths: string[][]
  elements: RawCollectedElement[]
  truncated: boolean
}

export type ProcessedCandidate = {
  candidateId: string
  controlFingerprint: string
  candidateCategory: 'explicit_url' | 'reveal' | 'opaque_navigation'
  role: string
  accessibleName: string
  ancestorPath: string[]
  canonicalTargetUrl?: string
  targetDigest?: string
  targetDescriptor: TargetDescriptor
  frame: string
  stateHint?: string
  rejectionReason?: string
  eligible: boolean
}

export type SurfaceExplorationResult = {
  currentUrl: string
  title: string
  domSignals: {
    headings: string[]
    breadcrumbs: string[]
    tabs: string[]
  }
  openAncestorPaths: string[][]
  candidates: ProcessedCandidate[]
  truncated: boolean
  truncationReason?: string
  gaps: Array<{ kind: string; reason: string; frame?: string }>
}

/**
 * 自包含浏览器内提取函数（运行在页面 / Frame 上下文）。
 * 不点击、不滚动、不调用页面业务函数、不读取表单输入值。
 */
export function inBrowserScanSurface(maxElements: number): RawSurfaceScan {
  const g = globalThis as typeof globalThis & {
    document?: {
      title?: string
      readyState?: string
      querySelector: (selector: string) => unknown
      querySelectorAll: (selector: string) => Iterable<unknown>
    }
    getComputedStyle?: (el: unknown) => { display: string; visibility: string; opacity: string }
  }

  const doc = g.document
  if (!doc) {
    return {
      title: '',
      headings: [],
      breadcrumbs: [],
      tabs: [],
      openAncestorPaths: [],
      elements: [],
      truncated: false,
    }
  }

  const title = (doc.title || '').trim().slice(0, 200)

  const isVisible = (el: unknown): boolean => {
    if (!el || typeof el !== 'object') return false
    const elem = el as {
      getBoundingClientRect?: () => { width: number; height: number }
      tagName?: string
      type?: string
    }
    if (elem.type === 'password' || elem.type === 'hidden') return false
    if (g.getComputedStyle) {
      try {
        const style = g.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      } catch {
        return false
      }
    }
    if (typeof elem.getBoundingClientRect === 'function') {
      try {
        const rect = elem.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) return false
      } catch {
        return false
      }
    }
    return true
  }

  const attr = (el: unknown, name: string): string => {
    if (!el || typeof el !== 'object' || typeof (el as { getAttribute?: unknown }).getAttribute !== 'function') {
      return ''
    }
    const val = (el as { getAttribute: (k: string) => string | null }).getAttribute(name)
    return typeof val === 'string' ? val : ''
  }

  const accessibleName = (el: unknown): string => {
    const labelled = attr(el, 'aria-label') || attr(el, 'aria-placeholder') || attr(el, 'title')
    if (labelled) return labelled.trim().slice(0, 100)
    const elem = el as { textContent?: string | null }
    if (typeof elem.textContent === 'string') {
      return elem.textContent.replace(/\s+/g, ' ').trim().slice(0, 100)
    }
    return ''
  }

  const getAncestorMenuPath = (el: unknown): string[] => {
    const path: string[] = []
    let curr = (el as { parentElement?: unknown } | null)?.parentElement
    while (curr) {
      const c = curr as { parentElement?: unknown; tagName?: string }
      const role = attr(c, 'role').toLowerCase()
      const cls = attr(c, 'class').toLowerCase()
      if (
        role === 'menu' ||
        role === 'menubar' ||
        cls.includes('submenu') ||
        cls.includes('menu-item') ||
        cls.includes('nav-item')
      ) {
        // Find submenu title / header
        const titleEl = (curr as { querySelector?: (s: string) => unknown }).querySelector?.(
          '[class*="title"], [class*="header"], [role="heading"], .ant-menu-submenu-title, .el-sub-menu__title',
        )
        const name = titleEl ? accessibleName(titleEl) : ''
        if (name && !path.includes(name)) {
          path.unshift(name)
        }
      }
      curr = c.parentElement
    }
    return path
  }

  const headings: string[] = []
  for (const h of doc.querySelectorAll('h1,h2,h3,[role="heading"]')) {
    if (!isVisible(h)) continue
    const name = accessibleName(h)
    if (name && !headings.includes(name)) headings.push(name)
    if (headings.length >= 10) break
  }

  const breadcrumbs: string[] = []
  for (const b of doc.querySelectorAll('.breadcrumb, .ant-breadcrumb, .el-breadcrumb, [aria-label="breadcrumb"]')) {
    if (!isVisible(b)) continue
    const name = accessibleName(b)
    if (name && !breadcrumbs.includes(name)) breadcrumbs.push(name)
    if (breadcrumbs.length >= 5) break
  }

  const tabs: string[] = []
  for (const t of doc.querySelectorAll('[role="tab"], .ant-tabs-tab, .el-tabs__item')) {
    if (!isVisible(t)) continue
    const name = accessibleName(t)
    if (name && !tabs.includes(name)) tabs.push(name)
    if (tabs.length >= 10) break
  }

  const openAncestorPaths: string[][] = []
  for (const sub of doc.querySelectorAll(
    '[aria-expanded="true"], .ant-menu-submenu-open, .el-sub-menu.is-opened',
  )) {
    if (!isVisible(sub)) continue
    const titleEl = (sub as { querySelector?: (s: string) => unknown }).querySelector?.(
      '[class*="title"], [class*="header"], .ant-menu-submenu-title, .el-sub-menu__title',
    )
    const name = titleEl ? accessibleName(titleEl) : accessibleName(sub)
    if (name) {
      openAncestorPaths.push([name])
    }
  }

  const elements: RawCollectedElement[] = []
  let truncated = false

  const selectors = [
    'a[href]',
    '[role="menuitem"]',
    '[role="treeitem"]',
    '[role="tab"]',
    '[role="link"]',
    '[aria-expanded]',
    '[aria-controls]',
    '.ant-menu-item',
    '.el-menu-item',
    '.ant-menu-submenu-title',
    'nav button',
    'aside button',
    'header button',
    '[role="toolbar"] button',
    '.ant-layout-sider button',
    '.ant-menu button',
    '.el-menu button',
    '[role="menu"] button',
    '[role="menubar"] button',
  ].join(',')

  for (const el of doc.querySelectorAll(selectors)) {
    if (elements.length >= maxElements) {
      truncated = true
      break
    }
    if (!isVisible(el)) continue

    const elem = el as { tagName?: string }
    const tag = (elem.tagName || '').toLowerCase()

    // 若容器元素内部已有具体的 a[href] 或 button 交互控件，跳过外层容器，优先保留具体的交互子元素
    if (tag !== 'a' && tag !== 'button' && typeof (el as { querySelector?: (s: string) => unknown }).querySelector === 'function') {
      const childInteractive = (el as { querySelector: (s: string) => unknown }).querySelector('a[href], button')
      if (childInteractive) {
        continue
      }
    }

    let explicitRole = attr(el, 'role').toLowerCase()
    let role = explicitRole || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : 'menuitem')

    const rawHref = attr(el, 'href')
    const hasAriaExpanded = attr(el, 'aria-expanded')
    const ariaExpanded = hasAriaExpanded === 'true' ? true : hasAriaExpanded === 'false' ? false : undefined
    const ariaControls = attr(el, 'aria-controls') || undefined
    const ariaCurrent = attr(el, 'aria-current') || undefined
    const ariaSelected = attr(el, 'aria-selected') === 'true' ? true : undefined
    const dataRoute = attr(el, 'data-route') || attr(el, 'data-path') || undefined

    const name = accessibleName(el)
    if (!name && !rawHref) continue

    const ancestorPath = getAncestorMenuPath(el)

    // Build stable CSS selector if simple
    let stableSelector: string | undefined
    const id = attr(el, 'id')
    if (id && !/^\d+$/.test(id)) {
      stableSelector = `#${id}`
    }

    elements.push({
      role,
      name: name || role,
      ancestorPath,
      href: rawHref || undefined,
      ariaExpanded,
      ariaControls,
      ariaCurrent,
      ariaSelected,
      dataRoute,
      stableSelector,
    })
  }

  return {
    title,
    headings,
    breadcrumbs,
    tabs,
    openAncestorPaths,
    elements,
    truncated,
  }
}

/**
 * 对受管页面及获授权 Frames 收集导航发现候选
 */
export async function collectSurfaceExploration(input: {
  page: Page
  targetId: string
  allowedOrigins: string[]
  allowlist: string[]
  stateRule?: TargetStateRule
  maxCandidates?: number
  baseUrl?: string
}): Promise<SurfaceExplorationResult> {
  const maxBudget = input.maxCandidates ?? 100
  const currentUrl =
    input.baseUrl ||
    (input.page.url() !== 'about:blank' ? input.page.url() : (input.allowedOrigins[0] ?? ''))
  const gaps: Array<{ kind: string; reason: string; frame?: string }> = []

  let rawScan: RawSurfaceScan = {
    title: '',
    headings: [],
    breadcrumbs: [],
    tabs: [],
    openAncestorPaths: [],
    elements: [],
    truncated: false,
  }

  try {
    rawScan = await input.page.evaluate(inBrowserScanSurface, maxBudget)
  } catch (error) {
    gaps.push({
      kind: 'scan_error',
      reason: error instanceof Error ? error.message : '主页面扫描失败',
      frame: 'main',
    })
  }

  // 检查并扫描子 Frames
  const frames = input.page.frames().filter((f) => f !== input.page.mainFrame())
  for (const frame of frames) {
    const frameUrl = frame.url()
    if (!frameUrl || frameUrl === 'about:blank') continue
    try {
      const parsed = new URL(frameUrl)
      if (!input.allowedOrigins.includes(parsed.origin)) {
        gaps.push({ kind: 'unauthorized_frame', reason: `Frame origin ${parsed.origin} 未在授权列表`, frame: frame.name() || frameUrl })
        continue
      }
    } catch {
      gaps.push({ kind: 'invalid_frame_url', reason: 'Frame URL 格式非法', frame: frame.name() || frameUrl })
      continue
    }

    try {
      const frameScan = await frame.evaluate(inBrowserScanSurface, Math.max(10, maxBudget - rawScan.elements.length))
      for (const el of frameScan.elements) {
        el.frameName = frame.name() || frameUrl
        rawScan.elements.push(el)
      }
      if (frameScan.truncated) rawScan.truncated = true
    } catch (error) {
      gaps.push({
        kind: 'unreadable_frame',
        reason: error instanceof Error ? error.message : 'Frame 读取异常',
        frame: frame.name() || frameUrl,
      })
    }
  }

  // 后处理与分类
  const candidates: ProcessedCandidate[] = []
  const seenFingerprints = new Set<string>()

  for (const el of rawScan.elements) {
    const frame = el.frameName || 'main'
    const targetDescriptor: TargetDescriptor = {
      framePath: [],
      candidates: el.stableSelector
        ? [{ by: 'css', value: el.stableSelector }]
        : [{ by: 'role', value: el.role, name: el.name }],
    }

    const controlFingerprint = computeControlFingerprint({
      role: el.role,
      accessibleName: el.name,
      ancestorPath: el.ancestorPath,
      frameSelector: frame,
      locatorDescriptor: targetDescriptor,
    })

    if (seenFingerprints.has(controlFingerprint)) continue
    seenFingerprints.add(controlFingerprint)

    // 判定分类
    let candidateCategory: 'explicit_url' | 'reveal' | 'opaque_navigation' = 'opaque_navigation'
    let canonicalTargetUrl: string | undefined
    let targetDigest: string | undefined
    let rejectionReason: string | undefined
    let eligible = true

    // 检查名称安全性
    if (UNSAFE_ACTION_PATTERN.test(el.name)) {
      rejectionReason = `控件名称 "${el.name}" 疑似写入/危险动作`
      eligible = false
    }

    const rawHref = (el.href || '').trim()
    const isVoidHref = !rawHref || rawHref === '#' || rawHref.startsWith('javascript:')

    if (!isVoidHref) {
      // 尝试解析为 explicit_url
      try {
        const allowlistEntries = input.allowlist.map((item) =>
          typeof item === 'string'
            ? { origin: new URL(item).origin, pathPrefix: new URL(item).pathname }
            : item,
        )
        const sanitized = sanitizeExplorationUrl(rawHref, currentUrl, {
          allowlist: allowlistEntries,
          allowedSpaHashPrefixes: input.stateRule?.allowedSpaHashPrefixes ?? ['#/'],
        })
        if (sanitized.ok) {
          candidateCategory = 'explicit_url'
          canonicalTargetUrl = sanitized.canonicalUrl
          targetDigest = sanitized.digest
        } else {
          rejectionReason = sanitized.reason
          eligible = false
        }
      } catch {
        rejectionReason = 'URL 无法解析为有效绝对地址'
        eligible = false
      }
    } else if (el.ariaExpanded !== undefined || el.role === 'button') {
      candidateCategory = 'reveal'
    } else {
      candidateCategory = 'opaque_navigation'
    }

    const candidateId = `cand_${controlFingerprint.slice(0, 16)}`

    candidates.push({
      candidateId,
      controlFingerprint,
      candidateCategory,
      role: el.role,
      accessibleName: el.name,
      ancestorPath: el.ancestorPath,
      canonicalTargetUrl,
      targetDigest,
      targetDescriptor,
      frame,
      stateHint: el.dataRoute,
      rejectionReason,
      eligible,
    })

    if (candidates.length >= maxBudget) {
      rawScan.truncated = true
      break
    }
  }

  return {
    currentUrl,
    title: rawScan.title,
    domSignals: {
      headings: rawScan.headings,
      breadcrumbs: rawScan.breadcrumbs,
      tabs: rawScan.tabs,
    },
    openAncestorPaths: rawScan.openAncestorPaths,
    candidates,
    truncated: rawScan.truncated,
    truncationReason: rawScan.truncated ? `候选数量达到上限 ${maxBudget}` : undefined,
    gaps,
  }
}

/**
 * 转换为向后兼容的 ExplorationCandidate[]（供 ObservationBundle 使用）
 */
export function toObservationCandidates(candidates: ProcessedCandidate[], limit = 16): ExplorationCandidate[] {
  return candidates
    .filter((c) => c.eligible && c.canonicalTargetUrl)
    .slice(0, limit)
    .map((c) => ({
      id: c.candidateId,
      kind: 'navigate' as const,
      url: c.canonicalTargetUrl!,
      reason:
        c.candidateCategory === 'explicit_url'
          ? `直达链接：${c.accessibleName}`
          : `导航：${c.accessibleName}`,
    }))
}
