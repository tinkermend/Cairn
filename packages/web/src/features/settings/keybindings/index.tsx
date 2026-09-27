import { useState } from 'react'
import { ContentSection } from '../components/content-section'
import {
  useKeybindingsStore,
  type KeybindingItem,
} from '@/stores/keybindings-store'
import { Kbd } from '@/components/ui/kbd'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { getPlatform } from '@/lib/platform'
import { KeyRecordDialog } from './key-record-dialog'
import { RotateCcw, Pencil, Monitor, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

export function SettingsKeybindings() {
  const commands = useKeybindingsStore((s) => s.commands)
  const customBindings = useKeybindingsStore((s) => s.customBindings)
  const getEffectiveKey = useKeybindingsStore((s) => s.getEffectiveKey)
  const isCustomized = useKeybindingsStore((s) => s.isCustomized)
  const resetCommand = useKeybindingsStore((s) => s.resetCommand)
  const resetAll = useKeybindingsStore((s) => s.resetAll)

  const [editingCommand, setEditingCommand] = useState<KeybindingItem | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const platform = getPlatform()
  const platformLabel =
    platform === 'mac' ? 'macOS (Command ⌘)' : 'Windows / Linux (Ctrl)'

  const hasAnyCustom = Object.keys(customBindings).length > 0

  const handleOpenEdit = (cmd: KeybindingItem) => {
    setEditingCommand(cmd)
    setDialogOpen(true)
  }

  const handleResetSingle = (cmd: KeybindingItem) => {
    resetCommand(cmd.id)
    toast.success(`已恢复「${cmd.label}」默认快捷键`)
  }

  const handleResetAll = () => {
    resetAll()
    toast.success('已恢复所有快捷键至平台默认')
  }

  const globalCommands = commands.filter((c) => c.category === 'global')
  const studioCommands = commands.filter((c) => c.category === 'studio')

  return (
    <ContentSection
      title='快捷键偏好'
      desc='自定义平台全局与核心编辑快捷键，解决浏览器与扩展冲突。设置将保存在当前浏览器本地。'
    >
      <div className='space-y-6' data-testid='settings-keybindings-page'>
        {/* 顶部平台自适应提示与全局重置 */}
        <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 p-3'>
          <div className='flex items-center gap-2 text-label text-muted-foreground'>
            <Monitor className='size-4 text-primary' />
            <span>
              已根据当前系统自动适配键帽：
              <span className='font-medium text-foreground'>{platformLabel}</span>
            </span>
          </div>

          {hasAnyCustom ? (
            <Button
              variant='outline'
              size='sm'
              onClick={handleResetAll}
              className='h-7 text-label text-muted-foreground hover:text-foreground'
              data-testid='reset-all-shortcuts-btn'
            >
              <RotateCcw className='mr-1.5 size-3.5' />
              恢复全部默认
            </Button>
          ) : null}
        </div>

        {/* 分组 1: 全局捷径 */}
        <div className='space-y-3'>
          <div className='flex items-center gap-2'>
            <Sparkles className='size-4 text-primary' />
            <h4 className='text-section font-semibold text-foreground'>
              全局操作
            </h4>
          </div>
          <div className='rounded-lg border divide-y divide-border/60 overflow-hidden'>
            {globalCommands.map((cmd) => {
              const effectiveKey = getEffectiveKey(cmd.id)
              const customized = isCustomized(cmd.id)
              return (
                <div
                  key={cmd.id}
                  className='flex items-center justify-between gap-4 p-3.5 hover:bg-muted/20 transition-colors'
                  data-testid={`keybinding-row-${cmd.id}`}
                >
                  <div className='flex items-center gap-2'>
                    <span className='text-body font-medium text-foreground'>
                      {cmd.label}
                    </span>
                    {customized ? (
                      <Badge variant='outline' className='border-status-info-accent/40 px-1.5 py-0 text-label text-status-info-foreground'>
                        已自定义
                      </Badge>
                    ) : null}
                  </div>

                  <div className='flex items-center gap-2.5'>
                    <Kbd shortcut={effectiveKey} size='default' />

                    {customized ? (
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => handleResetSingle(cmd)}
                        className='size-8 text-muted-foreground hover:text-foreground'
                        title='恢复默认'
                        data-testid={`reset-shortcut-${cmd.id}`}
                      >
                        <RotateCcw className='size-3.5' />
                      </Button>
                    ) : null}

                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => handleOpenEdit(cmd)}
                      className='h-8 px-2.5 text-label'
                      data-testid={`edit-shortcut-${cmd.id}`}
                    >
                      <Pencil className='mr-1 size-3' />
                      修改
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 分组 2: 场景 Studio 操作 */}
        <div className='space-y-3'>
          <h4 className='text-section font-semibold text-foreground'>
            场景编排 Studio
          </h4>
          <div className='rounded-lg border divide-y divide-border/60 overflow-hidden'>
            {studioCommands.map((cmd) => {
              const effectiveKey = getEffectiveKey(cmd.id)
              const customized = isCustomized(cmd.id)
              return (
                <div
                  key={cmd.id}
                  className='flex items-center justify-between gap-4 p-3.5 hover:bg-muted/20 transition-colors'
                  data-testid={`keybinding-row-${cmd.id}`}
                >
                  <div className='flex items-center gap-2'>
                    <span className='text-body font-medium text-foreground'>
                      {cmd.label}
                    </span>
                    {customized ? (
                      <Badge variant='outline' className='border-status-info-accent/40 px-1.5 py-0 text-label text-status-info-foreground'>
                        已自定义
                      </Badge>
                    ) : null}
                  </div>

                  <div className='flex items-center gap-2.5'>
                    <Kbd shortcut={effectiveKey} size='default' />

                    {customized ? (
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => handleResetSingle(cmd)}
                        className='size-8 text-muted-foreground hover:text-foreground'
                        title='恢复默认'
                        data-testid={`reset-shortcut-${cmd.id}`}
                      >
                        <RotateCcw className='size-3.5' />
                      </Button>
                    ) : null}

                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => handleOpenEdit(cmd)}
                      className='h-8 px-2.5 text-label'
                      data-testid={`edit-shortcut-${cmd.id}`}
                    >
                      <Pencil className='mr-1 size-3' />
                      修改
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 改键录制模态框 */}
        <KeyRecordDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          command={editingCommand}
        />
      </div>
    </ContentSection>
  )
}
