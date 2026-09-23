import { useEffect, useState } from 'react'
import type { JsonValue, SuiteMember } from '@cairn/shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { KeyValueEditor } from './key-value-editor'

export function MemberInputDialog({
  open,
  onOpenChange,
  member,
  scenarioName,
  onSave,
  disabled = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: SuiteMember | null
  scenarioName?: string
  onSave: (memberId: string, input: Record<string, JsonValue>) => void
  disabled?: boolean
}) {
  const [localInput, setLocalInput] = useState<Record<string, JsonValue>>({})

  useEffect(() => {
    if (member) {
      setLocalInput({ ...(member.input ?? {}) })
    }
  }, [member])

  if (!member) return null

  function handleConfirm() {
    if (member) {
      onSave(member.memberId, localInput)
      onOpenChange(false)
    }
  }

  const targetTitle = member.displayName || scenarioName || member.memberId

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-xl max-h-[90vh] overflow-y-auto'>
        <DialogHeader className='pr-8 text-left space-y-1.5'>
          <DialogTitle className='break-words text-section font-semibold leading-snug'>
            成员参数覆盖 · {targetTitle}
          </DialogTitle>
          <DialogDescription className='text-label text-muted-foreground'>
            为该成员指定独立参数。此处的同名参数将覆盖集合全局公共参数 (Shared Input)。
          </DialogDescription>
        </DialogHeader>

        <div className='py-2 space-y-3.5'>
          <details className='rounded-lg border border-border-card bg-muted/20 p-2.5 text-label text-muted-foreground transition-colors'>
            <summary className='cursor-pointer font-medium text-foreground inline-flex items-center gap-1.5 select-none'>
              <span>💡</span>
              <span>跨阶段变量动态透传说明 (可选)</span>
            </summary>
            <div className='mt-2 space-y-1.5 pt-2 border-t border-border-divider/50'>
              <p>
                若处于多阶段编排中，支持在参数值中引用前序阶段成员产出的指标与业务数据：
              </p>
              <code className='block rounded border border-border-card bg-card px-2 py-1 font-mono text-small text-foreground select-all'>
                {'${stage[stageId].members[memberId].output.customData.key}'}
              </code>
              <p className='text-small text-muted-foreground/80'>
                * 调度引擎将在前序阶段执行完毕后延迟注入，禁止同阶段内或向前引用。
              </p>
            </div>
          </details>

          <KeyValueEditor
            value={localInput}
            onChange={setLocalInput}
            disabled={disabled}
            placeholderKey='覆盖参数名'
            placeholderValue='覆盖参数值 (支持 ${stage[...]} 语法)'
          />
        </div>

        <DialogFooter className='gap-2 sm:gap-2'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={disabled} onClick={handleConfirm}>
            保存覆盖
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
