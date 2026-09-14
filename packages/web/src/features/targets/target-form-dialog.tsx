import { useState } from 'react'
import { z } from 'zod'
import { useForm, useWatch, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import {
  AUTH_METHODS,
  CAPTCHA_MODES,
  LOGIN_LOCATOR_BY,
  TARGET_STATUSES,
  compactLoginFields,
  createTargetBodySchema,
  type CreateTargetAccountBody,
  type LoginLocatorBy,
  type TargetDto,
  type TargetLoginFields,
} from '@cairn/shared'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { createTarget, updateTarget } from '@/lib/targets-api'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
  FormDescription,
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
import {
  AUTH_METHOD_LABELS,
  CAPTCHA_MODE_LABELS,
  LOGIN_FIELD_ROLE_LABELS,
  LOGIN_LOCATOR_BY_LABELS,
  TARGET_STATUS_LABELS,
} from './labels'

const formSchema = z
  .object({
    code: z.string(),
    name: z.string().min(1, '请填写名称。'),
    entryUrl: z.string().min(1, '请填写入口 URL。'),
    loginUrl: z.string(),
    authMethod: z.enum(AUTH_METHODS),
    captchaMode: z.enum(CAPTCHA_MODES),
    status: z.enum(TARGET_STATUSES),
    accountDisplayName: z.string(),
    accountUsername: z.string(),
    accountPassword: z.string(),
    usernameBy: z.enum(LOGIN_LOCATOR_BY),
    usernameValue: z.string(),
    passwordBy: z.enum(LOGIN_LOCATOR_BY),
    passwordValue: z.string(),
    submitBy: z.enum(LOGIN_LOCATOR_BY),
    submitValue: z.string(),
  })
  .superRefine((values, ctx) => {
    const hasAny =
      values.accountDisplayName.trim() !== '' ||
      values.accountUsername.trim() !== '' ||
      values.accountPassword.trim() !== ''
    if (!hasAny) return
    if (values.accountDisplayName.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['accountDisplayName'],
        message: '填写首个账号时请给出显示名。',
      })
    }
    if (values.accountUsername.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['accountUsername'],
        message: '填写首个账号时请给出登录名。',
      })
    }
  })
type FormValues = z.infer<typeof formSchema>

const EMPTY_VALUES: FormValues = {
  code: '',
  name: '',
  entryUrl: '',
  loginUrl: '',
  authMethod: 'password',
  captchaMode: 'none',
  status: 'active',
  accountDisplayName: '',
  accountUsername: '',
  accountPassword: '',
  usernameBy: 'id',
  usernameValue: '',
  passwordBy: 'id',
  passwordValue: '',
  submitBy: 'id',
  submitValue: '',
}

function locatorFromForm(by: LoginLocatorBy, value: string) {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : { by, value: trimmed }
}

function loginFieldsFromForm(values: FormValues): TargetLoginFields | null {
  return compactLoginFields({
    username: locatorFromForm(values.usernameBy, values.usernameValue),
    password: locatorFromForm(values.passwordBy, values.passwordValue),
    submit: locatorFromForm(values.submitBy, values.submitValue),
  })
}

function accountFromForm(
  values: FormValues
): CreateTargetAccountBody | undefined {
  const displayName = values.accountDisplayName.trim()
  const username = values.accountUsername.trim()
  const password = values.accountPassword
  if (!displayName && !username && password.trim() === '') return undefined
  return {
    displayName,
    username,
    status: 'active',
    ...(password.trim() === '' ? {} : { password }),
  }
}

function valuesFromTarget(current: TargetDto): FormValues {
  return {
    ...EMPTY_VALUES,
    code: current.code,
    name: current.name,
    entryUrl: current.entryUrl,
    loginUrl: current.loginUrl ?? '',
    authMethod: current.authMethod,
    captchaMode: current.captchaMode,
    status: current.status,
    usernameBy: current.loginFields?.username?.by ?? 'id',
    usernameValue: current.loginFields?.username?.value ?? '',
    passwordBy: current.loginFields?.password?.by ?? 'id',
    passwordValue: current.loginFields?.password?.value ?? '',
    submitBy: current.loginFields?.submit?.by ?? 'id',
    submitValue: current.loginFields?.submit?.value ?? '',
  }
}

