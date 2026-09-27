import { useEffect, useState, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  useKeybindingsStore,
  serializeKeyboardEvent,
  validateKeybinding,
  type KeybindingItem,
} from '@/stores/keybindings-store'
import { toast } from 'sonner'
import { AlertCircle, RotateCcw, Keyboard } from 'lucide-react'

interface KeyRecordDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  command: KeybindingItem | null
  onSaved?: () => void
}

export function KeyRecordDialog({
  open,
  onOpenChange,
  command,
  onSaved,
}: KeyRecordDialogProps) {
  const [recordedKey, setRecordedKey] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const inputAreaRef = useRef<HTMLDivElement>(null)

  const effectiveKey = command
    ? useKeybindingsStore.getState().getEffectiveKey(command.id)
    : ''
  const isCustom = command
    ? useKeybindingsStore.getState().isCustomized(command.id)
    : false

  useEffect(() => {
    if (open && command) {
      const curKey = useKeybindingsStore.getState().getEffectiveKey(command.id)
      setRecordedKey(curKey)
      setErrorMsg(null)
      setTimeout(() => {
        inputAreaRef.current?.focus()
      }, 50)
    }
  }, [open, command])

  if (!command) return null

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') {
      onOpenChange(false)
      return
    }

    const shortcut = serializeKeyboardEvent(e.nativeEvent)
    if (!shortcut) {
      // 正在按下单修饰键（如仅按下了 Cmd 或 Ctrl）
      return
    }

    setRecordedKey(shortcut)

    const allBindings: Record<string, string> = {}
    for (const cmd of useKeybindingsStore.getState().commands) {
      allBindings[cmd.id] = useKeybindingsStore.getState().getEffectiveKey(cmd.id)
    }

    const validation = validateKeybinding(shortcut, command.id, allBindings)
    if (!validation.ok) {
      setErrorMsg(validation.reason)
    } else {
      setErrorMsg(null)
    }
  }

  const handleSave = () => {
    if (!recordedKey || errorMsg) return
    const res = useKeybindingsStore.getState().setCustomKey(command.id, recordedKey)
    if (res.ok) {
      toast.success(`已更新「${command.label}」快捷键`)
      onOpenChange(false)
      onSaved?.()
    } else {
      setErrorMsg(res.reason || '设置快捷键失败')
    }
  }

  const handleResetToDefault = () => {
    useKeybindingsStore.getState().resetCommand(command.id)
    toast.success(`已恢复「${command.label}」默认快捷键`)
    onOpenChange(false)
    onSaved?.()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md' data-testid='key-record-dialog'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Keyboard className='size-5 text-muted-foreground' />
            修改快捷键
          </DialogTitle>
          <DialogDescription>
            为「<span className='font-medium text-foreground'>{command.label}</span>」录制新的快捷键组合。
          </DialogDescription>
        </DialogHeader>

        <div className='space-y-4 py-3'>
          <div
            ref={inputAreaRef}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onClick={() => inputAreaRef.current?.focus()}
            className='flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-primary/50 bg-accent/20 p-6 text-center outline-none ring-primary/20 transition-all focus:border-primary focus:ring-4 select-none cursor-pointer'
            data-testid='shortcut-capture-area'
            aria-label='按键录制捕获区'
          >
            <span className='text-xs text-muted-foreground'>
              直接在键盘上按下目标组合键（必须包含 Ctrl、Alt 或 Cmd 修饰键）
            </span>

            <div className='flex items-center justify-center min-h-[36px]'>
              {recordedKey ? (
                <Kbd shortcut={recordedKey} size='lg' className='shadow-sm' />
              ) : (
                <span className='text-sm text-muted-foreground animate-pulse'>
                  等待按键中...
                </span>
              )}
            </div>
          </div>

          {errorMsg ? (
            <div
              className='flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive'
              role='alert'
              data-testid='shortcut-error-msg'
            >
              <AlertCircle className='size-4 shrink-0' />
              <span>{errorMsg}</span>
            </div>
          ) : (
            <div className='flex items-center justify-between text-xs text-muted-foreground px-1'>
              <span>默认键位：<Kbd shortcut={command.defaultKey} size='sm' /></span>
              {isCustom ? (
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={handleResetToDefault}
                  className='h-6 px-2 text-xs text-muted-foreground hover:text-foreground'
                >
                  <RotateCcw className='mr-1 size-3' />
                  恢复此命令默认
                </Button>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter className='flex items-center justify-between sm:justify-between'>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            onClick={handleSave}
            disabled={!recordedKey || Boolean(errorMsg) || recordedKey === effectiveKey}
            data-testid='save-shortcut-btn'
          >
            保存生效
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
