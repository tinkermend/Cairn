import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FACTORY_PLATFORM_CONFIG,
  PLATFORM_SESSION_REUSE_POLICIES,
  hasPermission,
  platformConfigCurrentSchema,
  platformConfigDocumentSchema,
  type PlatformConfigDocument,
  type PlatformConfigRevision,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchPlatformConfig,
  fetchPlatformConfigRevisions,
  registerPlatformConfigSecret,
  restorePlatformConfig,
  testPlatformConfigConnection,
  updatePlatformConfig,
  validatePlatformConfig,
} from '@/lib/platform-config-api'
import { useAuthStore } from '@/stores/auth-store'
import { Button } from '@/components/ui/button'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { CursorPagination } from '@/components/data-table'
import { TruncatedText } from '@/components/truncated-text'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CAPTURE_MODE_LABELS, SESSION_REUSE_LABELS, SOURCE_LABELS } from './labels'

const TABS = [
  { id: 'ai', title: '浏览器 AI' },
  { id: 'execution', title: '执行默认值' },
  { id: 'session', title: '会话策略' },
  { id: 'evidence', title: '证据策略' },
  { id: 'revisions', title: '变更记录' },
] as const

type TabId = (typeof TABS)[number]['id']

function cloneDocument(document: PlatformConfigDocument): PlatformConfigDocument {
  return structuredClone(document)
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}

