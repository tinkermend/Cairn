import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ApiRequestError } from '@/lib/api-client'
import { deleteAccount } from '@/lib/rbac-api'
import { type User } from '../data/schema'

type UserDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentRow: User
}

export function UsersDeleteDialog({
  open,
  onOpenChange,
  currentRow,
}: UserDeleteDialogProps) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const queryClient = useQueryClient()

  const handleDelete = async () => {
    if (value.trim() !== currentRow.displayName) return
    setSaving(true)
    try {
      await deleteAccount(currentRow.id)
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      await queryClient.invalidateQueries({ queryKey: ['audit'] })
      toast.success('Account deleted')
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'Delete failed')
    } finally {
      setSaving(false)
    }
  }

  const roleNames = currentRow.roles.map((r) => r.name).join(', ')

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      form='users-delete-form'
      disabled={saving || value.trim() !== currentRow.displayName}
      title={
        <span className='text-destructive'>
          <AlertTriangle className='me-1 inline-block stroke-destructive' size={18} /> Delete User
        </span>
      }
      desc={
        <form
          id='users-delete-form'
          onSubmit={(e) => {
            e.preventDefault()
            void handleDelete()
          }}
          className='space-y-4'
        >
          <p className='mb-2'>
            Are you sure you want to delete <span className='font-bold'>{currentRow.displayName}</span>?
            <br />
            This action will permanently remove the account with roles{' '}
            <span className='font-bold'>{roleNames}</span> from the system. This cannot be undone.
          </p>
          <Label className='my-2'>
            Display name:
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder='Enter display name to confirm deletion.'
              autoFocus
            />
          </Label>
          <Alert variant='destructive'>
            <AlertTitle>Warning!</AlertTitle>
            <AlertDescription>Please be careful, this operation can not be rolled back.</AlertDescription>
          </Alert>
        </form>
      }
      confirmText='Delete'
      destructive
    />
  )
}
