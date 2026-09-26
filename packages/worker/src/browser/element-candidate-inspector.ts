import type { ElementHandle, Page } from 'playwright'
import {
  type AiElementBinding,
  type AiElementFingerprint,
  type LocatorCandidate,
  type RelativeAnchor,
} from '@cairn/shared'
import { locatorForCandidate, scopeForAnchor } from './runtime.js'

declare const document: any
declare const CSS: any

export interface ElementInspectionInput {
  page: Page
  point?: { x: number; y: number } | null
  actionName: string
  elementDescription?: string | null
  sensitiveSelectors?: string[]
  contextValues?: string[]
}

const NON_TARGET_ACTIONS = new Set([
  'Navigate',
  'Sleep',
  'Scroll',
  'Reload',
  'GoBack',
  'GoForward',
  'RegisterFileChooserAccept',
])

/**
 * 隐式无障碍角色映射（ARIA in HTML 的常用子集）。`el.computedRole()` 非标准且
 * Chromium 默认不可用，不能作为取值来源；`ariaSnapshot` 在 ElementHandle 上不可用，
 * 因此用标签映射。
 */
const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: 'button',
  A: 'link',
  SUMMARY: 'summary',
  SELECT: 'combobox',
  TEXTAREA: 'textbox',
  INPUT: 'textbox',
  OPTION: 'option',
  TH: 'columnheader',
  TD: 'cell',
  TR: 'row',
  LI: 'listitem',
  UL: 'list',
  OL: 'list',
  NAV: 'navigation',
  MAIN: 'main',
  HEADER: 'banner',
  FOOTER: 'contentinfo',
  FORM: 'form',
  H1: 'heading',
  H2: 'heading',
  H3: 'heading',
  H4: 'heading',
  H5: 'heading',
  H6: 'heading',
}

function implicitRoleFor(tag: string, inputType: string | null): string | null {
  if (tag === 'INPUT' && inputType) {
    if (inputType === 'button' || inputType === 'submit' || inputType === 'reset') return 'button'
    if (inputType === 'checkbox') return 'checkbox'
    if (inputType === 'radio') return 'radio'
    if (inputType === 'search') return 'searchbox'
  }
  return IMPLICIT_ROLES[tag] ?? null
}

const DATA_DEPENDENT_TEXT =
  /\b\d{4}[-/]\d{2}[-/]\d{2}\b|\b\d{6,}\b|[¥$€]/

/**
 * 纯净候选点检器：依据动作执行前的逻辑坐标，反向提取稳定、唯一的定位器候选。
 * 遵循无 DOM 污染原则，通过 ElementHandle 身份等价比对（a === b）验证候选。
 * 行锚点只作为作用域辅助：没有已验证候选时不判 bound，避免把同一行的不同操作
 * （如“查看”与“删除”）误记成同一绑定。
 */
