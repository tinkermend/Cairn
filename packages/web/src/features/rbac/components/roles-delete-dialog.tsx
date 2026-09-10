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
          <AlertTriangle className='me-1 inline-block stroke-destructive' size={18} /> Delete Role
        </span>
      }
      desc={
        locked
          ? currentRow.kind === 'system'
            ? 'System roles cannot be deleted.'
            : `This role is still assigned to ${currentRow.accountCount} account(s).`
          : `Delete custom role "${currentRow.name}" (${currentRow.key})? This cannot be undone.`
      }
      confirmText='Delete'
      destructive
      handleConfirm={() => {
        if (locked) return
        setSaving(true)
        deleteRole(currentRow.id)
          .then(async () => {
            await queryClient.invalidateQueries({ queryKey: ['roles'] })
            await queryClient.invalidateQueries({ queryKey: ['audit'] })
            toast.success('Role deleted')
            onOpenChange(false)
          })
          .catch((error) => {
            toast.error(error instanceof ApiRequestError ? error.message : 'Delete failed')
          })
          .finally(() => setSaving(false))
      }}
    />
  )
}
