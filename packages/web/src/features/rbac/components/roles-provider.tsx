import React, { useState } from 'react'
import type { RoleDto } from '@cairn/shared'
import useDialogState from '@/hooks/use-dialog-state'

type RolesDialogType = 'add' | 'edit' | 'delete'

type RolesContextType = {
  open: RolesDialogType | null
  setOpen: (str: RolesDialogType | null) => void
  currentRow: RoleDto | null
  setCurrentRow: React.Dispatch<React.SetStateAction<RoleDto | null>>
}

const RolesContext = React.createContext<RolesContextType | null>(null)

export function RolesProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useDialogState<RolesDialogType>(null)
  const [currentRow, setCurrentRow] = useState<RoleDto | null>(null)

  return (
    <RolesContext value={{ open, setOpen, currentRow, setCurrentRow }}>
      {children}
    </RolesContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useRoles = () => {
  const ctx = React.useContext(RolesContext)
  if (!ctx) throw new Error('useRoles has to be used within <RolesContext>')
  return ctx
}
