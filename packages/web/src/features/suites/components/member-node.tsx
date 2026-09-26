import type { SuiteMember } from '@cairn/shared'
import {
  ArrowDown,
  ArrowUp,
  FileText,
  GripVertical,
  Layers,
  Sliders,
  Trash2,
  User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ReportProfileSelect } from '@/features/reports/profiles'

export function MemberNode({
  member,
  canWrite,
  scenarioName,
  targetAccounts,
  targetId,
  canMoveUp,
  canMoveDown,
  onUpdateDisplayName,
  onUpdateAccount,
  onUpdateReportProfile,
  onOpenInputEditor,
  onMove,
  onRemove,
}: {
  member: SuiteMember
  canWrite: boolean
  scenarioName: string
  targetAccounts: Array<{ id: string; displayName: string; username: string }>
  targetId: string
  canMoveUp: boolean
  canMoveDown: boolean
  onUpdateDisplayName: (name: string) => void
  onUpdateAccount: (accountId: string | undefined) => void
  onUpdateReportProfile: (profileId: string | undefined) => void
  onOpenInputEditor: () => void
  onMove: (delta: number) => void
  onRemove: () => void
}) {
  const overrideCount = Object.keys(member.input ?? {}).length

  return (
    <div className='group rounded-lg border border-border-card bg-card p-3 shadow-card transition-colors hover:border-border space-y-2.5'>
      {/* Row 1: Primary Entity Row (Handle, Index, Scenario Name, Alias, Member ID, and Actions) */}
      <div className='flex items-center justify-between gap-3'>
        <div className='flex items-center gap-2.5 min-w-0 flex-1'>
          {/* Grip & Ordinal */}
          {canWrite ? (
            <div
              className='cursor-grab text-muted-foreground/40 hover:text-muted-foreground shrink-0'
              title='可拖拽调整顺序'
            >
              <GripVertical className='size-3.5' />
            </div>
          ) : null}
          <span
            className='flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-label text-muted-foreground cursor-default'
            title={`成员序号: ${member.ordinal + 1} (ID: ${member.memberId})`}
          >
            {member.ordinal + 1}
          </span>

          {/* Scenario Name (Primary Entity - prominent, never chopped) */}
          <div
            className='flex items-center gap-1.5 min-w-0 flex-1 font-medium text-body text-foreground truncate'
            title={`关联场景: ${scenarioName}`}
          >
            <Layers className='size-3.5 shrink-0 text-primary' />
            <span className='truncate'>{scenarioName}</span>
          </div>

          {/* Custom Alias Input (fixed width column) */}
          <div className='w-48 min-w-0 shrink-0'>
            <Input
              value={member.displayName ?? ''}
              disabled={!canWrite}
              aria-label={`${member.memberId} 展示名称`}
              placeholder='自定义别名 (可选)'
              className='h-7 text-label px-2'
              onChange={(e) => onUpdateDisplayName(e.target.value)}
            />
          </div>
        </div>

        {/* Row 1 Actions: Move Up / Down, Delete */}
        {canWrite ? (
          <div className='flex items-center gap-0.5 shrink-0'>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground'
              aria-label='上移'
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
            >
              <ArrowUp className='size-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground'
              aria-label='下移'
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
            >
              <ArrowDown className='size-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='size-7 text-muted-foreground hover:text-destructive'
              aria-label='移除'
              onClick={onRemove}
            >
              <Trash2 className='size-3.5' />
            </Button>
          </div>
        ) : null}
      </div>

      {/* Row 2: Secondary Configuration Bar (Target Account, Input Overrides, Report Config) */}
      <div className='flex items-center justify-between gap-3 pt-2 border-t border-border-divider/70 text-label'>
        <div className='flex items-center gap-3 min-w-0 flex-1'>
          {/* Target Account Select - Fixed column width, strictly constrained to avoid any overflow */}
          <div className='w-64 min-w-0 shrink-0'>
            <Select
              value={member.targetAccountId ?? '__default__'}
              disabled={!canWrite}
              onValueChange={(val) => onUpdateAccount(val === '__default__' ? undefined : val)}
            >
              <SelectTrigger
                aria-label={`${member.memberId} 目标账号`}
                className='h-7 w-full min-w-0 text-label px-2.5 overflow-hidden'
              >
                <div className='flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden'>
                  <User className='size-3 shrink-0 text-muted-foreground' />
                  <SelectValue placeholder='跟随集合默认账号' />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__default__'>跟随集合默认账号</SelectItem>
                {targetAccounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.displayName} ({account.username})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Input Override Button */}
          <Button
            variant={overrideCount > 0 ? 'secondary' : 'outline'}
            size='sm'
            className='h-7 text-label shrink-0 px-2.5 gap-1.5'
            disabled={!canWrite}
            onClick={onOpenInputEditor}
            title='配置成员独立参数覆盖'
          >
            <Sliders className='size-3 text-muted-foreground' />
            {overrideCount > 0 ? `已覆盖 (${overrideCount})` : '配置覆盖'}
          </Button>
        </div>

        {/* Sub-report collapsible */}
        <div className='shrink-0'>
          <details className='text-label'>
            <summary className='cursor-pointer text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-label'>
              <FileText className='size-3' />
              子报告配置
            </summary>
            <div className='mt-1.5 min-w-[200px]'>
              <ReportProfileSelect
                targetId={targetId}
                source='RUN'
                label={`${member.memberId} 子报告默认配置`}
                value={member.reportProfileId}
                disabled={!canWrite}
                onChange={onUpdateReportProfile}
              />
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}