export function PlatformConfigPage() {
  const user = useAuthStore((state) => state.auth.user)
  const canWrite = Boolean(user && hasPermission(user.permissions, 'platform-config:write'))
  const client = useQueryClient()
  const current = useQuery({ queryKey: ['platform-config'], queryFn: fetchPlatformConfig })
  const [tab, setTab] = useState<TabId>('ai')
  const [reason, setReason] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const hydrated = useRef(false)
  const form = useForm<PlatformConfigDocument>({
    resolver: zodResolver(platformConfigDocumentSchema),
    defaultValues: FACTORY_PLATFORM_CONFIG,
  })

  useEffect(() => {
    if (!current.data || hydrated.current) return
    form.reset(cloneDocument(current.data.document))
    hydrated.current = true
  }, [current.data, form])

  const document = form.watch()
  const revision = current.data?.revision
  const updatedAt = current.data?.updatedAt
  const source = current.data?.source

  async function persist(next: PlatformConfigDocument, persistReason: string) {
    const expectedRevision =
      client.getQueryData<typeof current.data>(['platform-config'])?.revision ?? revision
    if (!expectedRevision) return
    setBusy(true)
    try {
      const saved = await updatePlatformConfig({
        expectedRevision,
        reason: persistReason,
        document: next,
      })
      client.setQueryData(['platform-config'], saved)
      form.reset(cloneDocument(saved.document))
      setReason('')
      toast.success(`已保存并生效，修订 ${saved.revision}`)
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        const latest = platformConfigCurrentSchema.safeParse(error.payload.details)
        const fallbackRevision =
          error.payload.details &&
          typeof error.payload.details === 'object' &&
          'revision' in error.payload.details &&
          typeof error.payload.details.revision === 'number'
            ? error.payload.details.revision
            : undefined
        if (latest.success) client.setQueryData(['platform-config'], latest.data)
        else if (fallbackRevision && current.data) {
          client.setQueryData(['platform-config'], { ...current.data, revision: fallbackRevision })
        } else {
          await current.refetch()
        }
        toast.error(
          `配置已被他人更新到修订 ${latest.success ? latest.data.revision : fallbackRevision ?? current.data?.revision ?? '未知'}，已保留你的输入，请核对后再次保存`,
        )
        return
      }
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function onSave() {
    const parsed = platformConfigDocumentSchema.safeParse(form.getValues())
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? '配置不合法')
      return
    }
    const persistReason = reason.trim()
    if (!persistReason) {
      toast.error('请填写变更原因')
      return
    }
    await persist(parsed.data, persistReason)
  }

  async function onValidate() {
    const parsed = platformConfigDocumentSchema.safeParse(form.getValues())
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? '配置不合法')
      return
    }
    try {
      await validatePlatformConfig(parsed.data)
      toast.success('校验通过')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '校验失败')
    }
  }

  async function onRegisterSecret() {
    if (!apiKey.trim()) {
      toast.error('请输入模型密钥')
      return
    }
    setBusy(true)
    try {
      const registered = await registerPlatformConfigSecret(apiKey)
      form.setValue('browserAi.secretRef', registered.secretRef, { shouldDirty: true })
      setApiKey('')
      toast.success('密钥已登记，尚未保存到当前配置')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '登记失败')
    } finally {
      setBusy(false)
    }
  }

  async function onTestConnection() {
    const values = form.getValues()
    if (!values.browserAi.baseUrl || !values.browserAi.model || !values.browserAi.modelFamily) {
      toast.error('请先填写模型地址、模型名和模型族')
      return
    }
    setBusy(true)
    try {
      const result = await testPlatformConfigConnection({
        baseUrl: values.browserAi.baseUrl,
        model: values.browserAi.model,
        modelFamily: values.browserAi.modelFamily,
        secretRef: values.browserAi.secretRef,
      })
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '连接测试失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='平台配置'
          description='管理跨场景默认策略。保存后只影响之后创建的新运行；已排队或进行中的运行继续使用自己的快照。'
        />
        {current.isPending ? (
          <PageSkeleton />
        ) : current.isError ? (
          <QueryErrorState title='无法加载平台配置' onRetry={() => void current.refetch()} />
        ) : (
          <section className='min-w-0 rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <p className='text-label text-muted-foreground'>
              当前修订 {revision} · {source ? SOURCE_LABELS[source] : '—'} ·{' '}
              {updatedAt ? formatTime(updatedAt) : '—'}
              {current.data?.reason ? ` · ${current.data.reason}` : ''}
            </p>
            <Tabs value={tab} onValueChange={(value) => setTab(value as TabId)} className='mt-4 gap-4'>
              <TabsList className='flex h-auto w-full flex-wrap'>
                {TABS.map((item) => (
                  <TabsTrigger key={item.id} value={item.id} className='flex-none'>
                    {item.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Form {...form}>
                <form
                  className='space-y-6'
                  onSubmit={(event) => {
                    event.preventDefault()
                    void onSave()
                  }}
                >
                  <TabsContent value='ai'>
                    <AiFields
                      canWrite={canWrite}
                      apiKey={apiKey}
                      secretRef={document.browserAi.secretRef}
                      onApiKeyChange={setApiKey}
                      onRegisterSecret={() => void onRegisterSecret()}
                      onTestConnection={() => void onTestConnection()}
                      busy={busy}
                    />
                  </TabsContent>
                  <TabsContent value='execution'>
                    <ExecutionFields canWrite={canWrite} />
                  </TabsContent>
                  <TabsContent value='session'>
                    <SessionFields canWrite={canWrite} />
                  </TabsContent>
                  <TabsContent value='evidence'>
                    <EvidenceFields canWrite={canWrite} />
                  </TabsContent>
                  {tab !== 'revisions' ? (
                    <div className='space-y-3 border-t border-border pt-4'>
                      <div className='space-y-2'>
                        <Label htmlFor='platform-config-reason'>变更原因</Label>
                        <Textarea
                          id='platform-config-reason'
                          value={reason}
                          disabled={!canWrite}
                          onChange={(event) => setReason(event.target.value)}
                          placeholder='说明这次修改的原因，会写入变更记录。'
                        />
                      </div>
                      <p className='text-label text-muted-foreground'>
                        当前默认超时 {document.execution.defaultTimeoutMs} ms。AI 请求超时必须小于每个
                        AI 步骤解析后的超时。
                      </p>
                      <div className='flex flex-wrap gap-2'>
                        <Can permission='platform-config:write'>
                          <Button type='submit' loading={busy}>
                            保存并生效
                          </Button>
                        </Can>
                        <Can permission='platform-config:write'>
                          <Button type='button' variant='outline' onClick={() => void onValidate()}>
                            校验
                          </Button>
                        </Can>
                      </div>
                    </div>
                  ) : null}
                </form>
              </Form>
              <TabsContent value='revisions'>
                <RevisionPanel
                  canWrite={canWrite}
                  expectedRevision={revision ?? 1}
                  onRestored={() => void client.invalidateQueries({ queryKey: ['platform-config'] })}
                />
              </TabsContent>
            </Tabs>
          </section>
        )}
      </Main>
    </>
  )
}

function AiFields({
  canWrite,
  apiKey,
  secretRef,
  onApiKeyChange,
  onRegisterSecret,
  onTestConnection,
  busy,
}: {
  canWrite: boolean
  apiKey: string
  secretRef?: { provider: string; secretId: string }
  onApiKeyChange: (value: string) => void
  onRegisterSecret: () => void
  onTestConnection: () => void
  busy: boolean
}) {
  return (
    <div className='grid gap-5'>
      <FormField
        name='browserAi.enabled'
        render={({ field }) => (
          <FormItem className='flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2'>
            <div>
              <FormLabel>启用浏览器仿真 AI</FormLabel>
              <FormDescription>关闭后不能新发布或创建含 AI 步骤的运行；已有运行继续按快照执行。</FormDescription>
            </div>
            <FormControl>
              <Switch checked={field.value} disabled={!canWrite} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
      <div className='grid gap-4 md:grid-cols-2'>
        <FormField
          name='browserAi.baseUrl'
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型服务地址</FormLabel>
              <FormControl>
                <Input
                  disabled={!canWrite}
                  placeholder='https://api.example.com/v1'
                  value={field.value ?? ''}
                  onChange={(event) => field.onChange(event.target.value || undefined)}
                />
              </FormControl>
              <FormDescription>
                不得在 URL 内嵌凭据。更换服务主机后必须重新登记密钥。普通用户看不到这个地址。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.model'
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型名</FormLabel>
              <FormControl>
                <Input
                  disabled={!canWrite}
                  value={field.value ?? ''}
                  onChange={(event) => field.onChange(event.target.value || undefined)}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.modelFamily'
          render={({ field }) => (
            <FormItem>
              <FormLabel>模型族</FormLabel>
              <FormControl>
                <Input
                  disabled={!canWrite}
                  placeholder='doubao-seed'
                  value={field.value ?? ''}
                  onChange={(event) => field.onChange(event.target.value || undefined)}
                />
              </FormControl>
              <FormDescription>须是 Worker 适配层支持的视觉模型族。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.requestTimeoutMs'
          render={({ field }) => (
            <FormItem>
              <FormLabel>单次请求超时（ms）</FormLabel>
              <FormControl>
                <Input
                  type='number'
                  disabled={!canWrite}
                  value={field.value}
                  onChange={(event) => field.onChange(Number(event.target.value))}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.stepMaxCalls'
          render={({ field }) => (
            <FormItem>
              <FormLabel>每步骤调用上限</FormLabel>
              <FormControl>
                <Input
                  type='number'
                  disabled={!canWrite}
                  value={field.value}
                  onChange={(event) => field.onChange(Number(event.target.value))}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name='browserAi.maxOutputTokens'
          render={({ field }) => (
            <FormItem>
              <FormLabel>单次输出 token 上限</FormLabel>
              <FormControl>
                <Input
                  type='number'
                  disabled={!canWrite}
                  value={field.value}
                  onChange={(event) => field.onChange(Number(event.target.value))}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      <div className='space-y-2 rounded-md border border-border px-3 py-3'>
        <Label>模型密钥</Label>
        <p className='text-label text-muted-foreground'>
          密钥只写不回显。
          {secretRef
            ? ` 已绑定 Secret ${secretRef.secretId.slice(0, 8)}…`
            : ' 尚未绑定 Secret。'}
        </p>
        <div className='flex flex-col gap-2 sm:flex-row'>
          <Input
            type='password'
            autoComplete='new-password'
            disabled={!canWrite}
            placeholder='粘贴新密钥'
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
          <Can permission='platform-config:write'>
            <Button type='button' variant='outline' loading={busy} onClick={onRegisterSecret}>
              登记密钥
            </Button>
          </Can>
          <Can permission='platform-config:write'>
            <Button type='button' variant='outline' loading={busy} onClick={onTestConnection}>
              测试连接
            </Button>
          </Can>
        </div>
      </div>
    </div>
  )
}

function ExecutionFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <FormField
        name='execution.defaultTimeoutMs'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认步骤超时（ms）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>未写超时的步骤继承此值。单次运行或步骤仍可覆盖。</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormItem>
        <FormLabel>默认自动重试</FormLabel>
        <p className='text-body'>0，不可改</p>
        <FormDescription>平台默认重试保持关闭。AI Action 即使步骤未写重试也不会自动重试。</FormDescription>
      </FormItem>
    </div>
  )
}

function SessionFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <FormField
        name='session.reuse'
        render={({ field }) => (
          <FormItem>
            <FormLabel>默认页面复用</FormLabel>
            <Select disabled={!canWrite} value={field.value ?? ''} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {PLATFORM_SESSION_REUSE_POLICIES.map((policy) => (
                  <SelectItem key={policy} value={policy}>
                    {SESSION_REUSE_LABELS[policy]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>重建会话仍是单次运行操作，不作为平台默认。</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.idleTtlSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>空闲寿命（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.maxLifetimeSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>最大寿命（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>必须大于空闲寿命。只影响新会话。</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='session.authWaitSeconds'
        render={({ field }) => (
          <FormItem>
            <FormLabel>人工认证等待（秒）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  )
}

function EvidenceFields({ canWrite }: { canWrite: boolean }) {
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      <CaptureField name='evidence.screenshot' label='截图采集' canWrite={canWrite} />
      <CaptureField name='evidence.trace' label='Trace 采集' canWrite={canWrite} />
      <FormField
        name='evidence.retainDays.screenshot'
        render={({ field }) => (
          <FormItem>
            <FormLabel>截图保留（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='evidence.retainDays.trace'
        render={({ field }) => (
          <FormItem>
            <FormLabel>一般 Trace 保留（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        name='evidence.retainDays.debugTrace'
        render={({ field }) => (
          <FormItem>
            <FormLabel>调试 Trace 保留（天）</FormLabel>
            <FormControl>
              <Input
                type='number'
                disabled={!canWrite}
                value={field.value}
                onChange={(event) => field.onChange(Number(event.target.value))}
              />
            </FormControl>
            <FormDescription>Trace 选「始终」时使用。始终不等于永久保存。</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      <p className='text-label text-muted-foreground md:col-span-2'>
        必要证据由代码约束，不能在这里删掉。
      </p>
    </div>
  )
}

function CaptureField({
  name,
  label,
  canWrite,
}: {
  name: 'evidence.screenshot' | 'evidence.trace'
  label: string
  canWrite: boolean
}) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select disabled={!canWrite} value={field.value ?? ''} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger className='w-full'>
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {(['off', 'on_failure', 'always'] as const).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {CAPTURE_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function RevisionPanel({
  canWrite,
  expectedRevision,
  onRestored,
}: {
  canWrite: boolean
  expectedRevision: number
  onRestored: () => void
}) {
  const page = useCursorPage()
  const revisions = useQuery({
    queryKey: ['platform-config', 'revisions', page.cursor, page.pageSize],
    queryFn: () => fetchPlatformConfigRevisions(page.cursor, page.pageSize),
  })
  const [restoreReason, setRestoreReason] = useState('')
  const [busyId, setBusyId] = useState<string>()

  async function restore(item: PlatformConfigRevision) {
    const reason = restoreReason.trim()
    if (!reason) {
      toast.error('恢复旧配置也需要填写原因')
      return
    }
    setBusyId(item.id)
    try {
      await restorePlatformConfig({
        revision: item.revision,
        expectedRevision,
        reason,
      })
      setRestoreReason('')
      toast.success(`已从修订 ${item.revision} 恢复为新修订`)
      onRestored()
      void revisions.refetch()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '恢复失败')
    } finally {
      setBusyId(undefined)
    }
  }

  if (revisions.isPending) return <PageSkeleton />
  if (revisions.isError) {
    return <QueryErrorState title='无法加载变更记录' onRetry={() => void revisions.refetch()} />
  }

  return (
    <div className='space-y-4'>
      <p className='text-label text-muted-foreground'>
        恢复会创建新修订，不会改写旧运行。差异不含明文密钥。
      </p>
      {canWrite ? (
        <div className='space-y-2'>
          <Label htmlFor='restore-reason'>恢复原因</Label>
          <Textarea
            id='restore-reason'
            value={restoreReason}
            onChange={(event) => setRestoreReason(event.target.value)}
            placeholder='说明为什么恢复这一版。'
          />
        </div>
      ) : null}
      {!revisions.data.items.length ? (
        <p className='text-body text-muted-foreground'>还没有变更记录。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>修订</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>原因</TableHead>
              <TableHead>差异</TableHead>
              <TableHead>时间</TableHead>
              {canWrite ? <TableHead>操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {revisions.data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.revision}</TableCell>
                <TableCell>{SOURCE_LABELS[item.source]}</TableCell>
                <TableCell>
                  <TruncatedText text={item.reason} />
                </TableCell>
                <TableCell>
                  <TruncatedText
                    text={
                      item.diff.length
                        ? item.diff.map((change) => change.path).join('、')
                        : '初始化'
                    }
                  />
                </TableCell>
                <TableCell>{formatTime(item.createdAt)}</TableCell>
                {canWrite ? (
                  <TableCell>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      loading={busyId === item.id}
                      onClick={() => void restore(item)}
                    >
                      恢复这一版
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CursorPagination
        pageIndex={page.pageIndex}
        pageSize={page.pageSize}
        hasPreviousPage={page.pageIndex > 0}
        hasNextPage={Boolean(revisions.data.nextCursor)}
        updating={revisions.isFetching}
        onPageSizeChange={page.setPageSize}
        onPreviousPage={page.goPrev}
        onNextPage={() => {
          if (revisions.data.nextCursor) page.goNext(revisions.data.nextCursor)
        }}
      />
    </div>
  )
}