function hasAnyLoginField(
  fields: TargetLoginFields | null | undefined
): boolean {
  return Boolean(fields?.username || fields?.password || fields?.submit)
}

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
  const [accountOpen, setAccountOpen] = useState(!current)
  const [locatorOpen, setLocatorOpen] = useState(
    hasAnyLoginField(current?.loginFields)
  )
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: current ? valuesFromTarget(current) : EMPTY_VALUES,
  })

  const authMethod = useWatch({ control: form.control, name: 'authMethod' })
  const captchaMode = useWatch({ control: form.control, name: 'captchaMode' })

  const onSubmit = async (values: FormValues) => {
    setSaving(true)
    try {
      const loginFields = loginFieldsFromForm(values)
      if (isEdit && current) {
        await updateTarget(current.id, {
          name: values.name,
          entryUrl: values.entryUrl,
          loginUrl: values.loginUrl.trim() === '' ? null : values.loginUrl,
          authMethod: values.authMethod,
          captchaMode: values.captchaMode,
          status: values.status,
          loginFields,
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
    <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
      <DialogHeader>
        <DialogTitle>{isEdit ? '编辑目标系统' : '新建目标系统'}</DialogTitle>
        <DialogDescription>
          登记要仿真的外部业务系统。URL 只是入口，不是系统身份。
        </DialogDescription>
      </DialogHeader>
      <Form {...form}>
        <form className='space-y-4' onSubmit={form.handleSubmit(onSubmit)}>
          <FormField
            control={form.control}
            name='code'
            render={({ field }) => (
              <FormItem>
                <FormLabel>编码</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    disabled={isEdit}
                    placeholder='tower-preprod'
                  />
                </FormControl>
                <FormDescription>
                  {isEdit
                    ? '创建后不可改。'
                    : '小写字母开头的 slug，2–63 字符，创建后不可改。'}
                </FormDescription>
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
                  <Input {...field} placeholder='铁塔视联' />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='entryUrl'
            render={({ field }) => (
              <FormItem>
                <FormLabel>入口 URL</FormLabel>
                <FormControl>
                  <Input {...field} placeholder='https://example.com/#/home' />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name='loginUrl'
            render={({ field }) => (
              <FormItem>
                <FormLabel>登录 URL（可选）</FormLabel>
                <FormControl>
                  <Input {...field} placeholder='留空则与入口相同' />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className='grid gap-4 sm:grid-cols-2'>
            <FormField
              control={form.control}
              name='authMethod'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>认证方式</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      field.onChange(value)
                      if (!isEdit) setAccountOpen(value === 'password')
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {AUTH_METHODS.map((value) => (
                        <SelectItem key={value} value={value}>
                          {AUTH_METHOD_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name='captchaMode'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>验证码</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CAPTCHA_MODES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {CAPTCHA_MODE_LABELS[value]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
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

          {!isEdit ? (
            <section className='space-y-3 border-t border-border pt-4'>
              <SectionToggle
                open={accountOpen}
                onOpenChange={setAccountOpen}
                title='第一个目标账号'
              />
              {accountOpen ? (
                <div className='space-y-4'>
                  {authMethod === 'manual' ? (
                    <p className='text-body text-muted-foreground'>
                      仅手工登录时仍可登记备用号，不会自动使用。
                    </p>
                  ) : null}
                  <FormField
                    control={form.control}
                    name='accountDisplayName'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>显示名</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder='演示账号' />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name='accountUsername'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>登录名</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder='demo' />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name='accountPassword'
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>密码</FormLabel>
                        <FormControl>
                          <PasswordInput
                            {...field}
                            placeholder='建议填写，也可稍后补齐'
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ) : null}
            </section>
          ) : null}

          <section className='space-y-3 border-t border-border pt-4'>
            <SectionToggle
              open={locatorOpen}
              onOpenChange={setLocatorOpen}
              title='登录框定位（可选）'
            />
            {locatorOpen ? (
              <div className='space-y-4'>
                {captchaMode !== 'none' ? (
                  <Alert variant='warning'>
                    <AlertDescription>
                      已声明{CAPTCHA_MODE_LABELS[captchaMode]}
                      ，自动续登不能作为默认承诺。
                    </AlertDescription>
                  </Alert>
                ) : null}
                {authMethod === 'manual' ? (
                  <p className='text-body text-muted-foreground'>
                    仅手工登录时定位仅作备用。
                  </p>
                ) : null}
                <p className='text-body text-muted-foreground'>
                  知道输入框的 id 或 name
                  就填；留空则以后试填时按常见字段猜测。保存不会打开目标页面。
                </p>
                <LocatorRow
                  form={form}
                  role='username'
                  placeholder='username'
                />
                <LocatorRow
                  form={form}
                  role='password'
                  placeholder='password'
                />
                <LocatorRow form={form} role='submit' placeholder='login' />
              </div>
            ) : null}
          </section>

          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type='submit' loading={saving}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  )
}

function SectionToggle({
  open,
  onOpenChange,
  title,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
}) {
  return (
    <button
      type='button'
      className='flex w-full items-center justify-between text-left text-body font-medium'
      onClick={() => onOpenChange(!open)}
      aria-expanded={open}
    >
      <span>{title}</span>
      <span className='flex items-center gap-1 text-muted-foreground'>
        {open ? '收起' : '展开'}
        <ChevronDown className={open ? 'size-4 rotate-180' : 'size-4'} />
      </span>
    </button>
  )
}

function LocatorRow({
  form,
  role,
  placeholder,
}: {
  form: UseFormReturn<FormValues>
  role: 'username' | 'password' | 'submit'
  placeholder: string
}) {
  const byName = `${role}By` as const
  const valueName = `${role}Value` as const
  return (
    <div className='space-y-2'>
      <FormLabel>{LOGIN_FIELD_ROLE_LABELS[role]}</FormLabel>
      <div className='grid grid-cols-[9.5rem_1fr] gap-2'>
        <FormField
          control={form.control}
          name={byName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className='sr-only'>
                {LOGIN_FIELD_ROLE_LABELS[role]}定位方式
              </FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {LOGIN_LOCATOR_BY.map((value) => (
                    <SelectItem key={value} value={value}>
                      {LOGIN_LOCATOR_BY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={valueName}
          render={({ field }) => (
            <FormItem>
              <FormLabel className='sr-only'>
                {LOGIN_FIELD_ROLE_LABELS[role]}定位值
              </FormLabel>
              <FormControl>
                <Input {...field} placeholder={placeholder} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  )
}
