import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import {
  TARGET_CONFIG_FORM_ID,
  TARGET_CONFIG_FORM_FIELDS,
  createTargetBodySchema,
  validateTargetFormProposalChange,
  type TargetDto,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { canCreateTargetWithCredential } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
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
  loginLeaveTimeoutFromForm,
  selectorsFromForm,
  targetEditFormSchema,
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
    <Dialog open={open} onOpenChange={onOpenChange} variant='inspection'>
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
  const user = useAuthStore((state) => state.auth.user)
  const canWriteInitialCredential = canCreateTargetWithCredential(user)
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
    resolver: zodResolver(isEdit ? targetEditFormSchema : targetFormSchema),
    defaultValues: current ? valuesFromTarget(current) : EMPTY_TARGET_FORM_VALUES,
  })

  const watchedValues = form.watch()
  const draftValues = useMemo(() => {
    const res: Record<string, string> = {}
    if (watchedValues.name) res.name = watchedValues.name
    if (watchedValues.code) res.code = watchedValues.code
    if (watchedValues.entryUrl) res.entryUrl = watchedValues.entryUrl
    if (watchedValues.loginUrl) res.loginUrl = watchedValues.loginUrl
    if (
      watchedValues.loginLeaveTimeoutSeconds !== undefined &&
      watchedValues.loginLeaveTimeoutSeconds !== null &&
      watchedValues.loginLeaveTimeoutSeconds !== ''
    ) {
      res.loginLeaveTimeoutSeconds = String(watchedValues.loginLeaveTimeoutSeconds)
    }
    if (watchedValues.landingSettleMode) res.landingSettleMode = watchedValues.landingSettleMode
    if (
      watchedValues.landingSettleTimeoutSeconds !== undefined &&
      watchedValues.landingSettleTimeoutSeconds !== null &&
      watchedValues.landingSettleTimeoutSeconds !== ''
    ) {
      res.landingSettleTimeoutSeconds = String(watchedValues.landingSettleTimeoutSeconds)
    }
    if (watchedValues.authMethod) res.authMethod = watchedValues.authMethod
    if (watchedValues.captchaMode) res.captchaMode = watchedValues.captchaMode
    if (watchedValues.status) res.status = watchedValues.status
    return res
  }, [
    watchedValues.name,
    watchedValues.code,
    watchedValues.entryUrl,
    watchedValues.loginUrl,
    watchedValues.loginLeaveTimeoutSeconds,
    watchedValues.landingSettleMode,
    watchedValues.landingSettleTimeoutSeconds,
    watchedValues.authMethod,
    watchedValues.captchaMode,
    watchedValues.status,
  ])

  useAssistantContextBinding(
    user?.permissions.includes('ai:assist')
      ? {
          page: 'target',
          targetId: current?.id,
          summaryText: isEdit
            ? `正在编辑目标系统：${current?.name}`
            : '正在新建目标系统',
          statusLabel: isEdit ? '编辑目标' : '新建目标',
          statusTone: 'info',
          activeForm: {
            formId: TARGET_CONFIG_FORM_ID,
            mode: isEdit ? 'edit' : 'create',
            targetId: current?.id,
            draftValues,
          },
          chips: [
            ...(user?.permissions.includes('target:write')
              ? [
                  {
                    id: 'target-form-timeout-propose',
                    label: '⏱️ 将登录等待设为30秒',
                    question: '帮我把这个目标系统的提交后等待离开登录页超时改成30秒。',
                    capabilityHint: 'target.propose-form' as const,
                  },
                ]
              : []),
            {
              id: 'target-form-timeout-help',
              label: '超时配置说明',
              question: '目标系统配置里的登录页停留超时是选填吗？不填会怎样？',
              capabilityHint: 'knowledge.answer' as const,
            },
            {
              id: 'target-form-settle-help',
              label: '整理预算说明',
              question: '目标系统的登录后整理预算有什么作用？',
              capabilityHint: 'knowledge.answer' as const,
            },
            {
              id: 'target-form-rules-help',
              label: '认证方式说明',
              question: '目标系统的认证方式可选值有哪些？',
              capabilityHint: 'knowledge.answer' as const,
            },
          ],
        }
      : null,
  )

  const preAdoptValuesRef = useRef<Record<string, any> | null>(null)

  useEffect(() => {
    if (!user?.permissions.includes('target:write')) return
    const register = useAssistantStore.getState().registerAdoptHandler
    const registerRollback = useAssistantStore.getState().registerRollbackHandler

    register(async (proposal) => {
      if (proposal.kind !== 'target_form') {
        return { ok: false, reason: '仅支持采纳目标系统配置建议' }
      }
      if (isEdit && proposal.mode === 'create') {
        return { ok: false, reason: '当前为编辑模式，无法采纳新建建议' }
      }
      if (!isEdit && proposal.mode === 'edit') {
        return { ok: false, reason: '当前为新建模式，无法采纳编辑建议' }
      }
      for (const change of proposal.changes) {
        const issue = validateTargetFormProposalChange(change, isEdit ? 'edit' : 'create')
        if (issue) {
          return { ok: false, reason: issue }
        }
      }

      // 采纳前记录快照（仅记录 proposal 触碰的字段当前值，避免影响用户手填的其他字段）
      const snapshot: Record<string, any> = {}
      for (const change of proposal.changes) {
        snapshot[change.fieldId] = form.getValues(change.fieldId as any)
      }
      preAdoptValuesRef.current = snapshot

      for (const change of proposal.changes) {
        form.setValue(change.fieldId as any, change.value, {
          shouldDirty: true,
          shouldValidate: true,
        })
      }
      const touchesAccount = proposal.changes.some((c) => c.fieldId === 'authMethod' || c.fieldId === 'captchaMode')
      if (touchesAccount) {
        setActiveAccordion('account')
      }
      if (proposal.pendingFields && proposal.pendingFields.length > 0) {
        const firstPending = proposal.pendingFields[0]
        setTimeout(() => {
          form.setFocus(firstPending as any)
        }, 50)
        const pendingNames = proposal.pendingFields
          .map((f) => TARGET_CONFIG_FORM_FIELDS.find((item) => item.id === f)?.label ?? f)
          .join('、')
        toast.info(`已应用 ${proposal.changes.length} 项配置，请补齐「${pendingNames}」后保存`)
      } else {
        toast.success(`已应用 ${proposal.changes.length} 项配置到表单，请核对后保存`)
      }
      return { ok: true, digest: `已应用 ${proposal.changes.length} 项配置` }
    })

    registerRollback(async (proposal) => {
      if (proposal.kind !== 'target_form') {
        return { ok: false, reason: '仅支持回滚目标系统配置建议' }
      }
      if (!preAdoptValuesRef.current) {
        return { ok: false, reason: '没有可撤销的采纳记录或已保存' }
      }
      for (const [fieldId, prevValue] of Object.entries(preAdoptValuesRef.current)) {
        form.setValue(fieldId as any, prevValue, {
          shouldDirty: true,
          shouldValidate: true,
        })
      }
      preAdoptValuesRef.current = null
      toast.info('已撤销采纳，恢复修改前状态')
      return { ok: true }
    })

    return () => {
      useAssistantStore.getState().registerAdoptHandler(null)
      useAssistantStore.getState().registerRollbackHandler(null)
    }
  }, [isEdit, form, user?.permissions])

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
          loginLeaveTimeoutMs: loginLeaveTimeoutFromForm(values.loginLeaveTimeoutSeconds),
          landingSettleMode: values.landingSettleMode,
          landingSettleTimeoutMs: loginLeaveTimeoutFromForm(values.landingSettleTimeoutSeconds),
          authMethod: values.authMethod,
          captchaMode: values.captchaMode,
          status: values.status,
          iconKey: values.iconKey,
          accentKey: values.accentKey,
          loginFields,
          captcha,
          sensitiveSelectors: selectorsFromForm(values.sensitiveSelectors),
        })
        preAdoptValuesRef.current = null
        useAssistantStore.getState().setLastAdopted(null)
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
          loginLeaveTimeoutMs: loginLeaveTimeoutFromForm(values.loginLeaveTimeoutSeconds),
          landingSettleMode: values.landingSettleMode,
          landingSettleTimeoutMs: loginLeaveTimeoutFromForm(values.landingSettleTimeoutSeconds),
          authMethod: values.authMethod,
          captchaMode: values.captchaMode,
          status: values.status,
          iconKey: values.iconKey,
          accentKey: values.accentKey,
          loginFields,
          captcha,
          sensitiveSelectors: selectorsFromForm(values.sensitiveSelectors),
          account: accountFromForm(values),
        })
        const created = await createTarget(parsed)
        preAdoptValuesRef.current = null
        useAssistantStore.getState().setLastAdopted(null)
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
          <div className='flex-1 overflow-y-auto px-6 pt-5 pb-8'>
            <div className='grid grid-cols-1 md:grid-cols-[1.15fr_1fr] gap-6 items-start'>
              {/* 左列：系统身份与核心准入 */}
              <div className='space-y-4'>
                <div className='flex items-center justify-between pb-1.5 border-b border-border-divider'>
                  <h4 className='text-body font-semibold text-text-primary'>
                    {isEdit ? '系统身份与入口' : '系统准入'}
                  </h4>
                </div>
                <TargetFormBasicFields
                  form={form}
                  isEdit={isEdit}
                  section={isEdit ? 'identity' : 'all'}
                  onAuthMethodChange={(method) => {
                    if (!isEdit && method === 'password') {
                      setActiveAccordion('account')
                    }
                  }}
                />
              </div>

              {/* 右列：运行时装配（编辑态承接运行策略，保持左右平衡） */}
              <div className='space-y-4'>
                <div className='flex items-center justify-between pb-1.5 border-b border-border-divider'>
                  <h4 className='text-body font-semibold text-text-primary'>
                    {isEdit ? '运行准入与装配' : '运行时装配'}
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
                    allowCredential={canWriteInitialCredential}
                  />
                ) : (
                  <TargetFormBasicFields
                    form={form}
                    isEdit={isEdit}
                    section='runtime'
                  />
                )}

                <TargetFormLocatorSection
                  form={form}
                  open={locatorOpen}
                  onOpenChange={handleLocatorToggle}
                />
              </div>
            </div>
          </div>

          <DialogFooter className='shrink-0 border-t border-border bg-card px-6 py-3.5 sm:justify-end gap-2.5'>
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
