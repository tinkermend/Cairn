import type {
  AssistantCapabilitiesResponse,
  AssistantCapabilityId,
  AssistantPageContext,
} from '@cairn/shared'
import type { AssistantBoundContext } from '@/stores/assistant-store'

export interface AssistantRecommendationChip {
  id: string
  label: string
  question: string
  capabilityHint?: AssistantCapabilityId
  badge?: string
  priority: number
}

export function resolveContextRecommendations(params: {
  boundContext: AssistantBoundContext | null
  pageContext: AssistantPageContext | null
  capabilities: AssistantCapabilitiesResponse | null
  permissions: {
    canAssist: boolean
    canWrite: boolean
    canReadTarget: boolean
  }
}): AssistantRecommendationChip[] {
  // 1. 若全局未启用 AI 助手能力或缺少 ai:assist 权限，返回空列表
  if (!params.capabilities?.modelEnabled || !params.permissions.canAssist) {
    return []
  }

  const availableIds = new Set(
    params.capabilities.items.filter((item) => item.available).map((item) => item.id),
  )

  const bound = params.boundContext
  const page = bound?.page ?? params.pageContext?.page
  const selectedStepId = bound?.selectedStepId ?? params.pageContext?.stepId
  const rawChips: AssistantRecommendationChip[] = []

  // 2. 根据 boundContext / pageContext 匹配当前场景规则
  if (page === 'studio') {
    if (selectedStepId) {
      // 场景单步聚焦 (Studio Step Focused)
      rawChips.push({
        id: 'studio-step-propose',
        label: '✏️ 修改建议',
        question: '请对当前选中的步骤给出编写与配置优化建议。',
        capabilityHint: 'scenario.propose-step',
        priority: 110,
      })
      rawChips.push({
        id: 'studio-step-explain',
        label: '📖 解释此步骤',
        question: '请解释当前步骤在整套业务流程中的具体作用及上下文依赖。',
        capabilityHint: 'scenario.explain',
        priority: 100,
      })
      if (bound?.hasCssSelector) {
        rawChips.push({
          id: 'studio-step-selector',
          label: '🎯 诊断选择器稳定性',
          question: '请分析当前步骤选择器的健壮性并提供加固候选。',
          capabilityHint: 'scenario.propose-step',
          priority: 85,
        })
      }
      rawChips.push({
        id: 'studio-step-assert',
        label: '🛡️ 补充断言',
        question: '根据当前步骤的操作目标，建议在此处补充哪些验证断言？',
        capabilityHint: 'scenario.propose-step',
        priority: 80,
      })
    } else {
      // 场景全局 (Studio Global)
      rawChips.push({
        id: 'studio-scenario-explain',
        label: '💡 解释场景全貌',
        question: '请解释当前场景的业务流程、步骤时序与全局契约。',
        capabilityHint: 'scenario.explain',
        priority: 100,
      })
      rawChips.push({
        id: 'studio-scenario-inspect',
        label: '🔍 检查逻辑完整性',
        question: '请检查当前场景的步骤依赖、变量传递与潜在逻辑缺漏。',
        capabilityHint: 'scenario.explain',
        priority: 90,
      })
      rawChips.push({
        id: 'studio-scenario-branch',
        label: '➕ 建议测试分支',
        question: '基于此场景的业务目标，有哪些常见的异常分支或校验需要补充？',
        capabilityHint: 'knowledge.answer',
        priority: 70,
      })
    }

    if (bound?.isDirty) {
      rawChips.push({
        id: 'studio-draft-diff',
        label: '📝 审查未保存改动',
        question: '请总结当前草稿与 baseline 相比做出了哪些改动。',
        capabilityHint: 'scenario.explain',
        priority: 95,
      })
    }
  } else if (page === 'run') {
    const isError = bound?.statusTone === 'error'

    if (isError) {
      // 运行失败复盘
      if (selectedStepId && bound?.selectedStepFailed) {
        rawChips.push({
          id: 'run-step-diagnose',
          label: '📸 诊断当前步骤报错',
          question: '为什么当前选中的步骤会执行失败？请分析其错误与证据。',
          capabilityHint: 'run.diagnose',
          priority: 115,
        })
      }
      rawChips.push({
        id: 'run-diagnose-rca',
        label: '🚨 诊断失败根因',
        question: '请结合执行日志、截图证据与错误信息，诊断本次运行失败的根本原因。',
        capabilityHint: 'run.diagnose',
        priority: 110,
      })
      rawChips.push({
        id: 'run-compare',
        label: '🔄 对比上次成功运行',
        question: '我想对比本次失败运行与上一次成功运行的差异；请先提示我指定对比运行。',
        capabilityHint: 'run.compare',
        priority: 90,
      })
    } else {
      // 运行成功 / 正常状态
      rawChips.push({
        id: 'run-perf-bottleneck',
        label: '⏱️ 分析耗时瓶颈',
        question: '请分析本次运行各步骤的耗时分布，并指出性能瓶颈。',
        capabilityHint: 'run.diagnose',
        priority: 80,
      })
    }
  } else if ((page === 'target' || page === 'session') && params.permissions.canReadTarget) {
    // 目标系统与凭据
    rawChips.push({
      id: 'target-account-health',
      label: '🔑 检查账号健康度',
      question: '请检查该目标系统关联账号的认证健康状态与会话租约情况。',
      capabilityHint: 'platform.guide',
      priority: 90,
    })
    rawChips.push({
      id: 'target-menu-map',
      label: '🗺️ 目标菜单地图覆盖',
      question: '请解释当前目标系统的一级菜单授权与只读地图覆盖情况。',
      capabilityHint: 'knowledge.answer',
      priority: 80,
    })
  } else {
    // 全局上下文
    rawChips.push({
      id: 'global-authoring-guide',
      label: '🚀 快速上手编排',
      question: '在识途平台中，如何从零录制并编排一个新场景？',
      capabilityHint: 'platform.guide',
      priority: 90,
    })
    rawChips.push({
      id: 'global-abnormal-runs',
      label: '📊 查看近期异常运行',
      question: '在哪里快速筛选和排查近期失败的场景运行？',
      capabilityHint: 'platform.guide',
      priority: 80,
    })
    rawChips.push({
      id: 'global-feature-map',
      label: '📋 常用功能导航',
      question: '请列出我可以使用的主要功能入口。',
      capabilityHint: 'platform.guide',
      priority: 70,
    })
  }

  // 3. 过滤不可用能力、校验权限闸门，并按优先级降序取 Top 3
  return rawChips
    .filter((chip) => {
      // 校验能力是否在可用集合中
      if (chip.capabilityHint && !availableIds.has(chip.capabilityHint)) {
        return false
      }
      // 权限闸门：编排提议类能力严格需要 workflow:write 权限
      if (chip.capabilityHint === 'scenario.propose-step' && !params.permissions.canWrite) {
        return false
      }
      return true
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3)
}
