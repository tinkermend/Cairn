import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { TARGET_STATUSES, type TargetAccountDto } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createTargetAccount, updateTargetAccount } from '@/lib/targets-api'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PasswordInput } from '@/components/password-input'
import { TARGET_STATUS_LABELS } from './labels'

const formSchema = z.object({
  displayName: z.string().min(1, '请填写显示名。'),
  username: z.string().min(1, '请填写登录名。'),
  password: z.string(),
  status: z.enum(TARGET_STATUSES),
})
type FormValues = z.infer<typeof formSchema>

type AccountFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  current?: TargetAccountDto
}

export function AccountFormDialog({
  open,
  onOpenChange,
  targetId,
  current,
}: AccountFormDialogProps) {
  const isEdit = !!current
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: current
      ? {
          displayName: current.displayName,
          username: current.username,
          password: '',
          status: current.status,
        }
      : { displayName: '', username: '', password: '', status: 'active' },
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['target', targetId] })
    await queryClient.invalidateQueries({
      queryKey: ['target', targetId, 'accounts'],
    })
    await queryClient.invalidateQueries({ queryKey: ['targets'] })
  }

  const onSubmit = async (values: FormValues) => {
    setSaving(true)
    try {
      if (isEdit && current) {
        await updateTargetAccount(targetId, current.id, {
          displayName: values.displayName,
          username: values.username,
          status: values.status,
          ...(values.password.trim() === ''
            ? {}
            : { password: values.password }),
        })
        toast.success('目标账号已更新')
      } else {
        await createTargetAccount(targetId, {
          displayName: values.displayName,
          username: values.username,
          status: values.status,
          ...(values.password.trim() === ''
            ? {}
            : { password: values.password }),
        })
        toast.success('目标账号已添加')
      }
      await invalidate()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const clearPassword = async () => {
    if (!current) return
    setSaving(true)
    try {
      await updateTargetAccount(targetId, current.id, { clearPassword: true })
      toast.success('已清除保存的凭据')
      await invalidate()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '清除失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next)
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑目标账号' : '添加目标账号'}</DialogTitle>
          <DialogDescription>
            目标账号属于该外部系统，与控制台用户不是同一种账号。密码只写不读。
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form className='space-y-4' onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name='displayName'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>显示名</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='username'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>登录名</FormLabel>
                  <FormControl>
                    <Input {...field} />
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
                  <FormLabel>密码</FormLabel>
                  <FormControl>
                    <PasswordInput
                      {...field}
                      placeholder={isEdit ? '不修改则留空' : '可选，稍后补齐'}
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
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TARGET_STATUSES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {TARGET_STATUS_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter className='flex-col gap-2 sm:flex-row sm:justify-between'>
              {isEdit && current?.hasPassword ? (
                <Button
                  type='button'
                  variant='outline'
                  disabled={saving}
                  onClick={() => void clearPassword()}
                >
                  清除已保存凭据
                </Button>
              ) : (
                <span />
              )}
              <div className='flex gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  disabled={saving}
                  onClick={() => onOpenChange(false)}
                >
                  取消
                </Button>
                <Button type='submit' loading={saving}>
                  保存
                </Button>
              </div>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
