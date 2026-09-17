import { useState, useEffect } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import {
  createRoleBodySchema,
  SYSTEM_ROLE_DEFINITIONS,
  type PermissionCode,
  type RoleDto,
} from '@cairn/shared'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { ApiRequestError } from '@/lib/api-client'
import { createRole, updateRole } from '@/lib/rbac-api'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
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
import { CapabilityPreview } from './capability-preview'
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
  isClone?: boolean
}

export function RolesActionDialog({
  currentRow,
  open,
  onOpenChange,
  isClone: isCloneProp = false,
}: RolesActionDialogProps) {
  const [cloneMode, setCloneMode] = useState(isCloneProp)
  const isEdit = !!currentRow && !cloneMode
  const locked = currentRow?.kind === 'system' && !cloneMode
  const grantable = useAuthStore((s) => s.auth.user?.permissions)
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)

  const form = useForm<RoleForm>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      key: '',
      name: '',
      description: '',
      permissions: [],
    },
  })

  useEffect(() => {
    setCloneMode(isCloneProp)
  }, [isCloneProp, open])

  useEffect(() => {
    if (currentRow) {
      if (cloneMode) {
        form.reset({
          key: `${currentRow.key}_copy`,
          name: `${currentRow.name} (副本)`,
          description: currentRow.description ?? '',
          permissions: currentRow.permissions,
        })
      } else {
        form.reset({
          key: currentRow.key,
          name: currentRow.name,
          description: currentRow.description ?? '',
          permissions: currentRow.permissions,
        })
      }
    } else {
      form.reset({
        key: '',
        name: '',
        description: '',
        permissions: [],
      })
    }
  }, [currentRow, cloneMode, form, open])

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

  const applyTemplate = (perms: readonly PermissionCode[]) => {
    form.setValue('permissions', [...perms], { shouldValidate: true, shouldDirty: true })
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(state) => {
        if (!state) {
          form.reset()
          setCloneMode(false)
        }
        onOpenChange(state)
      }}
    >
      <SheetContent
        side='right'
        className='sm:max-w-4xl w-full flex flex-col h-full p-0 bg-card overflow-hidden'
      >
        <SheetHeader className='p-6 pb-4 border-b border-border text-start'>
          <div className='flex items-center justify-between pe-8'>
            <SheetTitle>
              {locked ? '查看角色' : cloneMode ? '克隆角色' : isEdit ? '编辑角色' : '创建角色'}
            </SheetTitle>
            {locked && (
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='gap-1.5 text-label'
                onClick={() => setCloneMode(true)}
              >
                <Copy className='size-3.5' />
                基于此角色克隆
              </Button>
            )}
          </div>
          <SheetDescription>
            {locked
              ? '系统角色由代码定义，不能在此修改。'
              : cloneMode
                ? `正在基于“${currentRow?.name}”创建新的自定义角色。`
                : '角色是一组命名权限。自定义角色只能使用权限目录中的项。'}
          </SheetDescription>
        </SheetHeader>

        <div className='min-h-0 flex-1 overflow-hidden p-6'>
          <Form {...form}>
            <form
              id='role-form'
              onSubmit={form.handleSubmit(onSubmit)}
              className='h-full flex flex-col'
            >
              <div className='grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 flex-1 overflow-hidden'>
                {/* 左侧：表单配置区 */}
                <div className='lg:col-span-7 overflow-y-auto pe-2 space-y-4'>
                  <div className='grid grid-cols-1 sm:grid-cols-2 gap-4'>
                    <FormField
                      control={form.control}
                      name='key'
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>标识</FormLabel>
                          <FormControl>
                            <Input
                              placeholder='qa_lead'
                              disabled={isEdit || locked}
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
                  </div>
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

                  {!locked && (
                    <div className='rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2'>
                      <div className='text-label font-medium text-muted-foreground'>
                        快速套用系统模板：
                      </div>
                      <div className='flex flex-wrap items-center gap-1.5'>
                        <Button
                          type='button'
                          variant='secondary'
                          size='sm'
                          className='h-7 text-label'
                          onClick={() => applyTemplate(SYSTEM_ROLE_DEFINITIONS.author.permissions)}
                        >
                          编写者
                        </Button>
                        <Button
                          type='button'
                          variant='secondary'
                          size='sm'
                          className='h-7 text-label'
                          onClick={() => applyTemplate(SYSTEM_ROLE_DEFINITIONS.operator.permissions)}
                        >
                          执行者
                        </Button>
                        <Button
                          type='button'
                          variant='secondary'
                          size='sm'
                          className='h-7 text-label'
                          onClick={() => applyTemplate(SYSTEM_ROLE_DEFINITIONS.viewer.permissions)}
                        >
                          只读
                        </Button>
                        <Button
                          type='button'
                          variant='ghost'
                          size='sm'
                          className='h-7 text-label text-muted-foreground'
                          onClick={() => applyTemplate([])}
                        >
                          清空
                        </Button>
                      </div>
                    </div>
                  )}

                  <FormField
                    control={form.control}
                    name='permissions'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>权限配置</FormLabel>
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
                </div>

                {/* 右侧：实时透视与能力大图预览 */}
                <div className='lg:col-span-5 overflow-y-auto border-s border-border ps-4 space-y-4'>
                  <div className='text-label font-semibold text-muted-foreground uppercase tracking-wider'>
                    实时能力透视
                  </div>
                  <CapabilityPreview permissions={form.watch('permissions')} />
                </div>
              </div>
            </form>
          </Form>
        </div>

        <SheetFooter className='p-4 px-6 border-t border-border flex items-center justify-end gap-2 bg-card'>
          <Button
            type='button'
            variant='outline'
            onClick={() => onOpenChange(false)}
          >
            {locked ? '关闭' : '取消'}
          </Button>
          {!locked && (
            <Button type='submit' form='role-form' disabled={saving}>
              保存
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

