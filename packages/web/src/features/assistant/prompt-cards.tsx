import { useState, useId, useMemo, useEffect, useRef } from 'react'
import {
  normalizeAssistantPageContext,
  type AssistantCapabilitiesResponse,
  type AssistantCapabilityId,
  type AssistantPageContext,
} from '@cairn/shared'
import {
  Compass,
  FileCode2,
  Layers,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AssistantBoundContext } from '@/stores/assistant-store'
import { resolveContextRecommendations } from './recommendation-engine'
import { useCan } from '@/hooks/use-permissions'

export type PromptCategoryKey = 'recommended' | 'authoring' | 'diagnostics' | 'session' | 'explore'

export interface PromptCardItem {
  id: string
  title: string
  description: string
  question: string
  capabilityHint?: AssistantCapabilityId
  icon: LucideIcon
}

export interface PromptCategory {
  key: PromptCategoryKey
  label: string
  icon: LucideIcon
  cards: PromptCardItem[]
}

const PROMPT_CATEGORIES: PromptCategory[] = [
  {
    key: 'authoring',
    label: '场景编排',
    icon: Sparkles,
    cards: [
      {
        id: 'auth-create',
        title: '找到场景编排入口',
        description: '查看场景和编辑步骤的位置',
        question: '在哪里打开场景编排和场景工作区？',
        capabilityHint: 'platform.guide',
        icon: FileCode2,
      },
      {
        id: 'auth-retry',
        title: '看懂当前场景步骤',
        description: '解释已保存的步骤及其引用关系',
        question: '请解释当前场景的步骤和引用关系。',
        capabilityHint: 'scenario.explain',
        icon: Sparkles,
      },
    ],
  },
  {
    key: 'diagnostics',
    label: '运行排障',
    icon: ScanSearch,
    cards: [
      {
        id: 'diag-rootcause',
        title: '分析当前运行',
        description: '查看失败、等待与耗时的原因',
        question: '请分析当前运行的状态、失败原因和相关证据。',
        capabilityHint: 'run.diagnose',
        icon: ScanSearch,
      },
      {
        id: 'diag-compare',
        title: '对比两次运行',
        description: '提供另一运行后查看步骤与耗时差异',
        question: '我想对比当前运行与另一次运行；请先提示我指定另一运行。',
        capabilityHint: 'run.compare',
        icon: Layers,
      },
    ],
  },
  {
    key: 'session',
    label: '会话与凭据',
    icon: ShieldCheck,
    cards: [
      {
        id: 'sess-totp',
        title: '找到目标账号入口',
        description: '查看目标系统账号的管理位置',
        question: '在哪里查看和维护目标系统账号？',
        capabilityHint: 'platform.guide',
        icon: ShieldCheck,
      },
      {
        id: 'sess-target',
        title: '查看目标系统',
        description: '定位目标系统列表与详情入口',
        question: '在哪里查看目标系统及其详情？',
        capabilityHint: 'platform.guide',
        icon: ShieldCheck,
      },
    ],
  },
  {
    key: 'explore',
    label: '平台探索',
    icon: Compass,
    cards: [
      {
        id: 'exp-arch',
        title: '查看运行与复盘',
        description: '找到运行状态、步骤和证据入口',
        question: '在哪里查看运行状态、步骤详情和执行证据？',
        capabilityHint: 'platform.guide',
        icon: Compass,
      },
      {
        id: 'exp-guide',
        title: '常用功能入口',
        description: '快速找到目标、场景和平台设置',
        question: '请列出我可以使用的主要功能入口。',
        capabilityHint: 'platform.guide',
        icon: Layers,
      },
    ],
  },
]

function getInitialCategory(pageContext: AssistantPageContext | null): PromptCategoryKey {
  if (pageContext?.page === 'studio') return 'authoring'
  if (pageContext?.page === 'run') return 'diagnostics'
  if (pageContext?.page === 'target') return 'session'
  return 'authoring'
}