export async function inspectElementCandidate(
  input: ElementInspectionInput,
): Promise<AiElementBinding> {
  const { page, point, actionName } = input

  if (NON_TARGET_ACTIONS.has(actionName)) {
    return {
      status: 'not_applicable',
      redirected: false,
      candidates: [],
      dataDependent: false,
    }
  }

  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    return {
      status: 'unbound',
      reason: 'NO_COORDINATES_PROVIDED',
      redirected: false,
      candidates: [],
      dataDependent: false,
    }
  }

  let rawHandle: ElementHandle<any> | null = null
  try {
    const handle = await page.evaluateHandle(
      ([x, y]) => document.elementFromPoint(x, y),
      [point.x, point.y],
    )
    rawHandle = handle.asElement()
    if (!rawHandle) {
      await handle.dispose()
    }
  } catch {
    rawHandle = null
  }

  if (!rawHandle) {
    return {
      status: 'unbound',
      reason: 'NO_ELEMENT_AT_POINT',
      redirected: false,
      candidates: [],
      dataDependent: false,
    }
  }

  let targetHandle: ElementHandle<any> = rawHandle
  let redirected = false

  try {
    // 祖先重定向
    const redirectRes = await targetHandle.evaluateHandle((el: any, action: string) => {
      const isClick =
        action === 'Tap' ||
        action === 'Click' ||
        action === 'DoubleClick' ||
        action === 'RightClick'
      const isInput = action === 'Input' || action === 'ClearInput'

      if (isClick) {
        const interactive = el.closest?.(
          'button, a, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
        )
        if (interactive && interactive !== el) {
          return { element: interactive, isRedirected: true }
        }
      } else if (isInput) {
        const tag = el.tagName?.toUpperCase()
        if (
          tag !== 'INPUT' &&
          tag !== 'TEXTAREA' &&
          !el.isContentEditable &&
          el.getAttribute?.('role') !== 'textbox'
        ) {
          const editable = el.querySelector?.(
            'input, textarea, [contenteditable="true"], [role="textbox"]',
          )
          if (editable) {
            return { element: editable, isRedirected: true }
          }
        }
      }
      return { element: el, isRedirected: false }
    }, actionName)

    const redirectedHandle = await redirectRes
      .evaluateHandle((r: any) => r.element)
      .then((h) => h.asElement())
    const isRedirected = await redirectRes
      .evaluate((r: any) => r.isRedirected)
      .catch(() => false)
    await redirectRes.dispose()

    if (redirectedHandle && isRedirected) {
      await rawHandle.dispose()
      targetHandle = redirectedHandle
      redirected = true
    } else if (redirectedHandle) {
      await redirectedHandle.dispose()
    }

    // 敏感目标检测：密码框、一次性验证码 autocomplete、sensitiveSelectors
    const isSensitive = await targetHandle
      .evaluate((el: any, selectors: string[]) => {
        const type = el.getAttribute?.('type')?.toLowerCase() || ''
        if (type === 'password') return true
        const autocomplete = el.getAttribute?.('autocomplete')?.toLowerCase() || ''
        if (
          autocomplete.includes('one-time-code') ||
          autocomplete.includes('current-password') ||
          autocomplete.includes('new-password')
        ) {
          return true
        }
        for (const sel of selectors) {
          try {
            if (el.matches?.(sel) || el.closest?.(sel)) return true
          } catch {}
        }
        return false
      }, input.sensitiveSelectors ?? [])
      .catch(() => false)

    if (isSensitive) {
      return {
        status: 'unbound',
        reason: 'SENSITIVE_TARGET',
        redirected,
        candidates: [],
        dataDependent: false,
      }
    }

    // 提取元素元信息
    const meta = await targetHandle
      .evaluate((el: any) => {
        const tag = el.tagName?.toUpperCase() || ''
        if (tag === 'IFRAME' || tag === 'FRAME') return { unsupported: 'iframe' as const }
        if (tag === 'CANVAS') return { unsupported: 'canvas' as const }
        // 封闭 Shadow Root 宿主上没有可遍历的候选来源
        if (el.shadowRoot && el.shadowRoot.mode === 'closed') return { unsupported: 'closed_shadow' as const }

        const id = el.id ? el.id.trim() : null
        const testId =
          el.getAttribute?.('data-testid') ||
          el.getAttribute?.('data-test-id') ||
          el.getAttribute?.('data-qa')
        const ariaLabel = el.getAttribute?.('aria-label')
        const explicitRole = el.getAttribute?.('role')
        const title = el.getAttribute?.('title')
        const inputType = tag === 'INPUT' ? el.getAttribute?.('type')?.toLowerCase() || null : null

        let associatedLabel: string | null = null
        if (id) {
          try {
            const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`)
            if (labelEl) associatedLabel = labelEl.textContent?.trim() || null
          } catch {}
        }
        if (!associatedLabel) {
          const parentLabel = el.closest?.('label')
          if (parentLabel) associatedLabel = parentLabel.textContent?.trim() || null
        }

        let ownText = ''
        if (el.childNodes) {
          for (const node of el.childNodes) {
            if (node.nodeType === 3) ownText += node.textContent ?? ''
          }
        }
        ownText = ownText.replace(/\s+/g, ' ').trim()
        const innerText = (el.innerText ?? '').replace(/\s+/g, ' ').trim()

        return {
          tag,
          inputType,
          id: id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) ? id : null,
          testId: testId?.trim() || null,
          ariaLabel: ariaLabel?.trim() || null,
          explicitRole: explicitRole?.trim() || null,
          title: title?.trim() || null,
          associatedLabel: associatedLabel ? associatedLabel.replace(/\s+/g, ' ').trim() : null,
          ownText: ownText.length > 0 && ownText.length <= 80 ? ownText : null,
          innerText: innerText.length > 0 && innerText.length <= 80 ? innerText : null,
        }
      })
      .catch(() => null)

    if (!meta || 'unsupported' in meta) {
      return {
        status: 'unbound',
        reason: meta ? `UNSUPPORTED_ELEMENT_${meta.unsupported}` : 'EVALUATION_FAILED',
        redirected,
        candidates: [],
        dataDependent: false,
      }
    }

    // role + name 候选：显式 role 优先，其次标签映射出的隐式角色；
    // name 依次取无障碍相关文本（按钮内嵌 span 的文本会经 innerText 兜到）。
    let roleCandidate: LocatorCandidate | undefined
    const role = meta.explicitRole ?? implicitRoleFor(meta.tag, meta.inputType)
    if (role && role !== 'generic') {
      const name =
        meta.ariaLabel ||
        meta.associatedLabel ||
        meta.ownText ||
        meta.innerText ||
        meta.title
      if (name) {
        roleCandidate = { by: 'role', value: role, name }
      }
    }

    // 构建候选池（严格沿用优先级 role+name > label > testId > text > title，不生成 css）
    const candidatePool: LocatorCandidate[] = []
    if (roleCandidate) candidatePool.push(roleCandidate)
    if (meta.ariaLabel) candidatePool.push({ by: 'label', value: meta.ariaLabel })
    else if (meta.associatedLabel) candidatePool.push({ by: 'label', value: meta.associatedLabel })
    if (meta.testId) candidatePool.push({ by: 'testId', value: meta.testId })
    if (meta.ownText) candidatePool.push({ by: 'text', value: meta.ownText })
    else if (meta.innerText) candidatePool.push({ by: 'text', value: meta.innerText })
    if (meta.title) candidatePool.push({ by: 'title', value: meta.title })

    // 逐一纯净比对唯一性：count === 1 且解析到的就是同一元素
    const verifiedCandidates: LocatorCandidate[] = []
    for (const candidate of candidatePool) {
      try {
        const loc = locatorForCandidate(page, candidate)
        const count = await loc.count().catch(() => 0)
        if (count === 1) {
          const candHandle = await loc.elementHandle().catch(() => null)
          if (candHandle) {
            const isSame = await page
              .evaluate(([a, b]) => a === b, [targetHandle, candHandle])
              .catch(() => false)
            await candHandle.dispose()
            if (isSame) {
              verifiedCandidates.push(candidate)
              if (verifiedCandidates.length >= 5) break
            }
          }
        }
      } catch {}
    }

    // 无唯一候选时尝试行锚点：锚点必须解析到唯一一行，且目标元素确实在该行内
    let derivedAnchor: RelativeAnchor | null = null
    let dataDependent = verifiedCandidates.some((c) => {
      if (c.by === 'text') return DATA_DEPENDENT_TEXT.test(c.value)
      return Boolean(c.name && DATA_DEPENDENT_TEXT.test(c.name))
    })

    if (verifiedCandidates.length === 0) {
      const anchorInfo = await targetHandle
        .evaluate((el: any) => {
          const row = el.closest?.('tr, [role="row"], li')
          if (!row || !row.textContent) return null
          const cells =
            row.querySelectorAll?.('td, th, [role="cell"], [role="gridcell"]') ?? []
          const cellTexts: string[] = []
          for (const cell of cells) {
            const txt = (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (txt.length >= 2 && txt.length <= 60 && !cellTexts.includes(txt)) {
              cellTexts.push(txt)
            }
          }
          return { cellTexts }
        })
        .catch(() => null)

      if (anchorInfo && anchorInfo.cellTexts.length > 0) {
        for (const text of anchorInfo.cellTexts) {
          try {
            const rows = page.locator('tr, [role="row"], li').filter({ hasText: text })
            const rowCount: number = await rows.count().catch(() => 0)
            if (rowCount !== 1) continue
            const rowHandle = await rows.first().elementHandle().catch(() => null)
            if (!rowHandle) continue
            const inside = await rowHandle
              .evaluate((row: any, el: any) => row.contains(el), targetHandle)
              .catch(() => false)
            await rowHandle.dispose()
            if (!inside) continue
            derivedAnchor = { withinText: text, scope: 'row' }
            if (
              input.contextValues?.includes(text) ||
              DATA_DEPENDENT_TEXT.test(text)
            ) {
              dataDependent = true
            }
            break
          } catch {}
        }
      }
    }

    // 锚点只是作用域辅助，单独不足以定位元素：没有已验证候选一律 unbound。
    const isBound = verifiedCandidates.length > 0
    return {
      status: isBound ? 'bound' : 'unbound',
      reason: !isBound ? 'NO_UNIQUE_LOCATOR_PASS' : undefined,
      redirected,
      candidates: verifiedCandidates,
      anchor: derivedAnchor,
      dataDependent,
      fingerprint: {
        tag: meta.tag,
        role: role ?? null,
        accessibleName:
          roleCandidate?.name ||
          meta.ariaLabel ||
          meta.associatedLabel ||
          meta.title ||
          null,
        texts: [meta.ownText || meta.innerText].filter(Boolean) as string[],
      },
    }
  } finally {
    try {
      await targetHandle.dispose()
    } catch {}
  }
}
