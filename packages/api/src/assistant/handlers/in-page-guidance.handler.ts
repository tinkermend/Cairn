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

  // 若未直接命中且具有 LLM 会话，基于地标元数据进行语义生成
  if (ctx.session) {
    await onProgress?.('generating', '正在调用模型推理当前页面动线指引...')
    const { z } = await import('zod')
    const llmResult = await ctx.session.completeJson(
      'in_page_guidance',
      z.strictObject({
        directAnswer: z.string().min(1).max(500),
        visualPath: z.array(z.string()).min(1).max(5),
        shortcutHint: z.string().optional(),
      }),
      [
        {
          role: 'system',
          content: `你是识途平台的界面操作指引专家。根据当前页面的界面地标与可用操作，直接回答用户关于页面操作的提问。
【规则】
1. 回答要精准、言简意赅，指出具体区域、按钮名称与触发方式；
2. visualPath 给出 2~3 个按序指引步骤；
3. 输出 JSON: {"directAnswer": "...", "visualPath": ["1. ...", "2. ..."], "shortcutHint": "可选快捷键"}。`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            question,
            page: manifest.pageTitle,
            landmarks: manifest.regions,
          }),
        },
      ],
      ctx.signal,
    )
    if (llmResult.ok) {
      return {
        kind: 'in_page_guidance',
        directAnswer: llmResult.value.directAnswer,
        visualPath: llmResult.value.visualPath,
        shortcutHint: llmResult.value.shortcutHint,
      }
    }
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
