import { RoleMembersSheet } from './role-members-sheet'
import { RolesActionDialog } from './roles-action-dialog'
import { RolesDeleteDialog } from './roles-delete-dialog'
import { useRoles } from './roles-provider'

export function RolesDialogs() {
  const { open, setOpen, currentRow, setCurrentRow } = useRoles()
  return (
    <>
      <RolesActionDialog
        key='role-add'
        open={open === 'add'}
        onOpenChange={() => setOpen('add')}
      />
      {currentRow && (
        <>
          <RolesActionDialog
            key={`role-edit-${currentRow.id}`}
            open={open === 'edit'}
            onOpenChange={() => {
              setOpen('edit')
              setTimeout(() => setCurrentRow(null), 500)
            }}
            currentRow={currentRow}
          />
          <RolesActionDialog
            key={`role-clone-${currentRow.id}`}
            open={open === 'clone'}
            onOpenChange={() => {
              setOpen('clone')
              setTimeout(() => setCurrentRow(null), 500)
            }}
            currentRow={currentRow}
            isClone
          />
          <RoleMembersSheet
            key={`role-members-${currentRow.id}`}
            role={currentRow}
            open={open === 'members'}
            onOpenChange={() => {
              setOpen('members')
              setTimeout(() => setCurrentRow(null), 500)
            }}
          />
          <RolesDeleteDialog
            key={`role-delete-${currentRow.id}`}
            open={open === 'delete'}
            onOpenChange={() => {
              setOpen('delete')
              setTimeout(() => setCurrentRow(null), 500)
            }}
            currentRow={currentRow}
          />
        </>
      )}
    </>
  )
}
