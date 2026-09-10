import { ShieldPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { useRoles } from './roles-provider'

export function RolesPrimaryButtons() {
  const { setOpen } = useRoles()
  return (
    <Can permission='role:write'>
      <Button className='space-x-1' onClick={() => setOpen('add')}>
        <span>Create Role</span> <ShieldPlus size={18} />
      </Button>
    </Can>
  )
}
