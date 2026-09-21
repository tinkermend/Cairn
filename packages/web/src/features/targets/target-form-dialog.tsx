import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import {
  createTargetBodySchema,
  type TargetDto,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createTarget, updateTarget } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Form } from '@/components/ui/form'
import { TargetFormBasicFields } from './target-form-basic-fields'
import { TargetFormAccountSection } from './target-form-account-section'
import { TargetFormLocatorSection } from './target-form-locator-section'
import {
  EMPTY_TARGET_FORM_VALUES,
  accountFromForm,
  captchaFromForm,
  hasAnyLoginField,
  hasCaptchaLocator,
  loginFieldsFromForm,
  selectorsFromForm,
  targetFormSchema,
  valuesFromTarget,
  type TargetFormValues,
} from './target-form-schema'

type TargetFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  current?: TargetDto
  onCreated?: (target: TargetDto) => void
}

export function TargetFormDialog({
  open,
  onOpenChange,
  current,
  onCreated,
}: TargetFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <TargetFormFields
          key={current?.id ?? 'create'}
          current={current}
          onOpenChange={onOpenChange}
          onCreated={onCreated}
        />
      ) : null}
    </Dialog>
  )
}

function TargetFormFields({
  current,
  onOpenChange,
  onCreated,
}: Omit<TargetFormDialogProps, 'open'>) {
  const isEdit = !!current
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [activeAccordion, setActiveAccordion] = useState<'account' | 'locator' | null>(
    !current
      ? 'account'
      : hasAnyLoginField(current?.loginFields) || hasCaptchaLocator(current?.captcha)
        ? 'locator'
        : null
  )

  const accountOpen = activeAccordion === 'account'
  const locatorOpen = activeAccordion === 'locator'

  const handleAccountToggle = (open: boolean) => {
    setActiveAccordion(open ? 'account' : null)
  }

  const handleLocatorToggle = (open: boolean) => {
    setActiveAccordion(open ? 'locator' : null)
  }

  const form = useForm<TargetFormValues>({
    resolver: zodResolver(targetFormSchema),
    defaultValues: current ? valuesFromTarget(current) : EMPTY_TARGET_FORM_VALUES,
  })

  const onSubmit = async (values: TargetFormValues) => {
    setSaving(true)
    try {
      const loginFields = loginFieldsFromForm(values)
      const captcha = captchaFromForm(values)
      if (isEdit && current) {
        await updateTarget(current.id, {
          name: values.name,
          entryUrl: values.entryUrl,
          loginUrl: values.loginUrl.trim() === '' ? null : values.loginUrl,
          authMethod: values.authMethod,
          captchaMode: values.captchaMode,
          status: values.status,
          loginFields,
          captcha,
          sensitiveSelectors: selectorsFromForm(values.sensitiveSelectors),
        })
        toast.success('目标系统已更新')
        await queryClient.invalidateQueries({ queryKey: ['targets'] })
        await queryClient.invalidateQueries({
          queryKey: ['target', current.id],
        })
        onOpenChange(false)
      } else {
        const parsed = createTargetBodySchema.parse({
          code: values.code,
          name: values.name,
          entryUrl: values.entryUrl,
          loginUrl: values.loginUrl.trim() === '' ? null : values.loginUrl,
          authMethod: values.authMethod,
          captchaMode: values.captchaMode,
          status: values.status,
          loginFields,
          captcha,
          sensitiveSelectors: selectorsFromForm(values.sensitiveSelectors),
          account: accountFromForm(values),
        })
        const created = await createTarget(parsed)
        toast.success('目标系统已创建')
        await queryClient.invalidateQueries({ queryKey: ['targets'] })
        onOpenChange(false)
        onCreated?.(created)
      }
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className='flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl'>
      <DialogHeader className='shrink-0 border-b border-border bg-card px-6 py-4 text-left'>
        <DialogTitle className='text-section font-semibold text-text-primary'>
          {isEdit ? '编辑目标系统' : '新建目标系统'}
        </DialogTitle>
        <DialogDescription className='text-small text-muted-foreground'>
          登记要仿真的外部业务系统。URL 只是入口，不是系统身份。
        </DialogDescription>
      </DialogHeader>

      <Form {...form}>
        <form
          className='flex flex-1 flex-col min-h-0 overflow-hidden'
          onSubmit={form.handleSubmit(onSubmit)}
        >
          <div className='flex-1 overflow-y-auto px-6 py-5'>
            <div className='grid grid-cols-1 md:grid-cols-[1.15fr_1fr] gap-6 items-start'>
              {/* 左列：系统身份与核心准入 */}
              <div className='space-y-4'>
                <div className='flex items-center justify-between pb-1.5 border-b border-border-divider'>
                  <h4 className='text-body font-semibold text-text-primary'>
                    系统准入
                  </h4>
                </div>
                <TargetFormBasicFields
                  form={form}
                  isEdit={isEdit}
                  onAuthMethodChange={(method) => {
                    if (!isEdit && method === 'password') {
                      setActiveAccordion('account')
                    }
                  }}
                />
              </div>

              {/* 右列：运行时装配（手风琴互斥，避免左右高度失衡） */}
              <div className='space-y-4'>
                <div className='flex items-center justify-between pb-1.5 border-b border-border-divider'>
                  <h4 className='text-body font-semibold text-text-primary'>
                    运行时装配
                  </h4>
                  <span className='rounded-sm bg-surface-subtle px-1.5 py-0.5 text-label text-muted-foreground'>
                    可选
                  </span>
                </div>

                {!isEdit ? (
                  <TargetFormAccountSection
                    form={form}
                    open={accountOpen}
                    onOpenChange={handleAccountToggle}
                  />
                ) : (
                  <div className='rounded-lg border border-border-divider bg-surface-subtle/30 p-3 text-label text-muted-foreground'>
                    目标账号已在详情页的独立列表管理。如需维护账号请在创建后前往详情页。
                  </div>
                )}

                <TargetFormLocatorSection
                  form={form}
                  open={locatorOpen}
                  onOpenChange={handleLocatorToggle}
                />
              </div>
            </div>
          </div>

          <DialogFooter className='shrink-0 border-t border-border bg-surface-header/90 px-6 py-3.5 backdrop-blur-sm sm:justify-end gap-2.5'>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type='submit'
              loading={saving}
              className='action-shadow'
            >
              保存
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  )
}
