import type { Page } from 'playwright'
import {
  RESOLVED_ATTRIBUTE,
  type LocatorCandidate,
} from '@cairn/shared'
import { locatorForCandidate } from './runtime.js'

export interface ReverseLocatorResult {
  candidate?: LocatorCandidate
  reason?: string
}

/**
 * 从当前页面已绑定的真实 DOM 元素反向生成高优先级确定性定位器候选。
 * 优先级：role+name > label > testId > text > title
 *
 * 严格门槛：
 * 1. 候选在主文档中 count() === 1；
 * 2. 唯一命中的元素必须包含当前绑定的 token（确保是同一个元素）；
 * 3. 任何不满足唯一性或同元素性的候选一律丢弃，绝不“猜一个”；
 * 4. iframe / canvas / 未命中 等不支持范围返回 undefined。
 */
export async function generateCandidateFromElement(
  page: Page,
  token: string,
): Promise<ReverseLocatorResult> {
  const locator = page.locator(`[${RESOLVED_ATTRIBUTE}="${token}"]`)
  const count = await locator.count().catch(() => 0)
  if (count !== 1) {
    return { reason: 'bound_element_not_found_or_ambiguous' }
  }

  const meta = await locator
    .evaluate((el) => {
      const tag = el.tagName.toUpperCase()
      if (tag === 'IFRAME' || tag === 'FRAME') {
        return { unsupported: 'iframe' as const }
      }
      if (tag === 'CANVAS') {
        return { unsupported: 'canvas' as const }
      }

      const id = el.id ? el.id.trim() : null
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id')
      const ariaLabel = el.getAttribute('aria-label')
      const title = el.getAttribute('title')

      let associatedLabel: string | null = null
      if (id) {
        const labelEl = (el.ownerDocument as { querySelector?: (s: string) => { textContent?: string | null } | null }).querySelector?.(`label[for="${id}"]`)
        if (labelEl) associatedLabel = labelEl.textContent?.trim() || null
      }
      if (!associatedLabel) {
        const parentLabel = (el as { closest?: (s: string) => { textContent?: string | null } | null }).closest?.('label')
        if (parentLabel) associatedLabel = parentLabel.textContent?.trim() || null
      }

      let ownText = ''
      for (const node of el.childNodes) {
        if (node.nodeType === 3) ownText += node.textContent ?? ''
      }
      ownText = ownText.replace(/\s+/g, ' ').trim()
      const innerText = ((el as { innerText?: string }).innerText ?? '').replace(/\s+/g, ' ').trim()

      return {
        tag,
        id: id && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id) ? id : null,
        testId: testId?.trim() || null,
        ariaLabel: ariaLabel?.trim() || null,
        associatedLabel: associatedLabel ? associatedLabel.replace(/\s+/g, ' ').trim() : null,
        title: title?.trim() || null,
        ownText: ownText.length > 0 && ownText.length <= 80 ? ownText : null,
        innerText: innerText.length > 0 && innerText.length <= 80 ? innerText : null,
      }
    })
    .catch(() => null)

  if (!meta) {
    return { reason: 'evaluate_failed' }
  }

  if ('unsupported' in meta) {
    return { reason: `unsupported_element_type: ${meta.unsupported}` }
  }

  // 1. 尝试从 ariaSnapshot({ depth: 0 }) 提取 role + name
  let roleCandidate: LocatorCandidate | undefined
  try {
    const snapshot = await locator.ariaSnapshot({ depth: 0 })
    const firstLine = snapshot.trim().split('\n')[0] ?? ''
    const match = firstLine.match(/^-\s+([a-z]+)(?:\s+"([^"]+)")?/)
    if (match && match[1]) {
      const role = match[1]
      const name = match[2]
      if (name && role !== 'generic') {
        roleCandidate = { by: 'role', value: role, name }
      }
    }
  } catch {
    // ariaSnapshot 提取失败跳过 role 候选
  }

  // 2. 构建候选清单，按优先级排列：role+name > label > testId > text > title > css
  const candidates: LocatorCandidate[] = []
  if (roleCandidate) candidates.push(roleCandidate)
  if (meta.ariaLabel) candidates.push({ by: 'label', value: meta.ariaLabel })
  else if (meta.associatedLabel) candidates.push({ by: 'label', value: meta.associatedLabel })
  if (meta.testId) candidates.push({ by: 'testId', value: meta.testId })
  if (meta.ownText) candidates.push({ by: 'text', value: meta.ownText })
  else if (meta.innerText) candidates.push({ by: 'text', value: meta.innerText })
  if (meta.title) candidates.push({ by: 'title', value: meta.title })

  // 3. 逐一机械核对候选的唯一性与同元素性
  for (const candidate of candidates) {
    try {
      const testLoc = locatorForCandidate(page, candidate)
      const hitCount = await testLoc.count()
      if (hitCount !== 1) continue

      const attr = await testLoc.getAttribute(RESOLVED_ATTRIBUTE)
      if (attr === token) {
        return { candidate }
      }
    } catch {
      // 解析错误忽略并尝试下一个候选
    }
  }

  return { reason: 'no_candidate_passed_uniqueness_verification' }
}
