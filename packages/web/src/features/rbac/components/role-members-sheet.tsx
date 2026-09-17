import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RoleDto, AccountDto } from '@cairn/shared'
import { Search, UserPlus, Trash2, X, Users as UsersIcon } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchRoleAccounts,
  addRoleAccounts,
  removeRoleAccounts,
  fetchAccounts,
} from '@/lib/rbac-api'
import { useCan } from '@/hooks/use-permissions'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'

type RoleMembersSheetProps = {
  role: RoleDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RoleMembersSheet({ role, open, onOpenChange }: RoleMembersSheetProps) {
  const [search, setSearch] = useState('')
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const canManage = useCan('role:write') && useCan('account:write')
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['role-accounts', role?.id, search],
    queryFn: () => (role ? fetchRoleAccounts(role.id, { search }) : null),
    enabled: !!role && open,
  })

  const [removingId, setRemovingId] = useState<string | null>(null)

  const handleRemove = async (accountId: string, displayName: string) => {
    if (!role) return
    setRemovingId(accountId)
    try {
      await removeRoleAccounts(role.id, { accountIds: [accountId] })
      toast.success(`已从角色中移出 ${displayName}`)
      await queryClient.invalidateQueries({ queryKey: ['role-accounts', role.id] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '移出失败')
    } finally {
      setRemovingId(null)
    }
  }

  const members = data?.items ?? []

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side='right'
          className='sm:max-w-2xl w-full flex flex-col h-full p-0 bg-card'
        >
          <SheetHeader className='p-6 pb-4 border-b border-border text-start'>
            <div className='flex items-center justify-between pe-8'>
              <SheetTitle className='flex items-center gap-2'>
                <UsersIcon className='size-5 text-muted-foreground' />
                <span>{role?.name} · 成员管理</span>
              </SheetTitle>
              {canManage && (
                <Button
                  size='sm'
                  className='gap-1.5 text-label'
                  onClick={() => setAddDialogOpen(true)}
                >
                  <UserPlus className='size-3.5' />
                  添加成员
                </Button>
              )}
            </div>
            <SheetDescription>
              查看并管理已分配此角色的控制台账号。已关联 {members.length} 个账号。
            </SheetDescription>
          </SheetHeader>

          <div className='p-6 pb-2'>
            <div className='relative'>
              <Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
              <Input
                placeholder='搜索成员姓名或账号...'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className='ps-9 pe-9 text-body'
              />
              {search && (
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  className='absolute right-1 top-1 size-7'
                  onClick={() => setSearch('')}
                >
                  <X className='size-3.5' />
                </Button>
              )}
            </div>
          </div>

          <div className='min-h-0 flex-1 overflow-y-auto px-6 pb-6'>
            {isLoading ? (
              <div className='py-8 text-center text-label text-muted-foreground'>
                加载成员中...
              </div>
            ) : members.length === 0 ? (
              <EmptyState
                title={search ? '未找到相关成员' : '暂无分配成员'}
                description={
                  search
                    ? '没有符合搜索条件的账号'
                    : '该角色目前没有分配给任何控制台账号。'
                }
              />
            ) : (
              <div className='rounded-lg border border-border bg-card overflow-hidden'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>姓名</TableHead>
                      <TableHead>账号</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>分配时间</TableHead>
                      {canManage && <TableHead className='w-16' />}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((member) => (
                      <TableRow key={member.id}>
                        <TableCell className='font-medium'>
                          {member.displayName}
                        </TableCell>
                        <TableCell>
                          <code className='text-label'>{member.email ?? '—'}</code>
                        </TableCell>
                        <TableCell>
                          <StatusBadge
                            tone={member.status === 'active' ? 'success' : 'neutral'}
                          >
                            {member.status === 'active' ? '启用' : '停用'}
                          </StatusBadge>
                        </TableCell>
                        <TableCell className='text-muted-foreground text-label'>
                          {new Date(member.assignedAt).toLocaleDateString()}
                        </TableCell>
                        {canManage && (
                          <TableCell>
                            <Button
                              variant='ghost'
                              size='icon'
                              className='size-8 text-destructive hover:bg-destructive/10'
                              title={`从角色中移出 ${member.displayName}`}
                              aria-label={`移出 ${member.displayName}`}
                              disabled={removingId === member.id}
                              onClick={() => handleRemove(member.id, member.displayName)}
                            >
                              <Trash2 size={15} />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {role && addDialogOpen && (
        <AddMembersDialog
          role={role}
          currentMemberIds={new Set(members.map((m) => m.id))}
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
        />
      )}
    </>
  )
}

function AddMembersDialog({
  role,
  currentMemberIds,
  open,
  onOpenChange,
}: {
  role: RoleDto
  currentMemberIds: Set<string>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const queryClient = useQueryClient()

  const { data: accountsData, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    enabled: open,
  })

  const availableAccounts = (accountsData?.items ?? []).filter(
    (acc) => !currentMemberIds.has(acc.id),
  )

  const query = search.trim().toLowerCase()
  const filtered = availableAccounts.filter((acc) => {
    if (!query) return true
    return (
      acc.displayName.toLowerCase().includes(query) ||
      (acc.email && acc.email.toLowerCase().includes(query))
    )
  })

  const handleToggle = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id],
    )
  }

  const handleSelectAll = () => {
    if (selectedIds.length === filtered.length) {
      setSelectedIds([])
    } else {
      setSelectedIds(filtered.map((a) => a.id))
    }
  }

  const handleSave = async () => {
    if (selectedIds.length === 0) return
    setSaving(true)
    try {
      await addRoleAccounts(role.id, { accountIds: selectedIds })
      toast.success(`已向角色 ${role.name} 添加 ${selectedIds.length} 名成员`)
      await queryClient.invalidateQueries({ queryKey: ['role-accounts', role.id] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '添加失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md flex flex-col max-h-[85vh]'>
        <DialogHeader>
          <DialogTitle>添加成员 · {role.name}</DialogTitle>
          <DialogDescription>选择要分配该角色的控制台账号。</DialogDescription>
        </DialogHeader>

        <div className='relative my-2'>
          <Search className='absolute left-2.5 top-2.5 size-4 text-muted-foreground' />
          <Input
            placeholder='搜索候选账号...'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='ps-9 text-body'
          />
        </div>

        <div className='flex items-center justify-between text-label text-muted-foreground px-1 pb-1'>
          <span>候选账号 ({filtered.length})</span>
          {filtered.length > 0 && (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-6 px-2 text-label'
              onClick={handleSelectAll}
            >
              {selectedIds.length === filtered.length ? '取消全选' : '全选'}
            </Button>
          )}
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto space-y-1.5 border border-border rounded-md p-2'>
          {isLoading ? (
            <div className='py-6 text-center text-label text-muted-foreground'>
              加载中...
            </div>
          ) : filtered.length === 0 ? (
            <div className='py-6 text-center text-label text-muted-foreground'>
              {availableAccounts.length === 0
                ? '所有账号已拥有该角色'
                : '未找到匹配的账号'}
            </div>
          ) : (
            filtered.map((acc: AccountDto) => {
              const checked = selectedIds.includes(acc.id)
              return (
                <label
                  key={acc.id}
                  className='flex items-center gap-2.5 p-2 rounded-md hover:bg-muted/40 cursor-pointer transition-colors'
                >
                  <Checkbox
                    aria-label={`选择 ${acc.displayName}`}
                    checked={checked}
                    onCheckedChange={() => handleToggle(acc.id)}
                  />
                  <div className='flex-1 min-w-0'>
                    <div className='text-body font-medium leading-none'>
                      {acc.displayName}
                    </div>
                    {acc.email && (
                      <div className='text-label text-muted-foreground mt-0.5'>
                        {acc.email}
                      </div>
                    )}
                  </div>
                  <StatusBadge tone={acc.status === 'active' ? 'success' : 'neutral'}>
                    {acc.status === 'active' ? '启用' : '停用'}
                  </StatusBadge>
                </label>
              )
            })
          )}
        </div>

        <DialogFooter className='mt-3'>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type='button'
            disabled={saving || selectedIds.length === 0}
            onClick={handleSave}
          >
            {saving ? '添加中...' : `确认添加 (${selectedIds.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
