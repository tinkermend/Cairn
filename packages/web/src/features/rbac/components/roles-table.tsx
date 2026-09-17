import { Copy, Eye, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react'
import type { RoleDto } from '@cairn/shared'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
            <TableHead>权限项</TableHead>
            <TableHead>关联账号</TableHead>
            <TableHead className='w-28 text-right'>操作</TableHead>
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
                  {role.kind === 'system' ? '系统内置' : '自定义'}
                </StatusBadge>
              </TableCell>
              <TableCell>
                <span className='inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-label text-muted-foreground font-mono'>
                  {role.permissions.length} 项
                </span>
              </TableCell>
              <TableCell>
                <button
                  type='button'
                  className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-label font-medium text-foreground hover:bg-muted/80 hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                  title='查看并管理该角色的成员'
                  onClick={() => {
                    setCurrentRow(role)
                    setOpen('members')
                  }}
                >
                  <Users className='size-3.5 text-muted-foreground' />
                  <span>{role.accountCount} 个成员</span>
                </button>
              </TableCell>
              <TableCell>
                <div className='flex items-center justify-end gap-1'>
                  <Can permission='role:write'>
                    <Button
                      variant='ghost'
                      size='icon'
                      className='size-8'
                      aria-label={`${role.kind === 'system' ? '查看' : '编辑'} ${role.name}`}
                      title={role.kind === 'system' ? '查看配置' : '编辑角色'}
                      onClick={() => {
                        setCurrentRow(role)
                        setOpen('edit')
                      }}
                    >
                      {role.kind === 'system' ? <Eye size={16} /> : <Pencil size={16} />}
                    </Button>
                  </Can>

                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant='ghost'
                        size='icon'
                        className='size-8'
                        aria-label={`更多操作 ${role.name}`}
                      >
                        <MoreHorizontal size={16} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end' className='w-36'>
                      <DropdownMenuItem
                        onClick={() => {
                          setCurrentRow(role)
                          setOpen('members')
                        }}
                      >
                        <Users className='mr-2 size-4 text-muted-foreground' />
                        成员管理
                      </DropdownMenuItem>

                      <Can permission='role:write'>
                        <DropdownMenuItem
                          onClick={() => {
                            setCurrentRow(role)
                            setOpen('clone')
                          }}
                        >
                          <Copy className='mr-2 size-4 text-muted-foreground' />
                          克隆角色
                        </DropdownMenuItem>
                      </Can>

                      <Can permission='role:write'>
                        <DropdownMenuItem
                          onClick={() => {
                            setCurrentRow(role)
                            setOpen('edit')
                          }}
                        >
                          {role.kind === 'system' ? (
                            <>
                              <Eye className='mr-2 size-4 text-muted-foreground' />
                              查看配置
                            </>
                          ) : (
                            <>
                              <Pencil className='mr-2 size-4 text-muted-foreground' />
                              编辑角色
                            </>
                          )}
                        </DropdownMenuItem>
                      </Can>

                      <Can permission='role:delete'>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={role.kind === 'system'}
                          className='text-destructive focus:text-destructive'
                          onClick={() => {
                            setCurrentRow(role)
                            setOpen('delete')
                          }}
                        >
                          <Trash2 className='mr-2 size-4 text-destructive' />
                          删除角色
                        </DropdownMenuItem>
                      </Can>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

