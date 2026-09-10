import { Pencil, Trash2 } from 'lucide-react'
import type { RoleDto } from '@cairn/shared'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Can } from '@/components/rbac/can'
import { useRoles } from './roles-provider'

type RolesTableProps = {
  data: RoleDto[]
}

export function RolesTable({ data }: RolesTableProps) {
  const { setOpen, setCurrentRow } = useRoles()

  return (
    <div className='overflow-hidden rounded-md border'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Permissions</TableHead>
            <TableHead>Accounts</TableHead>
            <TableHead className='w-24' />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((role) => (
            <TableRow key={role.id}>
              <TableCell>
                <div className='font-medium'>{role.name}</div>
                {role.description && (
                  <div className='text-muted-foreground text-xs'>
                    {role.description}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <code className='text-xs'>{role.key}</code>
              </TableCell>
              <TableCell>
                <Badge
                  variant='outline'
                  className={cn(
                    'capitalize',
                    role.kind === 'system' && 'border-teal-200 text-teal-800 dark:text-teal-200'
                  )}
                >
                  {role.kind}
                </Badge>
              </TableCell>
              <TableCell>{role.permissions.length}</TableCell>
              <TableCell>{role.accountCount}</TableCell>
              <TableCell>
                <div className='flex justify-end gap-1'>
                  <Can permission='role:write'>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-8'
                      aria-label={`Edit ${role.name}`}
                      onClick={() => {
                        setCurrentRow(role)
                        setOpen('edit')
                      }}
                    >
                      <Pencil size={16} />
                    </Button>
                  </Can>
                  <Can permission='role:delete'>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-8 text-destructive'
                      aria-label={`Delete ${role.name}`}
                      disabled={role.kind === 'system'}
                      onClick={() => {
                        setCurrentRow(role)
                        setOpen('delete')
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </Can>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
