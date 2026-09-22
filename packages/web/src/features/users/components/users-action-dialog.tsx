import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import {
  ACCOUNT_STATUS,
  hasAllPermissions,
  type RoleDto,
  type RoleTargetScope,
  roleTargetScopeSchema,
} from '@cairn/shared'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import {
  assignAccountRoles,
  createAccount,
  setAccountPassword,
  updateAccount,
} from '@/lib/rbac-api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PasswordInput } from '@/components/password-input'
import { AvatarPicker } from '@/components/avatar-picker'
import { cn } from '@/lib/utils'
import { type User } from '../data/schema'
import { TargetScopeFields } from './target-scope-fields'

const formSchema = z.object({
  displayName: z.string().min(1, '请填写显示名称。'),
  email: z.string().trim().min(1, '请输入账号。').max(64),
  password: z.string().optional(),
  avatar: z.string().optional(),
  status: z.enum(ACCOUNT_STATUS),
  roleIds: z.array(z.string()).min(1, '请至少选择一个角色。'),
})
type UserForm = z.infer<typeof formSchema>

type UserActionDialogProps = {
  currentRow?: User
  roles: RoleDto[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

function RequiredMark() {
  return (
    <span className='text-destructive font-bold' aria-hidden='true'>
      {' *'}
    </span>
  )
}

export function UsersActionDialog({
  currentRow,
  roles,
  open,
  onOpenChange,
}: UserActionDialogProps) {
  const isEdit = !!currentRow
  const queryClient = useQueryClient()
  const actor = useAuthStore((s) => s.auth.user)
  const actorPermissions = actor?.permissions
  const adminRole = roles.find(
    (role) => role.kind === 'system' && role.key === 'admin'
  )
  const canDelegate =
    !!adminRole &&
    !!actor?.roles.includes('admin') &&
    !!actor.targetScopes?.some(
      (scope) => scope.roleId === adminRole.id && scope.mode === 'all'
    )
  const [saving, setSaving] = useState(false)
  const [scopes, setScopes] = useState<RoleTargetScope[]>(
    currentRow?.targetScopes ?? []
  )
  const defaultAuthor =
    roles.find((role) => role.key === 'author')?.id ?? roles[0]?.id ?? ''
  const canAssign = (role: RoleDto) =>
    canDelegate &&
    (actorPermissions == null ||
      hasAllPermissions(actorPermissions, role.permissions))
  const form = useForm<UserForm>({
    resolver: zodResolver(formSchema),
    defaultValues: isEdit
      ? {
          displayName: currentRow.displayName,
          email: currentRow.email ?? '',
          password: '',
          avatar: currentRow.avatar ?? '',
          status: currentRow.status,
          roleIds: currentRow.roles.map((r) => r.id),
        }
      : {
          displayName: '',
          email: '',
          password: '',
          avatar: '',
          status: 'active',
          roleIds: defaultAuthor ? [defaultAuthor] : [],
        },
  })

  const closeDialog = () => {
    if (saving) return
    form.reset()
    onOpenChange(false)
  }

  const onSubmit = async (values: UserForm) => {
    setSaving(true)
    try {
      const targetScopes = values.roleIds.map((roleId) =>
        roleTargetScopeSchema.parse(
          scopes.find((s) => s.roleId === roleId) ?? {
            roleId,
            mode:
              roles.find((r) => r.id === roleId)?.key === 'admin'
                ? 'all'
                : 'none',
            targetIds: [],
          }
        )
      )
      if (isEdit && currentRow) {
        await updateAccount(currentRow.id, {
          displayName: values.displayName,
          email: values.email,
          avatar: values.avatar || null,
          status: values.status,
        })
        if (canDelegate)
          await assignAccountRoles(currentRow.id, {
            roleIds: values.roleIds,
            targetScopes,
          })
        if (values.password) {
          await setAccountPassword(currentRow.id, { password: values.password })
        }
        toast.success('账号已更新')
      } else {
        if (!values.password || values.password.length < 8) {
          form.setError('password', { message: '密码至少 8 位。' })
          return
        }
        await createAccount({
          displayName: values.displayName,
          email: values.email,
          password: values.password,
          avatar: values.avatar || undefined,
          status: values.status,
          roleIds: values.roleIds,
          targetScopes,
        })
        toast.success('账号已创建')
      }
      await queryClient.invalidateQueries({ queryKey: ['accounts'] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      await queryClient.invalidateQueries({ queryKey: ['audit'] })
      form.reset()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '请求失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(state) => {
        if (saving) return
        form.reset()
        onOpenChange(state)
      }}
    >
      <DialogContent className='flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl'>
        <DialogHeader className='shrink-0 border-b border-border px-6 py-4 text-start'>
          <DialogTitle>{isEdit ? '编辑用户' : '新增用户'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '更新账号信息与角色分配。'
              : '创建使用本地密码的控制台账号。'}
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            id='user-form'
            onSubmit={form.handleSubmit(onSubmit)}
            className='flex min-h-0 flex-1 flex-col'
          >
            <div className='min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5'>
              <FormField
                control={form.control}
                name='avatar'
                render={({ field }) => (
                  <FormItem className='flex flex-col items-center gap-0 space-y-0'>
                    <AvatarPicker
                      value={field.value}
                      onChange={field.onChange}
                      displayName={form.watch('displayName')}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <FormField
                  control={form.control}
                  name='displayName'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        显示名称
                        <RequiredMark />
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder='Ada Admin'
                          autoComplete='off'
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='email'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        账号
                        <RequiredMark />
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder='admin'
                          autoComplete='off'
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='password'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {isEdit ? '新密码' : '密码'}
                        {isEdit ? null : <RequiredMark />}
                      </FormLabel>
                      <FormControl>
                        <PasswordInput
                          placeholder={isEdit ? '留空则不修改' : '至少 8 位'}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name='status'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>状态</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value='active'>启用</SelectItem>
                          <SelectItem value='disabled'>停用</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name='roleIds'
                render={() => (
                  <FormItem className='gap-3'>
                    <FormLabel>
                      角色
                      <RequiredMark />
                    </FormLabel>
                    <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                      {roles.map((role) => (
                        <FormField
                          key={role.id}
                          control={form.control}
                          name='roleIds'
                          render={({ field }) => {
                            const checked = field.value.includes(role.id)
                            const assignable = canAssign(role)
                            return (
                              <label
                                className={cn(
                                  'flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-body',
                                  assignable
                                    ? 'hover:bg-action-hover'
                                    : 'cursor-not-allowed opacity-60'
                                )}
                              >
                                <Checkbox
                                  checked={checked}
                                  disabled={!assignable}
                                  onCheckedChange={(next) => {
                                    const on = next === true
                                    field.onChange(
                                      on
                                        ? [...field.value, role.id]
                                        : field.value.filter(
                                            (id) => id !== role.id
                                          )
                                    )
                                  }}
                                />
                                {role.name}
                              </label>
                            )
                          }}
                        />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <TargetScopeFields
                disabled={!canDelegate}
                roles={roles.filter((r) =>
                  form.watch('roleIds').includes(r.id)
                )}
                value={scopes}
                onChange={setScopes}
              />
              {!canDelegate && (
                <p className='text-label text-muted-foreground'>
                  角色与目标范围由全范围管理员配置。
                </p>
              )}
            </div>

            <DialogFooter className='shrink-0 border-t border-border bg-surface-header/90 px-6 py-3.5 sm:justify-end'>
              <Button
                type='button'
                variant='outline'
                disabled={saving}
                onClick={closeDialog}
              >
                取消
              </Button>
              <Button
                type='submit'
                loading={saving}
                disabled={!isEdit && !canDelegate}
              >
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
