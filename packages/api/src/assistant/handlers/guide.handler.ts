import {
  type AssistantGuide,
  type AssistantResult,
  assistantGuideTopicSchema,
  filterGuideCatalog,
} from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry'

export async function handlePlatformGuide(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { actor, slots, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索可达控制台入口...')

  const topic = assistantGuideTopicSchema.safeParse(slots.topic).success
    ? assistantGuideTopicSchema.parse(slots.topic)
    : undefined

  const items = filterGuideCatalog(actor.permissions, topic)
  if (items.length === 0) {
    return {
      kind: 'unsupported',
      reasonCode: 'GUIDE_UNAVAILABLE',
      message: '当前权限不能打开该入口。',
    }
  }

  return { kind: 'guide', items }
}
