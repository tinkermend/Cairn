import * as React from 'react'
import { Check, Dices, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { UserAvatar } from '@/components/user-avatar'
import { PRESET_AVATARS, getAvatarDataUri, parseAvatarKey } from '@/lib/avatar'
import { DEFAULT_AVATAR_STYLE } from '@cairn/shared'
import { cn } from '@/lib/utils'

export interface AvatarPickerProps {
  value?: string | null
  onChange: (value: string) => void
  disabled?: boolean
  displayName?: string
}

export function AvatarPicker({
  value,
  onChange,
  disabled,
  displayName,
}: AvatarPickerProps) {
  const [open, setOpen] = React.useState(false)
  const [seeds, setSeeds] = React.useState<string[]>(PRESET_AVATARS)
  const [selected, setSelected] = React.useState<string>(value || '')

  // 同步外部 value 变化
  React.useEffect(() => {
    setSelected(value || '')
  }, [value])

  const handleShuffle = () => {
    const newSeeds = Array.from({ length: 16 }, () => {
      const rand = Math.random().toString(36).slice(2, 9)
      return `${DEFAULT_AVATAR_STYLE}:bot-${rand}`
    })
    setSeeds(newSeeds)
  }

  const handleResetPresets = () => {
    setSeeds(PRESET_AVATARS)
  }

  const handleConfirm = () => {
    onChange(selected)
    setOpen(false)
  }

  const handleClear = () => {
    setSelected('')
    onChange('')
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className='flex items-center gap-3'>
        <UserAvatar
          user={{ avatar: value, displayName }}
          className='size-12 rounded-xl border border-border shadow-xs'
        />
        <div className='flex flex-col gap-1'>
          <div className='flex items-center gap-2'>
            <DialogTrigger asChild>
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={disabled}
              >
                选择头像
              </Button>
            </DialogTrigger>
            {value ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='text-muted-foreground hover:text-foreground text-xs'
                onClick={() => onChange('')}
                disabled={disabled}
              >
                清除
              </Button>
            ) : null}
          </div>
          <span className='text-xs text-muted-foreground'>
            支持选择专属科技机器人头像
          </span>
        </div>
      </div>

      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>选择头像</DialogTitle>
          <DialogDescription>
            点击选择中意的机器人头像，或点击随机换一批生成新造型。
          </DialogDescription>
        </DialogHeader>

        <div className='grid grid-cols-4 gap-3 py-4 max-h-[360px] overflow-y-auto px-1'>
          {seeds.map((avatarKey) => {
            const isSelected = selected === avatarKey
            const dataUri = getAvatarDataUri(avatarKey)
            const parsed = parseAvatarKey(avatarKey)

            return (
              <button
                key={avatarKey}
                type='button'
                onClick={() => setSelected(avatarKey)}
                className={cn(
                  'relative group flex flex-col items-center justify-center p-2 rounded-xl border transition-colors duration-150',
                  'hover:border-primary/60 hover:bg-accent/40 focus:outline-hidden',
                  isSelected
                    ? 'border-primary ring-2 ring-primary/20 bg-primary/5 shadow-xs'
                    : 'border-border/80 bg-card'
                )}
              >
                <div className='size-14 rounded-lg overflow-hidden bg-muted/40 p-1 flex items-center justify-center'>
                  {dataUri ? (
                    <img
                      src={dataUri}
                      alt={parsed?.seed ?? 'avatar'}
                      className='size-full object-contain'
                    />
                  ) : null}
                </div>
                {isSelected ? (
                  <div className='absolute top-1.5 right-1.5 size-4 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-xs'>
                    <Check className='size-2.5 stroke-[3]' />
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>

        <DialogFooter className='flex-row items-center justify-between sm:justify-between border-t border-border pt-3'>
          <div className='flex items-center gap-1.5'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={handleShuffle}
              className='gap-1.5 text-xs'
            >
              <Dices className='size-3.5' />
              换一批
            </Button>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={handleResetPresets}
              className='text-muted-foreground text-xs gap-1'
              title='重置回预设'
            >
              <RotateCcw className='size-3' />
              预设
            </Button>
          </div>

          <div className='flex items-center gap-2'>
            {selected ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={handleClear}
                className='text-xs'
              >
                清除头像
              </Button>
            ) : null}
            <Button type='button' size='sm' onClick={handleConfirm}>
              应用所选
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
