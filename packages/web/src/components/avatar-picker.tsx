import * as React from 'react'
import { Camera, Check, Dices, RotateCcw } from 'lucide-react'
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
import {
  DEFAULT_PREVIEW_AVATAR,
  PRESET_AVATARS,
  getAvatarDataUri,
  parseAvatarKey,
} from '@/lib/avatar'
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
  const previewAvatar = value || DEFAULT_PREVIEW_AVATAR

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
      <DialogTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          aria-label='选择头像'
          title='选择头像'
          className={cn(
            'relative size-20 shrink-0 overflow-hidden rounded-xl border border-border bg-surface-subtle shadow-xs outline-none',
            'hover:border-primary/60',
            'focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-[3px]',
            'disabled:pointer-events-none disabled:opacity-50'
          )}
        >
          <UserAvatar
            user={{ avatar: previewAvatar, displayName }}
            className='size-full rounded-none border-0 bg-transparent shadow-none'
          />
          <span
            aria-hidden='true'
            className='absolute right-1.5 bottom-1.5 flex size-6 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xs'
          >
            <Camera className='size-3.5' />
          </span>
        </button>
      </DialogTrigger>

      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>选择头像</DialogTitle>
          <DialogDescription>
            点击选择中意的机器人头像，或点击随机换一批生成新造型。
          </DialogDescription>
        </DialogHeader>

        <div className='grid max-h-[360px] grid-cols-4 gap-3 overflow-y-auto px-1 py-4'>
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
                  'group relative flex flex-col items-center justify-center rounded-xl border p-2',
                  'hover:border-primary/60 hover:bg-accent/40 focus:outline-hidden',
                  isSelected
                    ? 'border-primary bg-primary/5 shadow-xs ring-2 ring-primary/20'
                    : 'border-border/80 bg-card'
                )}
              >
                <div className='flex size-14 items-center justify-center overflow-hidden rounded-lg bg-muted/40 p-1'>
                  {dataUri ? (
                    <img
                      src={dataUri}
                      alt={parsed?.seed ?? 'avatar'}
                      className='size-full object-contain'
                    />
                  ) : null}
                </div>
                {isSelected ? (
                  <div className='absolute top-1.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xs'>
                    <Check className='size-2.5 stroke-[3]' />
                  </div>
                ) : null}
              </button>
            )
          })}
        </div>

        <DialogFooter className='flex-row items-center justify-between border-t border-border pt-3 sm:justify-between'>
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
              className='gap-1 text-xs text-muted-foreground'
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
