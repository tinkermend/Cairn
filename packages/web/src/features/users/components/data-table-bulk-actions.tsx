import { useState } from 'react'
import { type Table } from '@tanstack/react-table'
import { useQueryClient } from '@tanstack/react-query'
import { Trash2, UserX, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { DataTableBulkActions as BulkActionsToolbar } from '@/components/data-table'
import { Can } from '@/components/rbac/can'
import { ApiRequestError } from '@/lib/api-client'
import { updateAccount } from '@/lib/rbac-api'
import { type User } from '../data/schema'
import { UsersMultiDeleteDialog } from './users-multi-delete-dialog'

type DataTableBulkActionsProps<TData> = {
  table: Table<TData>
}

export function DataTableBulkActions<TData>({
  table,
}: DataTableBulkActionsProps<TData>) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const queryClient = useQueryClient()
  const selectedRows = table.getFilteredSelectedRowModel().rows

  const handleBulkStatusChange = async (status: 'active' | 'disabled') => {
    const selectedUsers = selectedRows.map((row) => row.original as User)
    try {
      await Promise.all(selectedUsers.map((user) => updateAccount(user.id, { status })))
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['audit'] })
      table.resetRowSelection()
      toast.success(
        `${status === 'active' ? 'Activated' : 'Disabled'} ${selectedUsers.length} user${selectedUsers.length > 1 ? 's' : ''}`,
      )
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'Update failed')
    }
  }

  return (
    <>
      <BulkActionsToolbar table={table} entityName='user'>
        <Can permission='account:write'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='outline'
                size='icon'
                onClick={() => void handleBulkStatusChange('active')}
                className='size-8'
                aria-label='Activate selected users'
                title='Activate selected users'
              >
                <UserCheck />
                <span className='sr-only'>Activate selected users</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Activate selected users</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='outline'
                size='icon'
                onClick={() => void handleBulkStatusChange('disabled')}
                className='size-8'
                aria-label='Disable selected users'
                title='Disable selected users'
              >
                <UserX />
                <span className='sr-only'>Disable selected users</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Disable selected users</p>
            </TooltipContent>
          </Tooltip>
        </Can>

        <Can permission='account:delete'>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant='destructive'
                size='icon'
                onClick={() => setShowDeleteConfirm(true)}
                className='size-8'
                aria-label='Delete selected users'
                title='Delete selected users'
              >
                <Trash2 />
                <span className='sr-only'>Delete selected users</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Delete selected users</p>
            </TooltipContent>
          </Tooltip>
        </Can>
      </BulkActionsToolbar>

      <UsersMultiDeleteDialog
        table={table}
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
      />
    </>
  )
}
