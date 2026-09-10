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
      toast.success('账号已删除')
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '删除失败')
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
          <AlertTriangle className='me-1 inline-block stroke-destructive' size={18} /> 删除用户
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
            确定删除 <span className='font-bold'>{currentRow.displayName}</span> 吗？
            <br />
            该账号及其角色{' '}
            <span className='font-bold'>{roleNames}</span> 将被永久移除，且无法恢复。
          </p>
          <Label className='my-2'>
            显示名称：
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder='输入显示名称以确认删除'
              autoFocus
            />
          </Label>
          <Alert variant='destructive'>
            <AlertTitle>注意</AlertTitle>
            <AlertDescription>此操作不可撤销，请确认后再继续。</AlertDescription>
          </Alert>
        </form>
      }
      confirmText='删除'
      destructive
    />
  )
}
