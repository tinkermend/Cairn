import { useState } from 'react'
import type { SuiteMember, SuiteStage } from '@cairn/shared'
import { ArrowDown, ArrowUp, ChevronDown, Plus, Search, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MemberNode } from './member-node'
import { MemberPickerDialog } from './member-picker-dialog'

export function StageCard({
  stage,
  stageIndex,
  totalStages,
  canWrite,
  scenarioNames,
  availableScenarios,
  targetAccounts,
  targetId,
  onUpdateStageName,
  onUpdateStageMode,
  onUpdateStageConcurrency,
  onUpdateStageFailurePolicy,
  onMoveStage,
  onRemoveStage,
  onAddMember,
  onUpdateMember,
  onMoveMember,
  onRemoveMember,
  onOpenInputEditor,
}: {
  stage: SuiteStage
  stageIndex: number
  totalStages: number
  canWrite: boolean
  scenarioNames: Map<string, string>
  availableScenarios: Array<{ id: string; name: string; latestVersionId?: string }>
  targetAccounts: Array<{ id: string; displayName: string; username: string }>
  targetId: string
  onUpdateStageName: (name: string) => void
  onUpdateStageMode: (mode: 'parallel' | 'sequential') => void
  onUpdateStageConcurrency: (concurrency: number) => void
  onUpdateStageFailurePolicy: (policy: 'continue' | 'stop') => void
  onMoveStage: (delta: number) => void
  onRemoveStage: () => void
  onAddMember: (scenarioId: string) => void
  onUpdateMember: (memberIndex: number, updater: (m: SuiteMember) => SuiteMember) => void
  onMoveMember: (memberIndex: number, delta: number) => void
  onRemoveMember: (memberIndex: number) => void
  onOpenInputEditor: (member: SuiteMember) => void
}) {
  const isLast = stageIndex === totalStages - 1
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className='flex flex-col'>
      {/* Stage Container: subtle cool tint background for visual depth */}
      <div className='rounded-xl border border-border-card bg-muted/20 p-4 shadow-card space-y-4'>
        {/* Stage Header: Structured 2-row layout for rock-solid alignment */}
        <div className='border-b border-border-divider pb-3.5 space-y-2.5'>
          {/* Row 1: Stage Identity and Action Buttons */}
          <div className='flex items-center justify-between gap-3'>
            <div className='flex items-center gap-2 min-w-0 flex-1'>
              <Badge
                variant='outline'
                className='font-mono text-label bg-card shadow-xs shrink-0 cursor-default'
                title={`阶段标识: ${stage.id}`}
              >
                Stage {stage.ordinal + 1}
              </Badge>
              <div className='flex-1 max-w-sm min-w-0'>
                <Input
                  value={stage.name ?? ''}
                  disabled={!canWrite}
                  aria-label={`阶段 ${stage.ordinal + 1} 名称`}
                  placeholder='阶段名称'
                  className='h-8 w-full text-body font-medium bg-card'
                  onChange={(e) => onUpdateStageName(e.target.value)}
                />
              </div>
            </div>

            {/* Stage Reorder and Delete Actions */}
            {canWrite ? (
              <div className='flex items-center gap-0.5 shrink-0'>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-7 text-muted-foreground'
                  aria-label='上移阶段'
                  disabled={stageIndex === 0}
                  onClick={() => onMoveStage(-1)}
                >
                  <ArrowUp className='size-3.5' />
                </Button>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-7 text-muted-foreground'
                  aria-label='下移阶段'
                  disabled={stageIndex === totalStages - 1}
                  onClick={() => onMoveStage(1)}
                >
                  <ArrowDown className='size-3.5' />
                </Button>
                <Button
                  variant='ghost'
                  size='icon'
                  className='size-7 text-muted-foreground hover:text-destructive'
                  aria-label='删除阶段'
                  onClick={onRemoveStage}
                >
                  <Trash2 className='size-3.5' />
                </Button>
              </div>
            ) : null}
          </div>

          {/* Row 2: Execution Policy Controls Bar */}
          <div className='flex flex-wrap items-center gap-4 text-label'>
            {/* Mode Selector */}
            <div className='flex items-center gap-1.5'>
              <span className='text-label text-muted-foreground shrink-0'>执行模式:</span>
              <Select
                value={stage.executionMode}
                disabled={!canWrite}
                onValueChange={(val) => onUpdateStageMode(val as 'parallel' | 'sequential')}
              >
                <SelectTrigger className='h-7 w-32 text-label bg-card'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='parallel'>受控并发</SelectItem>
                  <SelectItem value='sequential'>严格串行</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Concurrency Input (if parallel) */}
            {stage.executionMode === 'parallel' ? (
              <div className='flex items-center gap-1.5'>
                <span className='text-label text-muted-foreground shrink-0'>并发数:</span>
                <Input
                  type='number'
                  min={1}
                  max={10}
                  value={stage.maxConcurrency ?? 3}
                  disabled={!canWrite}
                  className='h-7 w-16 text-label text-center bg-card'
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10)
                    if (!Number.isNaN(val)) {
                      onUpdateStageConcurrency(Math.max(1, Math.min(10, val)))
                    }
                  }}
                />
              </div>
            ) : null}

            {/* Failure Policy */}
            <div className='flex items-center gap-1.5'>
              <span className='text-label text-muted-foreground shrink-0'>失败策略:</span>
              <Select
                value={stage.failurePolicy}
                disabled={!canWrite}
                onValueChange={(val) => onUpdateStageFailurePolicy(val as 'continue' | 'stop')}
              >
                <SelectTrigger className='h-7 w-32 text-label bg-card'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='continue'>失败后继续</SelectItem>
                  <SelectItem value='stop'>遇错即停</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Members List */}
        <div className='space-y-2.5'>
          {stage.members.length === 0 ? (
            <div className='rounded-lg border border-dashed border-border-divider bg-card/60 p-6 text-center text-label text-muted-foreground'>
              此阶段暂无场景成员，请在下方选择场景加入。
            </div>
          ) : (
            stage.members.map((member, mIdx) => (
              <MemberNode
                key={member.memberId}
                member={member}
                canWrite={canWrite}
                scenarioName={scenarioNames.get(member.scenarioId) ?? member.scenarioId.slice(0, 8)}
                targetAccounts={targetAccounts}
                targetId={targetId}
                canMoveUp={mIdx > 0}
                canMoveDown={mIdx < stage.members.length - 1}
                onUpdateDisplayName={(displayName) =>
                  onUpdateMember(mIdx, (m) => ({ ...m, displayName }))
                }
                onUpdateAccount={(targetAccountId) =>
                  onUpdateMember(mIdx, (m) => ({ ...m, targetAccountId }))
                }
                onUpdateReportProfile={(reportProfileId) =>
                  onUpdateMember(mIdx, (m) => ({ ...m, reportProfileId }))
                }
                onOpenInputEditor={() => onOpenInputEditor(member)}
                onMove={(delta) => onMoveMember(mIdx, delta)}
                onRemove={() => onRemoveMember(mIdx)}
              />
            ))
          )}
        </div>

        {/* Add Member Actions */}
        {canWrite ? (
          <div className='flex items-center gap-2 pt-1'>
            {/* Quick dropdown select (compatible with tests and fast picking) */}
            <Select onValueChange={(scenarioId) => onAddMember(scenarioId)}>
              <SelectTrigger
                className='w-64 h-8 text-label bg-card'
                aria-label={`为阶段 ${stage.ordinal + 1} 添加场景`}
              >
                <div className='flex items-center gap-1.5'>
                  <Plus className='size-3.5' />
                  <SelectValue placeholder='添加场景至此阶段' />
                </div>
              </SelectTrigger>
              <SelectContent>
                {availableScenarios.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    <span className='inline-flex items-center gap-1.5'>
                      <Plus className='size-3 text-muted-foreground' />
                      {item.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Enhanced dialog browser for larger libraries */}
            <Button
              variant='outline'
              size='sm'
              className='h-8 text-label bg-card'
              onClick={() => setPickerOpen(true)}
              title='在场景库中搜索并选择'
            >
              <Search className='size-3.5 mr-1.5' />
              查找场景...
            </Button>
          </div>
        ) : null}
      </div>

      {/* Downward Pipeline Connector between Stages */}
      {!isLast ? (
        <div className='flex flex-col items-center py-2.5'>
          <div className='h-3 w-px bg-border' />
          <div className='flex size-6 items-center justify-center rounded-full border border-border bg-card shadow-xs text-muted-foreground'>
            <ChevronDown className='size-3.5 text-primary' />
          </div>
          <div className='h-3 w-px bg-border' />
        </div>
      ) : null}

      <MemberPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        availableScenarios={availableScenarios}
        title={`选择场景加入 Stage ${stage.ordinal + 1} (${stage.name})`}
        onSelectScenario={onAddMember}
      />
    </div>
  )
}
