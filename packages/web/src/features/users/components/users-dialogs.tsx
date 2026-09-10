import type { RoleDto } from '@cairn/shared'
import { UsersActionDialog } from './users-action-dialog'
import { UsersDeleteDialog } from './users-delete-dialog'
import { useUsers } from './users-provider'

export function UsersDialogs({ roles }: { roles: RoleDto[] }) {
  const { open, setOpen, currentRow, setCurrentRow } = useUsers()
  return (
    <>
      {open === 'add' && (
        <UsersActionDialog
          roles={roles}
          open
          onOpenChange={() => setOpen('add')}
        />
      )}

      {currentRow && (
        <>
          <UsersActionDialog
            key={`user-edit-${currentRow.id}`}
            roles={roles}
            open={open === 'edit'}
            onOpenChange={() => {
              setOpen('edit')
              setTimeout(() => {
                setCurrentRow(null)
              }, 500)
            }}
            currentRow={currentRow}
          />

          <UsersDeleteDialog
            key={`user-delete-${currentRow.id}`}
            open={open === 'delete'}
            onOpenChange={() => {
              setOpen('delete')
              setTimeout(() => {
                setCurrentRow(null)
              }, 500)
            }}
            currentRow={currentRow}
          />
        </>
      )}
    </>
  )
}
