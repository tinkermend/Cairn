import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import {
  ACCOUNT_USAGES,
  TARGET_STATUSES,
  accountAllowsBusiness,
  type AccountSessionMode,
  type TargetAccountDto,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createTargetAccount,
  updateTargetAccount,
  updateTargetAccountIdentity,
} from '@/lib/targets-api'
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
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PasswordInput } from '@/components/password-input'
import {
  ValidityFields,
  defaultValidityFields,
  toValidityWrite,
  localDateTime,
} from '@/features/credentials/validity-fields'
import { ACCOUNT_USAGE_LABELS, TARGET_STATUS_LABELS } from './labels'

const formSchema = z.object({
  displayName: z.string().min(1, '请填写显示名。'),
  username: z.string().min(1, '请填写登录名。'),
  password: z.string(),
  status: z.enum(TARGET_STATUSES),
  usage: z.enum(ACCOUNT_USAGES),
  expectedIdentity: z.string(),
  confirmIdentityMaterial: z.boolean(),
  validityMode: z.enum(['days', 'months', 'permanent']),
  validityAmount: z.string(),
  validityTimeZone: z.string(),
  validityStartedAt: z.string(),
  maxConcurrentSessions: z.number().int().min(1).max(16),
})
type FormValues = z.infer<typeof formSchema>

type AccountFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  current?: TargetAccountDto
  accountSessionMode?: AccountSessionMode
  liveCount?: number
  effectiveCap?: number
}

