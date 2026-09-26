import { useState, useId } from 'react'
import type { AssistantCapabilityId, AssistantPageContext } from '@cairn/shared'
import {
  Compass,
  FileCode2,
  KeyRound,
  Layers,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  ArrowRight,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type PromptCategoryKey = 'authoring' | 'diagnostics' | 'session' | 'explore'

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
        title: '从零编排自动化流程',
        description: '画布动作节点、参数化与成功条件配置',
        question: '如何在场景工作室中从零编排一个自动化流程？请介绍步骤类型与最佳实践。',
        capabilityHint: 'scenario.explain',
        icon: FileCode2,
      },
      {
        id: 'auth-retry',
        title: '配置重试与失败自愈',
        description: '提升长渲染与动态不稳定页面的执行抗扰度',
        question: '如何在自动化步骤中配置智能重试与失败自愈策略？',
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
        title: '分析最近失败运行根因',
        description: '结合可用运行证据排查错误并提供建议',
        question: '帮我分析最近一次运行失败的根因，并给出具体的排查与修复建议。',
        capabilityHint: 'run.diagnose',
        icon: ScanSearch,
      },
      {
        id: 'diag-compare',
        title: '对比两次运行耗时与差异',
        description: '排查步骤耗时波动、定位漂移与执行瓶颈',
        question: '如何对比两次运行的步骤耗时与证据差异？',
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
        title: '托管 TOTP 2FA 与免登状态',
        description: '自动化算号填入与 StorageState 资产化隔离复用',
        question: '如何为目标系统配置 TOTP 2FA 动态口令以及 Playwright StorageState 免登凭据？',
        capabilityHint: 'platform.guide',
        icon: KeyRound,
      },
      {
        id: 'sess-target',
        title: '快捷创建目标与测试账号',
        description: '深链直达并指派测试账号进行登录探活',
        question: '如何在平台中快速新建目标系统并指派测试账号？',
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
        title: '核心架构与运行模型',
        description: '理解 Engine、Worker 与受管 Runtime 分层',
        question: '请简要介绍识途平台的核心架构、执行分层与受管会话租约机制。',
        capabilityHint: 'platform.guide',
        icon: Compass,
      },
      {
        id: 'exp-guide',
        title: '功能导览与入口速查',
        description: '快速定位知识地图、场景集大盘与监控坞',
        question: '请介绍平台当前的主要功能分区，以及如何高效使用它们。',
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
  onSelectPrompt,
}: {
  pageContext: AssistantPageContext | null
  onSelectPrompt: (question: string, capabilityHint?: AssistantCapabilityId) => void
}) {
  const [activeTab, setActiveTab] = useState<PromptCategoryKey>(() =>
    getInitialCategory(pageContext)
  )
  const categoryTabsId = useId()

  const currentCategory =
    PROMPT_CATEGORIES.find((cat) => cat.key === activeTab) ?? PROMPT_CATEGORIES[0]

  return (
    <div
      role='region'
      aria-label='推荐引导与常见问题'
      className='my-auto w-full space-y-4 py-2'
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
        {PROMPT_CATEGORIES.map((category) => {
          const isActive = category.key === activeTab
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
                  ? 'bg-primary-50 text-primary-600 border border-primary-200 shadow-2xs'
                  : 'bg-surface-subtle text-text-secondary border border-border-default hover:border-border-muted hover:text-text-primary'
              )}
            >
              <Icon className='size-3.5 shrink-0' aria-hidden='true' />
              <span>{category.label}</span>
            </button>
          )
        })}
      </div>

      {/* 小卡片矩阵 */}
      <div
        id={`${categoryTabsId}-panel-${currentCategory.key}`}
        role='tabpanel'
        aria-labelledby={`${categoryTabsId}-tab-${currentCategory.key}`}
        className='grid grid-cols-1 @[420px]:grid-cols-2 gap-2.5 pt-1'
      >
        {currentCategory.cards
          .filter((card) => {
            if (card.id === 'diag-compare' && pageContext?.page !== 'run') {
              return false
            }
            return true
          })
          .map((card) => {
          const CardIcon = card.icon
          return (
            <button
              key={card.id}
              type='button'
              data-testid={`prompt-card-${card.id}`}
              onClick={() => onSelectPrompt(card.question, card.capabilityHint)}
              className='group relative flex flex-col justify-between rounded-xl border border-border-default bg-surface-card p-3 text-start transition-colors hover:border-primary-400 hover:bg-surface-subtle hover:shadow-2xs cursor-pointer select-none'
            >
              <div className='flex items-start justify-between gap-2 w-full'>
                <div className='flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-subtle text-text-secondary group-hover:bg-primary-50 group-hover:text-primary-600 transition-colors'>
                  <CardIcon className='size-3.5' aria-hidden='true' />
                </div>
                <ArrowRight
                  className='size-3.5 text-text-muted group-hover:text-primary-600 group-hover:translate-x-0.5 transition-transform'
                  aria-hidden='true'
                />
              </div>

              <div className='mt-2.5 min-w-0 space-y-1'>
                <span className='block text-small font-semibold text-text-primary truncate group-hover:text-primary-600 transition-colors'>
                  {card.title}
                </span>
                <span className='block text-label text-text-muted line-clamp-2 leading-relaxed font-normal'>
                  {card.description}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
