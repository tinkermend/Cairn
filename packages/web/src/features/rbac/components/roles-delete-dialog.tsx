import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { RoleDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ApiRequestError } from '@/lib/api-client'
import { deleteRole } from '@/lib/rbac-api'

type RolesDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow: RoleDto
}

export function RolesDeleteDialog({ open, onOpenChange, currentRow }: RolesDeleteDialogProps) {
  const locked = currentRow.kind === 'system' || currentRow.accountCount > 0
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      disabled={locked || saving}
      title={
        <span className='text-destructive'>
          <AlertTriangle className='me-1 inline-block stroke-destructive' size={18} /> 删除角色
        </span>
      }
      desc={
        locked
          ? currentRow.kind === 'system'
            ? '系统角色不能删除。'
            : `该角色仍分配给 ${currentRow.accountCount} 个账号。`
          : `确定删除自定义角色「${currentRow.name}」（${currentRow.key}）吗？此操作不可撤销。`
      }
      confirmText='删除'
      destructive
      handleConfirm={() => {
        if (locked) return
        setSaving(true)
        deleteRole(currentRow.id)
          .then(async () => {
            await queryClient.invalidateQueries({ queryKey: ['roles'] })
            await queryClient.invalidateQueries({ queryKey: ['audit'] })
            toast.success('角色已删除')
            onOpenChange(false)
          })
          .catch((error) => {
            toast.error(error instanceof ApiRequestError ? error.message : '删除失败')
          })
          .finally(() => setSaving(false))
      }}
    />
  )
}