export function AccountFormDialog({
  open,
  onOpenChange,
  targetId,
  current,
  accountSessionMode = 'exclusive',
  liveCount,
  effectiveCap,
}: AccountFormDialogProps) {
  const isEdit = !!current
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  /** 改成仅知识采集会让这个号从创建运行和试跑里消失，先说后果再保存。 */
  const [pendingMapOnly, setPendingMapOnly] = useState<FormValues | null>(null)
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: current
      ? {
          displayName: current.displayName,
          username: current.username,
          password: '',
          status: current.status,
          usage: current.usage ?? 'business',
          expectedIdentity: current.expectedIdentity ?? '',
          confirmIdentityMaterial: false,
          ...defaultValidityFields(current.validityPolicy),
          validityStartedAt: localDateTime(current.validityStartedAt),
          maxConcurrentSessions: current.maxConcurrentSessions ?? 1,
        }
      : {
          displayName: '',
          username: '',
          password: '',
          status: 'active',
          usage: 'business',
          expectedIdentity: '',
          confirmIdentityMaterial: false,
          ...defaultValidityFields(),
          validityStartedAt: '',
          maxConcurrentSessions: 1,
        },
  })

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['target', targetId] })
    await queryClient.invalidateQueries({
      queryKey: ['target', targetId, 'accounts'],
    })
    await queryClient.invalidateQueries({ queryKey: ['targets'] })
    await queryClient.invalidateQueries({ queryKey: ['credentials'] })
  }

  const onSubmit = async (values: FormValues) => {
    if (isEdit && current && accountAllowsBusiness(current.usage) && values.usage === 'map') {
      setPendingMapOnly(values)
      return
    }
    await saveValues(values)
  }

  const saveValues = async (values: FormValues) => {
    setSaving(true)
    try {
      if (isEdit && current) {
        const validityChanged =
          form.getFieldState('validityMode').isDirty ||
          form.getFieldState('validityAmount').isDirty ||
          form.getFieldState('validityTimeZone').isDirty ||
          form.getFieldState('validityStartedAt').isDirty
        const updated = await updateTargetAccount(targetId, current.id, {
          displayName: values.displayName,
          username: values.username,
          status: values.status,
          usage: values.usage,
          expectedRevision: current.credentialRevision,
          ...(values.password === ''
            ? {}
            : { password: values.password, validity: toValidityWrite(values) }),
          ...(values.password === '' && validityChanged
            ? {
                validity: {
                  ...toValidityWrite(values),
                  ...(values.validityStartedAt &&
                  form.getFieldState('validityStartedAt').isDirty
                    ? {
                        startedAt: new Date(
                          values.validityStartedAt
                        ).toISOString(),
                      }
                    : {}),
                },
              }
            : {}),
          ...(values.username !== current.username && values.password === ''
            ? {
                confirmIdentityMaterial:
                  values.confirmIdentityMaterial || undefined,
              }
            : {}),
          ...(accountSessionMode === 'concurrent'
            ? { maxConcurrentSessions: values.maxConcurrentSessions }
            : {}),
        })
        const nextIdentity = values.expectedIdentity.trim() || null
        if (nextIdentity !== (current.expectedIdentity ?? null)) {
          await updateTargetAccountIdentity(targetId, current.id, {
            expectedRevision: updated.configRevision ?? 1,
            expectedIdentity: nextIdentity,
          })
        }
        toast.success('目标账号已更新')
      } else {
        await createTargetAccount(targetId, {
          displayName: values.displayName,
          username: values.username,
          status: values.status,
          usage: values.usage,
          ...(values.password === ''
            ? {}
            : { password: values.password, validity: toValidityWrite(values) }),
          ...(accountSessionMode === 'concurrent'
            ? { maxConcurrentSessions: values.maxConcurrentSessions }
            : {}),
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
      await updateTargetAccount(targetId, current.id, {
        clearPassword: true,
        expectedRevision: current.credentialRevision,
      })
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
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) onOpenChange(next)
        }}
      >
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>
              {isEdit ? '编辑目标账号' : '添加目标账号'}
            </DialogTitle>
            <DialogDescription>
              目标账号属于该外部系统，与控制台用户不是同一种账号。密码只写不读。维护期限只提醒，不会停用账号或阻止运行。
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
                name='expectedIdentity'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>期望身份</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder='核验接口返回的账号标识，可空'
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
              {isEdit || form.watch('password') !== '' ? (
                <ValidityFields
                  control={form.control}
                  required={form.watch('password') !== ''}
                />
              ) : null}
              {isEdit &&
                form.watch('password') === '' &&
                form.watch('validityMode') !== 'permanent' && (
                  <FormField
                    control={form.control}
                    name='validityStartedAt'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>起算时间（本机时区）</FormLabel>
                        <FormControl>
                          <Input {...field} type='datetime-local' />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              {isEdit &&
              current &&
              form.watch('username') !== current.username &&
              form.watch('password') === '' ? (
                <FormField
                  control={form.control}
                  name='confirmIdentityMaterial'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>原密码仍适用于新登录名</FormLabel>
                      <FormControl>
                        <input
                          type='checkbox'
                          checked={field.value}
                          onChange={(event) =>
                            field.onChange(event.target.checked)
                          }
                        />
                      </FormControl>
                      <p className='text-label text-muted-foreground'>
                        不勾选则进入待确认，新运行不会取用当前密码，直到你确认或登记新密码。
                      </p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
              <FormField
                control={form.control}
                name='usage'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>用途</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {ACCOUNT_USAGES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {ACCOUNT_USAGE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className='text-label text-muted-foreground'>
                      每个目标系统只能有一个含知识采集用途的账号。选「仅知识采集」后，这个号不会出现在创建运行和试跑里。
                    </p>
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
              {accountSessionMode === 'concurrent' ? (
                <FormField
                  control={form.control}
                  name='maxConcurrentSessions'
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>最大并发会话</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type='number'
                          min={1}
                          max={16}
                          onChange={(event) => field.onChange(Number(event.target.value))}
                        />
                      </FormControl>
                      <p className='text-label text-muted-foreground'>
                        同一套凭据最多同时开几台独立浏览器。每台各自登录，不共享登录状态。
                      </p>
                      {isEdit ? (
                        <p className='text-label text-muted-foreground'>
                          当前活会话 {liveCount ?? current?.liveCount ?? 0} / 上限{' '}
                          {effectiveCap ?? current?.effectiveMaxConcurrentSessions ?? field.value}
                        </p>
                      ) : null}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
              {isEdit && current?.autoLoginPausedReason ? (
                <p className='text-label text-muted-foreground'>
                  自动登录暂停：{current.autoLoginPausedReason}
                </p>
              ) : null}
              <DialogFooter className='flex-col gap-2 sm:flex-row sm:justify-between'>
                {isEdit && current?.hasPassword ? (
                  <Button
                    type='button'
                    variant='outline'
                    disabled={saving}
                    onClick={() => setClearOpen(true)}
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
      <ConfirmDialog
        open={pendingMapOnly !== null}
        onOpenChange={(next) => {
          if (!next) setPendingMapOnly(null)
        }}
        title='改成仅知识采集？'
        desc='之后不能用这个号跑场景，它不会再出现在创建运行和试跑里。确定改成仅知识采集吗？'
        confirmText='改成仅知识采集'
        isLoading={saving}
        handleConfirm={() => {
          const values = pendingMapOnly
          setPendingMapOnly(null)
          if (values) void saveValues(values)
        }}
      />
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title='清除已保存密码'
        desc='将清除本平台保存的密码，后续自动登录需要重新录入。目标账号与有效期信息会保留。'
        confirmText='清除密码'
        destructive
        isLoading={saving}
        handleConfirm={() => void clearPassword()}
      />
    </>
  )
}
