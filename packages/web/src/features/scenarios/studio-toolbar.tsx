import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Send,
  CalendarClock,
  ChevronDown,
  Edit2,
  Play,
  Save,
  Settings,
  Zap,
  CheckCircle2,
  AlertCircle,
  Info,
  Loader2,
  Square,
} from 'lucide-react'
import type {
  RunDetailDto,
  ScenarioDetailDto,
  TargetDto,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ObjectSchedules } from '@/features/schedules/object-schedules'
import { useAssistantStore } from '@/stores/assistant-store'
import { SCENARIO_STATUS_LABELS } from './labels'
import { cn } from '@/lib/utils'

export type StudioToolbarProps = {
  scenario: ScenarioDetailDto | undefined
  target: TargetDto | undefined
  scenarioId: string
  revision: number
  dirty: boolean
  hasDraftDirty: boolean
  saving: boolean
  publishing: boolean
  canWrite: boolean
  canTrial: boolean
  canStartFormalRun: boolean
  trialDisabledReason: string | undefined
  trialRun?: RunDetailDto | null
  canPublish: boolean
  unpublishedDraft: boolean
  compileOk: boolean | undefined
  canReadTarget: boolean
  canRecord: boolean
  canDelete: boolean
  disabled: boolean
  isScenarioView?: boolean
  pendingImportDraftId?: string | null
  onPreviewImportDraft?: () => void
  onSave: () => void
  onPublish: () => void
  onStartTrial: () => void
  onCancelTrial?: () => void
  canCancelTrial?: boolean
  cancellingTrial?: boolean
  onOpenTrialResult?: () => void
  onOpenRun: () => void
  onOpenImport: () => void
  onOpenRename: () => void
  onRename?: (newName: string) => Promise<boolean | void> | void
  onToggleStatus: () => void
  onOpenRemove: () => void
  onOpenSettings?: () => void
  onLeave: (e: React.MouseEvent) => void
}

