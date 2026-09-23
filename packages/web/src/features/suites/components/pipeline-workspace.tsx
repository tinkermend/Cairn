import { useState } from 'react'
import type { SuiteDocument, SuiteMember } from '@cairn/shared'
import { Layers, Plus, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StageCard } from './stage-card'
import { MemberNode } from './member-node'
import { MemberPickerDialog } from './member-picker-dialog'

export function PipelineWorkspace({
  document,
  isStageMode,
  canWrite,
  scenarioNames,
  availableScenarios,
  targetAccounts,
  targetId,
  onToggleStageMode,
  onAddStage,
  onMoveStage,
  onRemoveStage,
  onUpdateStageName,
  onUpdateStageMode,
  onUpdateStageConcurrency,
  onUpdateStageFailurePolicy,
  onAddMemberToStage,
  onUpdateMemberInStage,
  onMoveMemberInStage,
  onRemoveMemberFromStage,
  onAddMemberFlat,
  onUpdateMemberFlat,
  onMoveMemberFlat,
  onRemoveMemberFlat,
  onOpenInputEditor,
}: {
  document: SuiteDocument
  isStageMode: boolean
  canWrite: boolean
  scenarioNames: Map<string, string>
  availableScenarios: Array<{ id: string; name: string; latestVersionId?: string }>
  targetAccounts: Array<{ id: string; displayName: string; username: string }>
  targetId: string
  onToggleStageMode: () => void
  onAddStage: () => void
  onMoveStage: (index: number, delta: number) => void
  onRemoveStage: (index: number) => void
  onUpdateStageName: (index: number, name: string) => void
  onUpdateStageMode: (index: number, mode: 'parallel' | 'sequential') => void
  onUpdateStageConcurrency: (index: number, val: number) => void
  onUpdateStageFailurePolicy: (index: number, policy: 'continue' | 'stop') => void
  onAddMemberToStage: (stageIndex: number, scenarioId: string) => void
  onUpdateMemberInStage: (stageIndex: number, memberIndex: number, updater: (m: SuiteMember) => SuiteMember) => void
  onMoveMemberInStage: (stageIndex: number, memberIndex: number, delta: number) => void
  onRemoveMemberFromStage: (stageIndex: number, memberIndex: number) => void
  onAddMemberFlat: (scenarioId: string) => void
  onUpdateMemberFlat: (memberIndex: number, updater: (m: SuiteMember) => SuiteMember) => void
  onMoveMemberFlat: (memberIndex: number, delta: number) => void
  onRemoveMemberFlat: (memberIndex: number) => void
  onOpenInputEditor: (member: SuiteMember) => void
}) {
  const [flatPickerOpen, setFlatPickerOpen] = useState(false)
  const stages = document.stages ?? []

  return (
    <div className='flex flex-col gap-4'>
      {/* Workspace Header Toolbar */}
      <div className='flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border-card bg-card p-4 shadow-card'>
        <div>
          <div className='flex items-center gap-2'>
            <h2 className='text-title'>流水线编排</h2>
            {isStageMode ? (
              <Badge variant='outline' className='font-normal text-label text-primary border-primary/30'>
                多阶段依赖编排 ({stages.length} 个阶段)
              </Badge>
            ) : (
              <Badge variant='outline' className='font-normal text-label text-muted-foreground'>
                平铺序列 ({document.members.length} 个场景)
              </Badge>
            )}
          </div>
          <p className='text-label text-muted-foreground mt-0.5'>
            {isStageMode
              ? '阶段间串行流水线执行，前置阶段满足放行策略后流转至下一阶段，支持跨阶段变量动态透传。'
              : '按列表顺序执行已发布场景，支持参数覆盖与独立账号指派。'}
          </p>
        </div>

        <div className='flex items-center gap-2'>
          {canWrite ? (
            <Button
              variant='outline'
              size='sm'
              onClick={onToggleStageMode}
              className='h-8 text-label'
            >
              <Layers className='size-3.5 mr-1.5' />
              {isStageMode ? '切换为平铺模式' : '启用多阶段编排'}
            </Button>
          ) : null}

          {!isStageMode && canWrite ? (
            <div className='flex items-center gap-1.5'>
              <Select onValueChange={onAddMemberFlat}>
                <SelectTrigger className='w-48 h-8 text-label' aria-label='添加成员场景'>
                  <div className='flex items-center gap-1.5'>
                    <Plus className='size-3.5' />
                    <SelectValue placeholder='添加已发布场景' />
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
              <Button
                variant='outline'
                size='sm'
                className='h-8 text-label'
                onClick={() => setFlatPickerOpen(true)}
                title='在场景库中搜索并选择'
              >
                <Search className='size-3.5 mr-1.5' />
                查找...
              </Button>
            </div>
          ) : null}

          {isStageMode && canWrite ? (
            <Button size='sm' onClick={onAddStage} className='h-8 text-label'>
              <Plus className='size-3.5 mr-1.5' />
              添加阶段
            </Button>
          ) : null}
        </div>
      </div>

      {/* Stage Mode Content */}
      {isStageMode ? (
        <div className='flex flex-col gap-2'>
          {stages.length === 0 ? (
            <div className='rounded-xl border border-dashed border-border-divider bg-card/60 p-8 text-center text-label text-muted-foreground'>
              暂无阶段。点击上方“添加阶段”开启流水线编排。
            </div>
          ) : (
            stages.map((stage, stageIndex) => (
              <StageCard
                key={stage.id}
                stage={stage}
                stageIndex={stageIndex}
                totalStages={stages.length}
                canWrite={canWrite}
                scenarioNames={scenarioNames}
                availableScenarios={availableScenarios}
                targetAccounts={targetAccounts}
                targetId={targetId}
                onUpdateStageName={(name) => onUpdateStageName(stageIndex, name)}
                onUpdateStageMode={(mode) => onUpdateStageMode(stageIndex, mode)}
                onUpdateStageConcurrency={(concurrency) => onUpdateStageConcurrency(stageIndex, concurrency)}
                onUpdateStageFailurePolicy={(policy) => onUpdateStageFailurePolicy(stageIndex, policy)}
                onMoveStage={(delta) => onMoveStage(stageIndex, delta)}
                onRemoveStage={() => onRemoveStage(stageIndex)}
                onAddMember={(scenarioId) => onAddMemberToStage(stageIndex, scenarioId)}
                onUpdateMember={(memberIndex, updater) => onUpdateMemberInStage(stageIndex, memberIndex, updater)}
                onMoveMember={(memberIndex, delta) => onMoveMemberInStage(stageIndex, memberIndex, delta)}
                onRemoveMember={(memberIndex) => onRemoveMemberFromStage(stageIndex, memberIndex)}
                onOpenInputEditor={onOpenInputEditor}
              />
            ))
          )}

          {canWrite ? (
            <Button
              variant='outline'
              className='w-full border-dashed py-5 text-label text-muted-foreground hover:text-foreground mt-2'
              onClick={onAddStage}
            >
              <Plus className='size-4 mr-1.5' />
              添加新阶段 (Stage)
            </Button>
          ) : null}
        </div>
      ) : (
        /* Flat Mode Content */
        <div className='rounded-xl border border-border-card bg-card p-4 shadow-card space-y-3'>
          {document.members.length === 0 ? (
            <p className='py-8 text-center text-body text-muted-foreground'>
              还没有成员。添加至少一个已发布场景后才能发布。
            </p>
          ) : (
            document.members.map((member, index) => (
              <MemberNode
                key={member.memberId}
                member={member}
                canWrite={canWrite}
                scenarioName={scenarioNames.get(member.scenarioId) ?? member.scenarioId.slice(0, 8)}
                targetAccounts={targetAccounts}
                targetId={targetId}
                canMoveUp={index > 0}
                canMoveDown={index < document.members.length - 1}
                onUpdateDisplayName={(displayName) =>
                  onUpdateMemberFlat(index, (m) => ({ ...m, displayName }))
                }
                onUpdateAccount={(targetAccountId) =>
                  onUpdateMemberFlat(index, (m) => ({ ...m, targetAccountId }))
                }
                onUpdateReportProfile={(reportProfileId) =>
                  onUpdateMemberFlat(index, (m) => ({ ...m, reportProfileId }))
                }
                onOpenInputEditor={() => onOpenInputEditor(member)}
                onMove={(delta) => onMoveMemberFlat(index, delta)}
                onRemove={() => onRemoveMemberFlat(index)}
              />
            ))
          )}
        </div>
      )}

      {!isStageMode ? (
        <MemberPickerDialog
          open={flatPickerOpen}
          onOpenChange={setFlatPickerOpen}
          availableScenarios={availableScenarios}
          title='选择场景加入场景集'
          onSelectScenario={onAddMemberFlat}
        />
      ) : null}
    </div>
  )
}