export function PromptCards({
  pageContext,
  boundContext,
  capabilities,
  onSelectPrompt,
}: {
  pageContext: AssistantPageContext | null
  boundContext?: AssistantBoundContext | null
  capabilities?: AssistantCapabilitiesResponse | null
  onSelectPrompt: (question: string, capabilityHint?: AssistantCapabilityId) => void
}) {
  const canAssist = useCan('ai:assist')
  const canWrite = useCan('workflow:write')
  const canReadTarget = useCan('target:read')
  const canReadSchedule = useCan('schedule:read')
  const canReadRun = useCan('run:read')

  const categoryTabsId = useId()
  const normalizedPageContext = normalizeAssistantPageContext(pageContext)

  const availableIds = capabilities
    ? new Set(capabilities.items.filter((item) => item.available).map((item) => item.id))
    : null

  // 1. 解析当前场景推荐 (Context Recommended)
  const recommendedChips = useMemo(() => {
    if (!capabilities?.modelEnabled) return []
    // 若 boundContext 中已传入带 ID 的结构化推荐 Chips（来自推荐引擎）
    if (boundContext?.chips && boundContext.chips.length > 0 && boundContext.chips.some((c) => Boolean(c.id))) {
      return boundContext.chips.filter((chip) => {
        if (!chip.id) return false
        if (chip.capabilityHint && !availableIds?.has(chip.capabilityHint)) return false
        return true
      })
    }
    // 未显式提供 chips 时，如果处于具体业务页面且拥有 ai:assist 权限，通过推荐引擎解析
    if (boundContext && !boundContext.chips?.length && canAssist) {
      return resolveContextRecommendations({
        boundContext,
        pageContext,
        capabilities,
        permissions: { canAssist, canWrite, canReadTarget, canReadSchedule, canReadRun },
      })
    }
    return []
  }, [boundContext, pageContext, capabilities, availableIds, canAssist, canWrite, canReadTarget, canReadSchedule, canReadRun])

  const recommendedCategory = useMemo((): PromptCategory | null => {
    if (recommendedChips.length === 0) return null
    return {
      key: 'recommended',
      label: '场景推荐',
      icon: Sparkles,
      cards: recommendedChips.map((chip) => {
        let icon: LucideIcon = Sparkles
        if (chip.capabilityHint === 'scenario.propose-step') icon = FileCode2
        else if (chip.capabilityHint === 'run.diagnose') icon = ScanSearch
        else if (chip.capabilityHint === 'run.compare') icon = Layers
        else if (chip.capabilityHint === 'platform.guide') icon = Compass

        return {
          id: chip.id ?? `rec-${chip.label}`,
          title: chip.label,
          description: chip.question,
          question: chip.question,
          capabilityHint: chip.capabilityHint,
          icon,
        }
      }),
    }
  }, [recommendedChips])

  const [activeTab, setActiveTab] = useState<PromptCategoryKey>(() => {
    if (boundContext && recommendedCategory) return 'recommended'
    return getInitialCategory(pageContext)
  })

  // 当业务页面切换选中步骤或上下文更新时，保持推荐标签激活
  const prevContextSig = useRef('')
  const contextSig = `${pageContext?.page}:${pageContext?.runId}:${pageContext?.scenarioId}:${boundContext?.selectedStepId}:${boundContext?.isDirty}`
  useEffect(() => {
    if (prevContextSig.current && prevContextSig.current !== contextSig && recommendedCategory) {
      setActiveTab('recommended')
    }
    prevContextSig.current = contextSig
  }, [contextSig, recommendedCategory])

  const standardCategories = PROMPT_CATEGORIES.map((category) => ({
    ...category,
    cards: category.cards.filter((card) => {
      if (card.id === 'diag-compare' && normalizedPageContext?.page !== 'run') return false
      if (card.id === 'auth-retry' && !normalizedPageContext?.scenarioId) return false
      if (card.id === 'diag-rootcause' && !normalizedPageContext?.runId) return false
      return !availableIds || !card.capabilityHint || availableIds.has(card.capabilityHint)
    }),
  })).filter((category) => category.cards.length > 0)

  const visibleCategories = [
    ...(recommendedCategory ? [recommendedCategory] : []),
    ...standardCategories,
  ]

  const currentCategory = visibleCategories.find((cat) => cat.key === activeTab) ?? visibleCategories[0]

  if (!currentCategory) return null

  return (
    <div
      role='region'
      aria-label='推荐引导与常见问题'
      className='w-full space-y-4 pt-1 pb-4'
      data-testid='assistant-prompt-cards'
    >
      <div>
        <h3 className='text-section font-semibold text-text-primary tracking-tight'>
          有什么可以帮你？
        </h3>
        <p className='mt-1 text-label text-text-muted leading-relaxed'>
          选择常用场景快捷提问，或直接在下方输入框中描述你的需求。
        </p>
      </div>

      {/* 分类切换 Pills */}
      <div
        role='tablist'
        aria-label='问题场景分类'
        className='flex flex-wrap items-center gap-1.5'
      >
        {visibleCategories.map((category) => {
          const isActive = category.key === currentCategory.key
          const Icon = category.icon
          const tabId = `${categoryTabsId}-tab-${category.key}`
          const panelId = `${categoryTabsId}-panel-${category.key}`
          return (
            <button
              key={category.key}
              id={tabId}
              type='button'
              role='tab'
              aria-selected={isActive}
              aria-controls={panelId}
              onClick={() => setActiveTab(category.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-label font-medium transition-colors select-none',
                isActive
                  ? 'bg-primary/10 text-primary border border-primary/20 shadow-2xs'
                  : 'bg-surface-subtle text-text-secondary border border-border-default hover:border-border-muted hover:text-text-primary',
              )}
            >
              <Icon className='size-3.5 shrink-0' aria-hidden='true' />
              <span>{category.label}</span>
            </button>
          )
        })}
      </div>

      {/* 提示词胶囊气泡流 (Prompt Chips / Pills ≤ 36px - 方案 B) */}
      <div
        id={`${categoryTabsId}-panel-${currentCategory.key}`}
        role='tabpanel'
        aria-labelledby={`${categoryTabsId}-tab-${currentCategory.key}`}
        className='flex flex-wrap items-center gap-2 pt-1'
      >
        {currentCategory.cards.map((card) => {
          const CardIcon = card.icon
          const hasEmoji = /\p{Extended_Pictographic}/u.test(card.title)
          return (
            <button
              key={card.id}
              type='button'
              data-testid={`prompt-card-${card.id}`}
              title={card.description}
              onClick={() => onSelectPrompt(card.question, card.capabilityHint)}
              className='group inline-flex items-center gap-2 rounded-full border border-border-default bg-surface-card px-3 py-1.5 text-label font-medium text-text-secondary shadow-2xs transition-colors hover:border-primary/50 hover:bg-surface-subtle hover:text-text-primary cursor-pointer select-none active:scale-[0.98]'
            >
              {!hasEmoji && (
                <CardIcon
                  className='size-3.5 shrink-0 text-text-muted group-hover:text-primary transition-colors'
                  aria-hidden='true'
                />
              )}
              <span className='truncate group-hover:text-primary transition-colors'>
                {card.title}
              </span>
              <ArrowRight
                className='size-3 shrink-0 text-text-muted opacity-40 group-hover:opacity-100 group-hover:text-primary group-hover:translate-x-0.5 transition-transform'
                aria-hidden='true'
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
