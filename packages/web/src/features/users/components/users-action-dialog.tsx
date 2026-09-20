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
import { type User } from '../data/schema'
import { TargetScopeFields } from './target-scope-fields'

const formSchema = z.object({
  displayName: z.string().min(1, '请填写显示名称。'),
  email: z.string().trim().min(1, '请输入账号。').max(64),
  password: z.string().optional(),
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
          status: currentRow.status,
          roleIds: currentRow.roles.map((r) => r.id),
        }
      : {
          displayName: '',
          email: '',
          password: '',
          status: 'active',
          roleIds: defaultAuthor ? [defaultAuthor] : [],
        },
  })

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
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <DialogHeader className='text-start'>
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
            className='space-y-4 px-0.5'
          >
            <FormField
              control={form.control}
              name='displayName'
              render={({ field }) => (
                <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                  <FormLabel className='col-span-2 text-end'>
                    显示名称
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder='Ada Admin'
                      className='col-span-4'
                      autoComplete='off'
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className='col-span-4 col-start-3' />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='email'
              render={({ field }) => (
                <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                  <FormLabel className='col-span-2 text-end'>账号</FormLabel>
                  <FormControl>
                    <Input
                      placeholder='admin'
                      className='col-span-4'
                      autoComplete='off'
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className='col-span-4 col-start-3' />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='password'
              render={({ field }) => (
                <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                  <FormLabel className='col-span-2 text-end'>
                    {isEdit ? '新密码' : '密码'}
                  </FormLabel>
                  <FormControl>
                    <PasswordInput
                      className='col-span-4'
                      placeholder={isEdit ? '留空则不修改' : '至少 8 位'}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage className='col-span-4 col-start-3' />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='status'
              render={({ field }) => (
                <FormItem className='grid grid-cols-6 items-center space-y-0 gap-x-4 gap-y-1'>
                  <FormLabel className='col-span-2 text-end'>状态</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className='col-span-4'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value='active'>启用</SelectItem>
                      <SelectItem value='disabled'>停用</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage className='col-span-4 col-start-3' />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='roleIds'
              render={() => (
                <FormItem className='grid grid-cols-6 items-start space-y-0 gap-x-4 gap-y-1'>
                  <FormLabel className='col-span-2 pt-1 text-end'>
                    角色
                  </FormLabel>
                  <div className='col-span-4 space-y-2'>
                    {roles.map((role) => (
                      <FormField
                        key={role.id}
                        control={form.control}
                        name='roleIds'
                        render={({ field }) => {
                          const checked = field.value.includes(role.id)
                          return (
                            <label className='flex items-center gap-2 text-body'>
                              <Checkbox
                                checked={checked}
                                disabled={!canAssign(role)}
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
                    <FormMessage />
                  </div>
                </FormItem>
              )}
            />
            <TargetScopeFields
              disabled={!canDelegate}
              roles={roles.filter((r) => form.watch('roleIds').includes(r.id))}
              value={scopes}
              onChange={setScopes}
            />
            {!canDelegate && (
              <p className='text-label text-muted-foreground'>
                角色与目标范围由全范围管理员配置。
              </p>
            )}
          </form>
        </Form>
        <DialogFooter>
          <Button
            type='submit'
            form='user-form'
            disabled={saving || (!isEdit && !canDelegate)}
          >
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
