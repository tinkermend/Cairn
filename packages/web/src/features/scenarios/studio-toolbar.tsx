import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Bell,
  CalendarClock,
  ChevronDown,
  Edit2,
  Play,
  Save,
  Sparkles,
} from 'lucide-react'
import type {
  AssistantCapabilityId,
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
import { SCENARIO_STATUS_LABELS } from './labels'

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
  canPublish: boolean
  unpublishedDraft: boolean
  compileOk: boolean | undefined
  canReadTarget: boolean
  canAssist: boolean
  canPropose: boolean
  canRecord: boolean
  canDelete: boolean
  disabled: boolean
  onSave: () => void
  onPublish: () => void
  onStartTrial: () => void
  onOpenRun: () => void
  onOpenImport: () => void
  onOpenRename: () => void
  onToggleStatus: () => void
  onOpenRemove: () => void
  onOpenAssistant: (question: string, hint: AssistantCapabilityId) => void
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
  canPublish,
  unpublishedDraft,
  compileOk,
  canReadTarget,
  canAssist,
  canPropose,
  canRecord,
  canDelete,
  disabled,
  onSave,
  onPublish,
  onStartTrial,
  onOpenRun,
  onOpenImport,
  onOpenRename,
  onToggleStatus,
  onOpenRemove,
  onOpenAssistant,
  onLeave,
}: StudioToolbarProps) {
  return (
    <header className='flex h-14 shrink-0 items-center justify-between border-b border-border-divider bg-card px-3 sm:px-4 shadow-sm gap-2'>
      {/* 左侧：返回、场景标识与状态胶囊 */}
      <div className='flex min-w-0 items-center gap-2 sm:gap-3'>
        <Link
          to='/scenarios'
          className='inline-flex shrink-0 items-center gap-1.5 text-body text-muted-foreground hover:text-foreground'
          onClick={onLeave}
          title='返回场景编排'
        >
          <ArrowLeft className='size-4' />
          <span className='hidden md:inline'>返回场景编排</span>
        </Link>
        <span className='hidden sm:block h-4 w-px bg-border-divider shrink-0' />
        <div className='flex min-w-0 items-center gap-1.5 shrink-0 max-w-[130px] sm:max-w-[180px] xl:max-w-[240px] 2xl:max-w-[320px]'>
          <h1 className='truncate text-body font-semibold text-foreground' title={scenario?.name ?? '场景'}>
            {scenario?.name ?? '场景'}
          </h1>
          {canWrite ? (
            <Button
              size='icon'
              variant='ghost'
              className='size-6 shrink-0 text-muted-foreground hover:text-foreground'
              title='重命名'
              onClick={onOpenRename}
            >
              <Edit2 className='size-3.5' />
              <span className='sr-only'>重命名</span>
            </Button>
          ) : null}
        </div>

        {/* 紧凑上下文胶囊：目标系统、版本、草稿、状态 */}
        {scenario ? (
          <div className='hidden sm:flex items-center gap-2 rounded-full border border-border-default bg-surface-subtle px-2.5 py-1 text-label whitespace-nowrap shrink-0 overflow-hidden'>
            <div className='flex items-center gap-1 min-w-0'>
              <span className='hidden 2xl:inline text-muted-foreground'>目标系统</span>
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
              <span className='hidden 2xl:inline text-muted-foreground'>已发布</span>
              <span className='font-medium'>v{scenario.latestVersionNo}</span>
            </div>
            <span className='h-3 w-px bg-border-divider shrink-0' />
            <div className='flex items-center gap-1 shrink-0'>
              <span className='hidden 2xl:inline text-muted-foreground'>草稿</span>
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
        <div className='flex items-center gap-1.5 sm:gap-2 shrink-0'>
          {/* 大屏快捷操作（>= 2xl 展开为独立按钮） */}
          <ObjectSchedules
            size='sm'
            className='hidden 2xl:inline-flex'
            context={{
              type: 'scenario_run',
              targetId: scenario.targetId,
              objectId: scenario.id,
              name: scenario.name,
              versionId: scenario.latestVersionId,
            }}
          />
          <Button variant='outline' size='sm' asChild className='hidden 2xl:inline-flex'>
            <Link to='/notifications' search={{ tab: 'results', scenarioId: scenario.id }}>
              <Bell className='size-3.5 mr-1' />
              结果通知
            </Link>
          </Button>

          {canAssist && canReadTarget ? (
            <Button
              size='sm'
              variant='outline'
              className='hidden 2xl:inline-flex'
              onClick={() => onOpenAssistant('解释当前步骤', 'scenario.explain')}
            >
              <Sparkles className='size-3.5 text-ai-foreground mr-1' />
              解释步骤
            </Button>
          ) : null}

          {canPropose ? (
            <Button
              size='sm'
              variant='outline'
              className='hidden 2xl:inline-flex'
              onClick={() => onOpenAssistant('把这条指令写清楚', 'scenario.propose-step')}
            >
              修改建议
            </Button>
          ) : null}

          {/* 核心主动作（各分辨率均保持可达） */}
          {canWrite ? (
            <Button
              size='sm'
              variant={dirty ? 'default' : 'outline'}
              disabled={!dirty || saving}
              loading={saving}
              onClick={onSave}
            >
              <Save className='size-3.5 mr-1' />
              保存草稿
            </Button>
          ) : null}

          {canTrial ? (
            <Button size='sm' onClick={onStartTrial}>
              <Play className='size-3.5 mr-1' />
              试跑
            </Button>
          ) : canStartFormalRun ? (
            <Button size='sm' variant='outline' disabled title={trialDisabledReason}>
              <Play className='size-3.5 mr-1' />
              试跑
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

          {/* 更多下拉菜单（笔记本/窄屏下承接次要操作，大屏承接高级操作） */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size='sm' variant='outline'>
                更多
                <ChevronDown className='size-3.5 ml-1' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-48'>
              {/* 窄屏下收纳进菜单的操作 */}
              <ObjectSchedules
                context={{
                  type: 'scenario_run',
                  targetId: scenario.targetId,
                  objectId: scenario.id,
                  name: scenario.name,
                  versionId: scenario.latestVersionId,
                }}
                trigger={({ onClick }) => (
                  <DropdownMenuItem onSelect={onClick} className='2xl:hidden'>
                    <CalendarClock className='mr-2 size-3.5' />
                    定时任务
                  </DropdownMenuItem>
                )}
              />
              <DropdownMenuItem asChild className='2xl:hidden'>
                <Link to='/notifications' search={{ tab: 'results', scenarioId: scenario.id }}>
                  <Bell className='mr-2 size-3.5' />
                  结果通知
                </Link>
              </DropdownMenuItem>
              {canAssist && canReadTarget ? (
                <DropdownMenuItem
                  className='2xl:hidden'
                  onClick={() => onOpenAssistant('解释当前步骤', 'scenario.explain')}
                >
                  <Sparkles className='mr-2 size-3.5 text-ai-foreground' />
                  解释当前步骤
                </DropdownMenuItem>
              ) : null}
              {canPropose ? (
                <DropdownMenuItem
                  className='2xl:hidden'
                  onClick={() => onOpenAssistant('把这条指令写清楚', 'scenario.propose-step')}
                >
                  <Sparkles className='mr-2 size-3.5 text-ai-foreground' />
                  修改建议
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator className='2xl:hidden' />

              {/* 常规操作项 */}
              {canWrite && !dirty && !unpublishedDraft ? (
                <DropdownMenuItem disabled={!canPublish || publishing} onClick={onPublish}>
                  发布
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem disabled={!canStartFormalRun} onClick={onOpenRun}>
                运行已发布版本
              </DropdownMenuItem>
              {canRecord ? (
                <DropdownMenuItem disabled={disabled} onClick={onOpenImport}>
                  导入已有录制
                </DropdownMenuItem>
              ) : null}
              {canWrite ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onOpenRename}>
                    重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={disabled} onClick={onToggleStatus}>
                    {scenario?.status === 'active' ? '停用' : '启用'}
                  </DropdownMenuItem>
                </>
              ) : null}
              {canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className='text-destructive' onClick={onOpenRemove}>
                    删除
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
