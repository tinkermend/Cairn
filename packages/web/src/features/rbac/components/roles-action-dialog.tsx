import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { createRoleBodySchema, type PermissionCode, type RoleDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createRole, updateRole } from '@/lib/rbac-api'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { PermissionMatrix } from './permission-matrix'

const formSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, '请使用小写标识，例如 qa_lead。'),
  name: z.string().min(1, '请填写名称。'),
  description: z.string().optional(),
  permissions: z.array(z.string()).min(1, '请至少选择一项权限。'),
})
type RoleForm = z.infer<typeof formSchema>

type RolesActionDialogProps = {
  currentRow?: RoleDto
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RolesActionDialog({ currentRow, open, onOpenChange }: RolesActionDialogProps) {
  const isEdit = !!currentRow
  const grantable = useAuthStore((s) => s.auth.user?.permissions)
  const locked = currentRow?.kind === 'system'
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const form = useForm<RoleForm>({
    resolver: zodResolver(formSchema),
    defaultValues: isEdit
      ? {
          key: currentRow.key,
          name: currentRow.name,
          description: currentRow.description ?? '',
          permissions: currentRow.permissions,
        }
      : {
          key: '',
          name: '',
          description: '',
          permissions: [],
        },
  })

  const onSubmit = async (values: RoleForm) => {
    if (locked) return
    setSaving(true)
    try {
      const parsed = createRoleBodySchema.parse({
        key: values.key,
        name: values.name,
        description: values.description || undefined,
        permissions: values.permissions,
      })
      if (isEdit && currentRow) {
        await updateRole(currentRow.id, {
          name: parsed.name,
          description: parsed.description ?? null,
          permissions: parsed.permissions,
        })
        toast.success('角色已更新')
      } else {
        await createRole(parsed)
        toast.success('角色已创建')
      }
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
        form.reset()
        onOpenChange(state)
      }}
    >
      <DialogContent className='flex max-h-[90vh] flex-col sm:max-w-2xl'>
        <DialogHeader className='text-start'>
          <DialogTitle>{locked ? '查看角色' : isEdit ? '编辑角色' : '创建角色'}</DialogTitle>
          <DialogDescription>
            {locked
              ? '系统角色由代码定义，不能在此修改。'
              : '角色是一组命名权限。自定义角色只能使用权限目录中的项。'}
          </DialogDescription>
        </DialogHeader>
        <div className='min-h-0 flex-1 overflow-y-auto pe-2'>
          <Form {...form}>
            <form id='role-form' onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
              <FormField
                control={form.control}
                name='key'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>标识</FormLabel>
                    <FormControl>
                      <Input placeholder='qa_lead' disabled={isEdit || locked} autoComplete='off' {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='name'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>名称</FormLabel>
                    <FormControl>
                      <Input placeholder='QA Lead' disabled={locked} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='description'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>说明</FormLabel>
                    <FormControl>
                      <Textarea disabled={locked} rows={2} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='permissions'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>权限</FormLabel>
                    <PermissionMatrix
                      value={field.value as PermissionCode[]}
                      onChange={field.onChange}
                      disabled={locked}
                      grantable={grantable}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </form>
          </Form>
        </div>
        <DialogFooter>
          {!locked && (
            <Button type='submit' form='role-form' disabled={saving}>
              保存
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
