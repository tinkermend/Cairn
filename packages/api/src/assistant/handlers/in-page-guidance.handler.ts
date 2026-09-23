import {
  type AssistantInPageGuidance,
  type AssistantResult,
  PAGE_LANDMARK_MANIFESTS,
} from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

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

  // 匹配具体 Action
  let matchedAction: { name: string; trigger: string; description: string; shortcut?: string; actionKey?: string; regionName: string } | null = null

  for (const region of manifest.regions) {
    for (const act of region.actions) {
      if (
        question.includes(act.name) ||
        (act.name === '添加步骤' && /加步骤|增加步骤|新建步骤|步骤.*哪里|步骤.*在哪/.test(question)) ||
        (act.name === '保存草稿' && /保存|草稿/.test(question)) ||
        (act.name === '试跑验证' && /试跑|运行|测试/.test(question))
      ) {
        matchedAction = { ...act, regionName: region.regionName }
        break
      }
    }
    if (matchedAction) break
  }

  if (matchedAction) {
    await onProgress?.('generating', '正在生成页面操作动线指引...')
    const result: AssistantInPageGuidance = {
      kind: 'in_page_guidance',
      directAnswer: `在当前${manifest.pageTitle}的「${matchedAction.regionName}」，${matchedAction.trigger}。`,
      visualPath: [
        `1. 视线移至页面【${matchedAction.regionName}】`,
        `2. 定位到【${matchedAction.name}】交互区域（${matchedAction.trigger}）`,
        `3. ${matchedAction.description}`,
      ],
      shortcutHint: matchedAction.shortcut,
      actionChip: matchedAction.actionKey
        ? {
            label: `触发${matchedAction.name}`,
            actionKey: matchedAction.actionKey,
          }
        : undefined,
    }
    return result
  }

  // 兜底返回当前页面主要操作概览
  const actionsSummary = manifest.regions
    .flatMap((r) => r.actions.map((a) => `【${a.name}】(${a.trigger})`))
    .slice(0, 3)
    .join('；')

  return {
    kind: 'in_page_guidance',
    directAnswer: `在当前${manifest.pageTitle}中，常见操作包括：${actionsSummary}。`,
    visualPath: manifest.regions.map((r, i) => `${i + 1}. ${r.regionName}：可操作 ${r.actions.map((a) => a.name).join('、')}`),
  }
}
