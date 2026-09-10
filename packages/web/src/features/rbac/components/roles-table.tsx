import { Pencil, Trash2 } from 'lucide-react'
import type { RoleDto } from '@cairn/shared'
import { StatusBadge } from '@/components/status-badge'
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
    <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>标识</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>权限</TableHead>
            <TableHead>账号数</TableHead>
            <TableHead className='w-24' />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((role) => (
            <TableRow key={role.id}>
              <TableCell>
                <div className='font-medium'>{role.name}</div>
                {role.description && (
                  <div className='text-muted-foreground text-label'>
                    {role.description}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <code className='text-label'>{role.key}</code>
              </TableCell>
              <TableCell>
                <StatusBadge
                  tone={role.kind === 'system' ? 'info' : 'neutral'}
                >
                  {role.kind === 'system' ? '系统' : '自定义'}
                </StatusBadge>
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
                      aria-label={`编辑 ${role.name}`}
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
                      aria-label={`删除 ${role.name}`}
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
