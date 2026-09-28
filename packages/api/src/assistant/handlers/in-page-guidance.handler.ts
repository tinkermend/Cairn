import {
  type AssistantInPageGuidance,
  type AssistantResult,
  PAGE_LANDMARK_MANIFESTS,
  hasPermission,
} from '@cairn/shared'
import { authorizeTargetRequest, getTargetKnowledgeContext } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { requireVisibleTarget } from './common.js'

function observedRoutePath(urlPattern: string): string {
  try {
    const url = new URL(urlPattern)
    return url.pathname || '/'
  } catch {
    return urlPattern.split(/[?#]/, 1)[0] || '/'
  }
}

function targetPageMatchScore(
  question: string,
  page: { title: string; menuPath: string[] },
  rootMenu: string | undefined,
): number {
  const title = page.title.split('_')[0]?.trim() ?? ''
  const specificNames = [...page.menuPath.slice(1), title]
  const specificScore = Math.max(0, ...specificNames
    .filter((name) => name.length >= 2 && question.includes(name))
    .map((name) => name.length))
  if (specificScore > 0) return specificScore
  // A user may say "订单页" when the observed page is titled "订单查询".
  // Keep this lower than an exact page-name match and require a unique winner.
  const subject = requestedPageSubject(question)
  if (subject && specificNames.some((name) => name.includes(subject))) return subject.length
  return rootMenu && page.menuPath.length === 1 && question.includes(rootMenu) ? 1 : 0
}

function requestedPageSubject(question: string): string | undefined {
  return question.match(/(?:的|里|内|中)([^的里内中，。？?]{2,12}?)(?:页面?|列表)(?:入口|在哪|在哪里|路径|怎么进|怎么打开)?/u)?.[1]
}

/** An explicitly named system takes precedence over the target open in the browser. */
export function namedTargetForPageEntryQuestion(question: string): string | undefined {
  const match = /^(?:请问|请|麻烦|帮我找一下|帮我查一下)?\s*(?:在\s*)?([^，。？?！!]{2,80}?)\s*的\s*[^，。？?！!]{1,35}?(?:页面?|列表)[^，。？?！!]{0,20}?(?:入口|在哪|哪里|路径|怎么进|怎么打开)/u.exec(question.trim())
  const name = match?.[1]?.trim()
  if (!name || /^(?:这个|当前|该|本|目标|业务|这个目标|当前目标|该目标|本目标)(?:系统|平台)?$/.test(name)) return undefined
  return name
}

export function isTargetPageEntryQuestion(page: string, question: string): boolean {
  return page === 'target' &&
    ((/(?:这个|该|当前|目标|业务)系统(?:里|内|中)?的?/.test(question) &&
      /(?:页|页面|列表|入口|路径)/.test(question) &&
      /(?:入口|在哪|哪里|路径|怎么进|怎么打开)/.test(question)) ||
      namedTargetForPageEntryQuestion(question) !== undefined)
}

/** Build only guidance supported by the current page landmark manifest. */
export function buildManifestPageGuidance(page: string, question: string): AssistantInPageGuidance | null {
  const manifest = PAGE_LANDMARK_MANIFESTS[page]
  if (!manifest || !question.trim()) return null
  for (const region of manifest.regions) {
    for (const action of region.actions) {
      const matched = question.includes(action.name) ||
        (action.name === '添加步骤' && /加步骤|增加步骤|新建步骤|步骤.*哪里|步骤.*在哪/.test(question)) ||
        (action.name === '保存草稿' && /保存|草稿/.test(question)) ||
        (action.name === '试跑验证' && /试跑|运行|测试/.test(question)) ||
        (action.name === '检查账号健康度' && /账号健康度/.test(question))
      if (!matched) continue
      return {
        kind: 'in_page_guidance',
        directAnswer: `在当前${manifest.pageTitle}的「${region.regionName}」，${action.trigger}。`,
        visualPath: [
          `1. 视线移至页面【${region.regionName}】`,
          `2. 定位到【${action.name}】交互区域（${action.trigger}）`,
          `3. ${action.description}`,
        ],
        shortcutHint: action.shortcut,
        actionChip: action.actionKey ? { label: `触发${action.name}`, actionKey: action.actionKey } : undefined,
      }
    }
  }
  const accountStatusHint = page === 'target' && /(?:账号|账户).*(?:健康|可用|认证|会话)/.test(question)
    ? '若想了解账号当前是否可用，可以直接问“哪些账号现在可用？”。'
    : '请确认按钮上的准确文字，或说明你想完成的任务。'
  return {
    kind: 'in_page_guidance',
    directAnswer: `当前${manifest.pageTitle}的已登记界面地标中，没有找到与你描述直接对应的按钮或入口；我无法确认它在页面上的位置。`,
    visualPath: [accountStatusHint],
  }
}

/** Recompute an observed target route from the current authorized map. */
export async function resolveObservedTargetPageEntry(
  ctx: Pick<AssistantCapabilityHandlerContext, 'actor' | 'db' | 'targets'>,
  targetId: string,
  question: string,
): Promise<AssistantInPageGuidance> {
  if (!hasPermission(ctx.actor.permissions, 'target:read') || !hasPermission(ctx.actor.permissions, 'map:read')) {
    return {
      kind: 'in_page_guidance',
      directAnswer: '当前没有可访问的目标系统地图事实，无法核实这个页面的入口。',
      visualPath: ['请先打开有权限的目标系统知识地图，再按页面名称核对。'],
    }
  }
  await authorizeTargetRequest(ctx.db, ctx.actor.id, { targetId, permissions: ['map:read'] })
  const target = await requireVisibleTarget(ctx.actor, targetId, ctx.targets, ctx.db)
  const targetLabel = target?.name ? `目标系统「${target.name}」：` : ''
  const overview = await getTargetKnowledgeContext(ctx.db, targetId, { intent: question, maxPages: 3, include: [] })
  const subject = requestedPageSubject(question)
  const matchingMenus = [...overview.menuTree]
    .filter((entry) => entry.name.length >= 2 && (
      question.includes(entry.name) || (subject && entry.name.includes(subject))
    ))
    .sort((a, b) => b.name.length - a.name.length)
  const matchedMenu = matchingMenus.length === 1 ? matchingMenus[0] : undefined
  const scoped = matchedMenu?.pageKeys.length
    ? await getTargetKnowledgeContext(ctx.db, targetId, {
        intent: question,
        menuPath: [matchedMenu.name],
        maxPages: 10,
        include: [],
      })
    : overview
  const ranked = scoped.pages
    .map((candidate) => ({
      candidate,
      score: targetPageMatchScore(question, candidate, matchedMenu?.name),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  const winner = ranked[0]
  const runnerUp = ranked[1]
  const best = winner?.candidate
  if (best && runnerUp && runnerUp.score === winner.score &&
      (runnerUp.candidate.title !== best.title || runnerUp.candidate.urlPattern !== best.urlPattern ||
        runnerUp.candidate.menuPath.join('/') !== best.menuPath.join('/'))) {
    return {
      kind: 'in_page_guidance',
      directAnswer: `${targetLabel}目标地图中有多个可能的页面：${ranked.slice(0, 3).map((item) => `「${item.candidate.title}」`).join('、')}。请指定页面名称，我再核对入口。`,
      visualPath: ['在目标系统知识地图中确认要找的页面名称。'],
    }
  }
  if (best) {
    const menuPath = best.menuPath.join(' → ')
    const routePath = observedRoutePath(best.urlPattern)
    return {
      kind: 'in_page_guidance',
      directAnswer: `${targetLabel}目标地图已观测到「${best.title}」：菜单路径为「${menuPath}」，页面路径为 ${routePath}。`,
      visualPath: [
        `1. 在目标系统菜单依次进入「${menuPath}」。`,
        `2. 核对已观测页面路径 ${routePath}。`,
      ],
    }
  }
  return {
    kind: 'in_page_guidance',
    directAnswer: `${targetLabel}当前已授权的目标地图记录未提供这项页面的可核验入口${overview.truncated ? '；本次地图检索结果有截断' : ''}，不能据此判断页面不存在。`,
    visualPath: ['打开目标系统的知识地图，按页面名称检查采集覆盖和最新记录。'],
  }
}

export async function handleInPageGuidance(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { question, body, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索当前页面界面地标与操作路径...')

  const page = body.pageContext?.page ?? 'studio'
  const manifest = PAGE_LANDMARK_MANIFESTS[page]

  if (!manifest) {
    return {
      kind: 'in_page_guidance',
      directAnswer: '当前页面暂未登记界面地标，你可以参考顶部导航或右下角操作按钮。',
      visualPath: ['请核对当前页面类型，或在场景工作室中使用编排功能。'],
    }
  }

  // Questions about a page inside the target business system need an observed
  // map route. A model can otherwise turn an unrelated, truncated three-page
  // sample into a fabricated menu path or a claim that the page does not exist.
  if (isTargetPageEntryQuestion(page, question)) {
    const namedTarget = namedTargetForPageEntryQuestion(question)
    let targetId = body.pageContext?.targetId
    if (namedTarget) {
      // The page target is only a fallback for deictic questions. Resolve a
      // named target in the actor's own visible list, including pagination.
      delete ctx.slots.targetId
      if (!hasPermission(ctx.actor.permissions, 'target:read')) {
        return { kind: 'clarify', question: '当前账号没有可访问的目标系统地图事实。请先打开有权限的目标系统，再询问页面入口。', missingFields: ['targetId'] }
      }
      const matches: { id: string; name: string }[] = []
      try {
        let cursor: string | undefined
        do {
          const page = await ctx.targets.listTargets({ search: namedTarget, cursor, limit: 100 }, ctx.actor)
          matches.push(...page.items.filter((item) => item.name.toLocaleLowerCase() === namedTarget.toLocaleLowerCase()))
          cursor = page.nextCursor ?? undefined
        } while (cursor && matches.length < 2)
      } catch {
        return { kind: 'clarify', question: '本次无法读取当前授权的目标列表，不能核实所问目标的页面入口。请稍后重试。', missingFields: ['targetId'] }
      }
      if (matches.length !== 1) {
        return {
          kind: 'clarify',
          question: matches.length > 1
            ? '当前权限范围内有多个同名目标。请打开要查询的目标详情页，再询问页面入口。'
            : '在本次查询可访问的目标范围内，未定位到匹配名称。请核对名称，或打开要查询的目标详情页。',
          missingFields: ['targetId'],
        }
      }
      targetId = matches[0]!.id
      ctx.slots.targetId = targetId
    }
    if (!targetId) {
      return {
        kind: 'in_page_guidance',
        directAnswer: '当前没有可访问的目标系统地图事实，无法核实这个页面的入口。',
        visualPath: ['请先打开有权限的目标系统知识地图，再按页面名称核对。'],
      }
    }
    return resolveObservedTargetPageEntry(ctx, targetId, question)
  }
  await onProgress?.('generating', '正在核对当前页面已登记的操作地标...')
  return buildManifestPageGuidance(page, question)!
}
