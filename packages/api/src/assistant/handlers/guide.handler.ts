import {
  type AssistantGuide,
  type AssistantResult,
  type AssistantGuideTopic,
  assistantGuideTopicSchema,
  filterGuideCatalog,
  hasPermission,
  isRecordingOnboardingGuideQuestion,
  isTargetDeletionGuideQuestion,
} from '@cairn/shared'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { requireVisibleTarget } from './common'

export function targetDeletionGuide(targetId?: string): AssistantGuide {
  return {
    kind: 'guide',
    items: [{
      topic: 'targets',
      title: '删除目标系统',
      href: targetId ? `/targets/${targetId}` : '/targets',
      availability: 'available',
      steps: '平台支持通过目标详情页「系统资料 → 删除」发起。需要对该目标同时拥有 target:delete 和 run:delete 权限；弹窗会先显示删除预览及阻断项，有阻断项时不能确认。请核对影响后自行确认删除；助手没有执行删除。',
    }],
  }
}

/** Build the same permission-aware guide for new turns and historical reads. */
export function buildPlatformGuideForQuestion(
  permissions: readonly string[],
  topic: AssistantGuideTopic | undefined,
  question: string,
): AssistantResult {
  if (isRecordingOnboardingGuideQuestion(question)) {
    const canReadTarget = hasPermission(permissions, 'target:read')
    const canReadScenario = hasPermission(permissions, 'workflow:read')
    const canWriteScenario = hasPermission(permissions, 'workflow:write')
    if (!canReadTarget || !canReadScenario || !canWriteScenario) {
      const missing = [
        ...(!canReadTarget ? ['目标系统读取'] : []),
        ...(!canReadScenario ? ['场景查看'] : []),
        ...(!canWriteScenario ? ['场景编写'] : []),
      ].join('和')
      return {
        kind: 'guide',
        items: [
          {
            topic: 'scenarios', title: '录制与新建场景', href: null, availability: 'forbidden',
            steps: `当前账号缺少${missing}权限，无法在平台完成录制草稿导入、回填并保存新场景。请联系管理员核对授权。`,
          },
          ...(canReadScenario ? [{
            topic: 'scenarios' as const, title: '查看已有场景', href: '/scenarios', availability: 'available' as const,
            steps: '你可以查看已有场景和保存的步骤；获得所需权限后再按录制、回填、保存的顺序创建。',
          }] : []),
        ],
      }
    }
  }

  const items = filterGuideCatalog(permissions, topic)
  if (items.length === 0) {
    return { kind: 'unsupported', reasonCode: 'GUIDE_UNAVAILABLE', message: '当前权限不能打开该入口。' }
  }
  if (isRecordingOnboardingGuideQuestion(question) &&
    (!hasPermission(permissions, 'run:execute') || !hasPermission(permissions, 'run:read'))) {
    const missingRun = [
      ...(!hasPermission(permissions, 'run:execute') ? ['运行执行'] : []),
      ...(!hasPermission(permissions, 'run:read') ? ['运行读取'] : []),
    ].join('和')
    return {
      kind: 'guide',
      items: items.map((item) => item.title === '场景编排' ? {
        ...item,
        steps: `3. 在新场景工作区审查回填结果，补齐输入、定位方式和业务成功条件，保存草稿。4. 当前账号缺少${missingRun}权限，不能完成试跑与结果核对；请联系管理员开通后再试跑，确认通过后发布。`,
      } : item),
    }
  }
  return { kind: 'guide', items }
}

export async function handlePlatformGuide(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { actor, slots, question, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索可达控制台入口...')

  const topic = assistantGuideTopicSchema.safeParse(slots.topic).success
    ? assistantGuideTopicSchema.parse(slots.topic)
    : undefined

  const guide = buildPlatformGuideForQuestion(actor.permissions, topic, question)
  if (guide.kind !== 'guide') return guide

  // The generic menu entry does not answer whether or how a target can be
  // deleted. Give the documented UI path while leaving the actual preview and
  // confirmation to the user.
  if (isTargetDeletionGuideQuestion(question)) {
    if (!guide.items.some((item) => item.topic === 'targets')) {
      return { kind: 'unsupported', reasonCode: 'GUIDE_UNAVAILABLE', message: '当前权限不能打开目标系统入口。' }
    }
    const targetId = ctx.body.pageContext?.targetId
    if (targetId) await requireVisibleTarget(actor, targetId, ctx.targets, ctx.db)
    return targetDeletionGuide(targetId)
  }

  return guide
}
