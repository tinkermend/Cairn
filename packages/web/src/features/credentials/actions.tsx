import type { CredentialListItem } from '@cairn/shared'
import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { CredentialAction } from './editor'

export function CredentialActions({
  item,
  onAction,
}: {
  item: CredentialListItem
  onAction: (a: CredentialAction) => void
}) {
  const c = item.capabilities
  return (
    <div className='flex items-center gap-1'>
      {c.canReplace && (
        <Button size='sm' variant='ghost' onClick={() => onAction('password')}>
          更新密码
        </Button>
      )}
      {c.canSetMaintenance && (
        <Button size='sm' variant='ghost' onClick={() => onAction('validity')}>
          有效期
        </Button>
      )}
      {(c.canEditAccount || c.canSetMaintenance || c.canDelete) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size='icon'
              variant='ghost'
              aria-label={`${item.name}的更多操作`}
            >
              <MoreHorizontal className='size-4' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            {c.canEditAccount && (
              <DropdownMenuItem onSelect={() => onAction('account')}>
                编辑账号
              </DropdownMenuItem>
            )}
            {c.canSetMaintenance && (
              <DropdownMenuItem onSelect={() => onAction('owner')}>
                设置负责人
              </DropdownMenuItem>
            )}
            {c.canReplace && item.hasPassword && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onAction('clear')}>
                  清除已保存密码
                </DropdownMenuItem>
              </>
            )}
            {c.canDelete && (
              <DropdownMenuItem
                variant='destructive'
                onSelect={() => onAction('delete')}
              >
                删除凭据登记
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