export function StudioToolbar({
  scenario,
  target,
  revision,
  dirty,
  hasDraftDirty,
  saving,
  publishing,
  canWrite,
  canTrial,
  canStartFormalRun,
  trialDisabledReason,
  trialRun,
  canPublish,
  unpublishedDraft,
  compileOk,
  canReadTarget,
  canRecord,
  canDelete,
  disabled,
  isScenarioView = false,
  pendingImportDraftId,
  onPreviewImportDraft,
  onSave,
  onPublish,
  onStartTrial,
  onCancelTrial,
  canCancelTrial: canCancelTrialProp,
  cancellingTrial = false,
  onOpenTrialResult,
  onOpenRun,
  onOpenImport,
  onOpenRename,
  onRename,
  onToggleStatus,
  onOpenRemove,
  onOpenSettings,
  onLeave,
}: StudioToolbarProps) {
  const headerRef = useRef<HTMLElement>(null)
  const isAssistantDocked = useAssistantStore((s) => s.open && s.mode === 'docked')
  const assistantDockWidth = useAssistantStore((s) => s.dockWidth)

  // 内联重命名状态机
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState(scenario?.name ?? '')
  const [savingName, setSavingName] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isEditingName && scenario?.name) {
      setTempName(scenario.name)
    }
  }, [scenario?.name, isEditingName])

  useEffect(() => {
    if (isEditingName) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditingName])

  const commitRename = async () => {
    const trimmed = tempName.trim()
    if (!trimmed || trimmed === scenario?.name) {
      setTempName(scenario?.name ?? '')
      setIsEditingName(false)
      return
    }
    if (onRename) {
      setSavingName(true)
      try {
        await onRename(trimmed)
        setIsEditingName(false)
      } catch {
        setTempName(scenario?.name ?? '')
        setIsEditingName(false)
      } finally {
        setSavingName(false)
      }
    } else {
      setIsEditingName(false)
      onOpenRename()
    }
  }

  // 试跑运行态判定
  const isTrialRunning = Boolean(
    trialRun && ['QUEUED', 'RUNNING', 'RECOVERING', 'WAITING_FOR_AUTH', 'HOLDING'].includes(trialRun.status),
  )
  const canCancelTrial = canCancelTrialProp ?? Boolean(onCancelTrial)
  const [isCancelHovered, setIsCancelHovered] = useState(false)

  // 容器可用宽度状态（首帧合理估算，后续由 ResizeObserver 精确测量）
  const [containerWidth, setContainerWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 1200
    const w = window.innerWidth
    const dockedOffset = isAssistantDocked ? (assistantDockWidth || 400) : 0
    return Math.max(320, w - 240 - dockedOffset)
  })

  useEffect(() => {
    const el = headerRef.current
    if (!el) return

    if (el.getBoundingClientRect().width > 0) {
      setContainerWidth(el.getBoundingClientRect().width)
    }

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry && entry.contentRect.width > 0) {
        setContainerWidth(entry.contentRect.width)
      }
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 自适应响应式断点：
  // 1. 展开快捷按钮门槛：需容纳返回+标题+胶囊(~640px) + 核心操作(~320px) + 2个次要按钮(~180px) ≈ 1140px
  // 挂载知识助手后容器通常被压缩至 800px~1250px，自动收起快捷操作至「更多」
  const showExpandedShortcuts = containerWidth >= 1140
  // 2. 胶囊静态说明文字（"目标系统"、"已发布"、"草稿"）
  const showDetailedPill = containerWidth >= 1050
  // 3. 返回按钮文字（过窄时仅留图标）
  const showBackText = containerWidth >= 840
  // 4. 上下文状态胶囊（极窄时收起胶囊保障标题和主操作）
  const showPill = containerWidth >= 600

  return (
    <header
      ref={headerRef}
      className='flex h-14 shrink-0 items-center justify-between border-b border-border-divider bg-card px-3 sm:px-4 shadow-sm gap-2 overflow-hidden'
    >
      {/* 左侧：返回、场景标识与状态胶囊 */}
      <div className='flex min-w-0 flex-1 items-center gap-2 sm:gap-3 overflow-hidden'>
        <Link
          to='/scenarios'
          className='inline-flex shrink-0 items-center gap-1.5 text-body text-muted-foreground hover:text-foreground'
          onClick={onLeave}
          title='返回场景编排'
        >
          <ArrowLeft className='size-4' />
          {showBackText ? <span>返回场景编排</span> : null}
        </Link>
        <span className='h-4 w-px bg-border-divider shrink-0' />
        <div className='flex min-w-0 shrink items-center gap-1.5 max-w-[180px] sm:max-w-[240px] md:max-w-[320px] xl:max-w-[420px] 2xl:max-w-[560px]'>
          {isEditingName ? (
            <div className='flex items-center gap-1 min-w-0'>
              <input
                ref={inputRef}
                type='text'
                value={tempName}
                maxLength={100}
                disabled={savingName}
                aria-label='场景名称输入'
                className='h-7 w-40 sm:w-48 md:w-64 rounded-md border border-control bg-surface-control px-2 text-body font-semibold text-foreground shadow-control-focus outline-none focus:border-primary'
                onChange={(e) => setTempName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void commitRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setTempName(scenario?.name ?? '')
                    setIsEditingName(false)
                  }
                }}
                onBlur={() => {
                  void commitRename()
                }}
              />
              {savingName ? <span className='size-3 animate-spin rounded-full border-2 border-primary border-t-transparent' /> : null}
            </div>
          ) : (
            <>
              <h1
                className='truncate text-body font-semibold text-foreground cursor-pointer hover:text-primary transition-colors'
                title={scenario?.name ?? '场景'}
                onClick={() => {
                  if (canWrite) {
                    setTempName(scenario?.name ?? '')
                    setIsEditingName(true)
                  }
                }}
              >
                {scenario?.name ?? '场景'}
              </h1>
              {canWrite ? (
                <Button
                  size='icon'
                  variant='ghost'
                  className='size-6 shrink-0 text-muted-foreground hover:text-foreground'
                  title='重命名'
                  onClick={() => {
                    setTempName(scenario?.name ?? '')
                    setIsEditingName(true)
                  }}
                >
                  <Edit2 className='size-3.5' />
                  <span className='sr-only'>重命名</span>
                </Button>
              ) : null}
            </>
          )}
        </div>

        {/* 紧凑上下文胶囊：目标系统、版本、草稿、状态 */}
        {scenario && showPill ? (
          <div className='flex items-center gap-2 rounded-full border border-border-default bg-surface-subtle px-2.5 py-1 text-label whitespace-nowrap shrink overflow-hidden min-w-0'>
            <div className='flex items-center gap-1 min-w-0'>
              {showDetailedPill ? (
                <span className='text-muted-foreground shrink-0'>目标系统</span>
              ) : null}
              {canReadTarget ? (
                <Link
                  to='/targets/$targetId'
                  params={{ targetId: scenario.targetId }}
                  className='max-w-[100px] md:max-w-[140px] xl:max-w-[180px] truncate font-medium text-link hover:underline'
                  title={target?.name ?? scenario.targetId}
                >
                  {target?.name ?? scenario.targetId}
                </Link>
              ) : (
                <span className='max-w-[90px] truncate font-mono'>{scenario.targetId}</span>
              )}
            </div>
            <span className='h-3 w-px bg-border-divider shrink-0' />
            <div className='flex items-center gap-1 shrink-0'>
              {showDetailedPill ? (
                <span className='text-muted-foreground'>已发布</span>
              ) : null}
              <span className='font-medium'>v{scenario.latestVersionNo}</span>
            </div>
            <span className='h-3 w-px bg-border-divider shrink-0' />
            <div className='flex items-center gap-1 shrink-0'>
              {showDetailedPill ? (
                <span className='text-muted-foreground'>草稿</span>
              ) : null}
              <span className='font-medium'>r{revision}</span>
            </div>
            <StatusBadge tone={dirty || hasDraftDirty ? 'warning' : 'success'} className='shrink-0'>
              {dirty ? '未保存' : hasDraftDirty ? '未发布' : '已同步'}
            </StatusBadge>
            {compileOk === false ? (
              <StatusBadge tone='error' className='shrink-0'>编译失败</StatusBadge>
            ) : null}
            <StatusBadge tone={scenario.status === 'active' ? 'success' : 'neutral'} className='shrink-0'>
              {SCENARIO_STATUS_LABELS[scenario.status]}
            </StatusBadge>
          </div>
        ) : null}
      </div>

      {/* 右侧：主次动作 */}
      {scenario ? (
        <div className='flex shrink-0 items-center gap-1.5 sm:gap-2'>
          {/* 大屏且容器空间宽裕时快捷操作展开为独立按钮 */}
          {showExpandedShortcuts ? (
            <>
              <ObjectSchedules
                size='sm'
                context={{
                  type: 'scenario_run',
                  targetId: scenario.targetId,
                  objectId: scenario.id,
                  name: scenario.name,
                  versionId: scenario.latestVersionId,
                }}
              />
              <Button variant='outline' size='sm' asChild>
                <Link to='/outbound' search={{ tab: 'results', scenarioId: scenario.id }}>
                  <Send className='size-3.5 mr-1' />
                  结果推送
                </Link>
              </Button>
            </>
          ) : null}

          {/* 场景配置全局入口（稳定可见，断点优先保障） */}
          {onOpenSettings ? (
            containerWidth >= 960 ? (
              <Button
                size='sm'
                variant={isScenarioView ? 'secondary' : 'outline'}
                className={cn(isScenarioView && 'border-primary/40 bg-primary/10 text-primary font-medium shadow-xs')}
                onClick={onOpenSettings}
                title='整个场景配置'
                data-testid='toolbar-scenario-config'
              >
                <Settings className='size-3.5 mr-1' />
                场景配置
              </Button>
            ) : (
              <Button
                size='icon'
                variant={isScenarioView ? 'secondary' : 'outline'}
                className={cn('size-8', isScenarioView && 'border-primary/40 bg-primary/10 text-primary')}
                onClick={onOpenSettings}
                title='整个场景配置'
                aria-label='场景配置'
                data-testid='toolbar-scenario-config'
              >
                <Settings className='size-3.5' />
              </Button>
            )
          ) : null}

          {/* 待导入录制草稿高亮入口：吸收进顶栏，高度固定锁死 */}
          {pendingImportDraftId && canRecord && onPreviewImportDraft ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8 border-primary/50 bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary font-medium shadow-xs shrink-0'
              onClick={onPreviewImportDraft}
              title='检测到录制草稿，点击预览并转换为操作步骤'
              data-testid='toolbar-import-draft-btn'
            >
              <Zap className='size-3.5 mr-1 text-primary' />
              {containerWidth >= 800 ? <span>导入录制草稿</span> : <span>导入草稿</span>}
            </Button>
          ) : null}

          {/* 核心主动作（各分辨率均保持可达） */}
          {canWrite ? (
            <Button
              size='sm'
              variant='outline'
              className={dirty ? 'border-primary text-primary hover:bg-primary/5 font-medium shadow-xs' : ''}
              disabled={!dirty || saving}
              loading={saving}
              onClick={onSave}
            >
              <Save className='size-3.5 mr-1' />
              保存草稿
            </Button>
          ) : null}

          {isTrialRunning ? (
            canCancelTrial && onCancelTrial ? (
              <Button
                size='sm'
                variant='outline'
                className={cn(
                  'h-8 px-2.5 text-label gap-1.5 transition-colors',
                  isCancelHovered || cancellingTrial
                    ? 'border-status-error/40 bg-status-error/10 text-status-error hover:border-status-error/60 hover:bg-status-error/15 hover:text-status-error'
                    : 'border-border text-muted-foreground hover:border-status-error/40 hover:bg-status-error/10 hover:text-status-error',
                )}
                disabled={cancellingTrial}
                onClick={onCancelTrial}
                onMouseEnter={() => setIsCancelHovered(true)}
                onMouseLeave={() => setIsCancelHovered(false)}
                title='试跑执行中，点击可中止'
              >
                {cancellingTrial ? (
                  <>
                    <Loader2 className='size-3.5 animate-spin text-status-error' />
                    <span>正在中止…</span>
                  </>
                ) : isCancelHovered ? (
                  <>
                    <Square className='size-3.5 fill-current text-status-error' aria-hidden='true' />
                    <span>中止试跑</span>
                  </>
                ) : (
                  <>
                    <Loader2 className='size-3.5 animate-spin text-primary' />
                    <span>试跑中…</span>
                  </>
                )}
              </Button>
            ) : (
              <Button
                size='sm'
                variant='outline'
                className='h-8 px-2.5 text-label text-muted-foreground gap-1.5'
                disabled
                title='试跑执行中…'
              >
                <Loader2 className='size-3.5 animate-spin text-primary' />
                <span>试跑中…</span>
              </Button>
            )
          ) : canTrial ? (
            <Button size='sm' className='action-shadow' onClick={onStartTrial}>
              <Play className='size-3.5 mr-1' />
              试跑
            </Button>
          ) : canStartFormalRun ? (
            <Button size='sm' variant='outline' disabled title={trialDisabledReason}>
              <Play className='size-3.5 mr-1' />
              试跑
            </Button>
          ) : null}

          {onOpenTrialResult && trialRun && !isTrialRunning ? (
            <Button
              size='sm'
              variant='outline'
              className={cn(
                'h-8 px-2.5 text-label font-medium gap-1.5 transition-colors',
                trialRun.status === 'SUCCEEDED' && 'border-status-success/40 text-status-success-foreground hover:bg-status-success/10',
                trialRun.status === 'FAILED' && 'border-status-error/40 text-status-error-foreground hover:bg-status-error/10',
                trialRun.status === 'NEEDS_REVIEW' && 'border-status-warning/40 text-status-warning-foreground hover:bg-status-warning/10',
              )}
              onClick={onOpenTrialResult}
              title='查看试跑结果'
            >
              {trialRun.status === 'SUCCEEDED' ? (
                <CheckCircle2 className='size-3.5 text-status-success' />
              ) : trialRun.status === 'FAILED' ? (
                <AlertCircle className='size-3.5 text-status-error' />
              ) : (
                <Info className='size-3.5 text-status-warning' />
              )}
              <span>试跑结果</span>
            </Button>
          ) : null}

          {canWrite && (dirty || unpublishedDraft) ? (
            <Button
              size='sm'
              variant='outline'
              disabled={!canPublish || publishing}
              loading={publishing}
              onClick={onPublish}
            >
              发布
            </Button>
          ) : null}

          {/* 更多下拉菜单（挂载助手/笔记本/窄屏下承接次要操作，大屏承接高级操作） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size='sm' variant='outline'>
                更多
                <ChevronDown className='size-3.5 ml-1' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-52'>
              {/* 空间不足时（如挂载侧边栏或小屏）收纳进菜单的操作 */}
              {!showExpandedShortcuts ? (
                <>
                  <ObjectSchedules
                    context={{
                      type: 'scenario_run',
                      targetId: scenario.targetId,
                      objectId: scenario.id,
                      name: scenario.name,
                      versionId: scenario.latestVersionId,
                    }}
                    trigger={({ onClick }) => (
                      <DropdownMenuItem onSelect={onClick}>
                        <CalendarClock className='mr-2 size-3.5 shrink-0' />
                        <span className='whitespace-nowrap'>定时任务</span>
                      </DropdownMenuItem>
                    )}
                  />
                  <DropdownMenuItem asChild>
                    <Link to='/outbound' search={{ tab: 'results', scenarioId: scenario.id }}>
                      <Send className='mr-2 size-3.5 shrink-0' />
                      <span className='whitespace-nowrap'>结果推送</span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}

              {/* 常规操作项（场景配置在顶栏已有常驻入口，此处不再重复呈现） */}
              {canWrite && !dirty && !unpublishedDraft ? (
                <DropdownMenuItem disabled={!canPublish || publishing} onClick={onPublish}>
                  <span className='whitespace-nowrap'>发布</span>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!canStartFormalRun} onClick={onOpenRun}>
                <span className='whitespace-nowrap'>运行已发布版本</span>
              </DropdownMenuItem>
              {canRecord ? (
                <DropdownMenuItem
                  disabled={disabled}
                  onClick={onOpenImport}
                  data-testid='toolbar-more-import-item'
                >
                  <Zap className='mr-2 size-3.5 text-primary shrink-0' />
                  <span className='whitespace-nowrap'>导入已有录制</span>
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onOpenRename}>
                    <span className='whitespace-nowrap'>重命名</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={disabled} onClick={onToggleStatus}>
                    <span className='whitespace-nowrap'>{scenario?.status === 'active' ? '停用' : '启用'}</span>
                  </DropdownMenuItem>
                </>
              ) : null}
              {canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className='text-destructive' onClick={onOpenRemove}>
                    <span className='whitespace-nowrap'>删除</span>
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </header>
  )
}

export { StudioToolbar as StudioHeaderBar }
