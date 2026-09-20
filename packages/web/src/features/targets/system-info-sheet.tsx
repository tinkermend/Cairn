import type { TargetDto } from '@cairn/shared'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { SystemInfoCard } from './system-info-card'

interface SystemInfoSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: TargetDto
  onEdit?: () => void
  onDelete?: () => void
}

export function SystemInfoSheet({
  open,
  onOpenChange,
  target,
  onEdit,
  onDelete,
}: SystemInfoSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className='w-full overflow-y-auto sm:max-w-lg'>
        <SheetHeader>
          <SheetTitle className='text-section font-semibold'>系统完整资料</SheetTitle>
          <SheetDescription className='text-small text-muted-foreground'>
            查看「{target.name}」的接入元数据、端点地址与登录框选择器配置。
          </SheetDescription>
        </SheetHeader>
        <div className='mt-2'>
          <SystemInfoCard
            target={target}
            onEdit={() => {
              onOpenChange(false)
              onEdit?.()
            }}
            onDelete={() => {
              onOpenChange(false)
              onDelete?.()
            }}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
