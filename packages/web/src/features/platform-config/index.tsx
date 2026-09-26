import { useEffect, useState } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  FACTORY_PLATFORM_CONFIG,
  hasPermission,
  modelServiceOrigin,
  platformConfigCurrentSchema,
  platformConfigWriteDocumentSchema,
  platformModelUrlSchema,
  type PlatformConfigCurrent,
  type PlatformConfigDocument,
} from '@cairn/shared'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchPlatformConfig,
  registerPlatformConfigSecret,
  testPlatformConfigConnection,
  updatePlatformConfig,
  validatePlatformConfig,
} from '@/lib/platform-config-api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Form } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { AiFields } from './ai-fields'
import { EvidenceFields } from './evidence-fields'
import { ExecutionFields } from './execution-fields'
import { cloneDocument, formatTime } from './helpers'
import { SOURCE_LABELS } from './labels'
import { PlatformAiFields } from './platform-ai-fields'
import { RevisionPanel } from './revision-panel'
import { SessionFields } from './session-fields'

const TABS = [
  { id: 'ai', title: '浏览器 AI' },
  { id: 'platform-ai', title: '平台 AI' },
  { id: 'execution', title: '执行默认值' },
  { id: 'session', title: '会话策略' },
  { id: 'evidence', title: '证据策略' },
  { id: 'revisions', title: '变更记录' },
] as const

type TabId = (typeof TABS)[number]['id']

export function PlatformConfigPage() {
  const user = useAuthStore((state) => state.auth.user)
  const canWrite = Boolean(
    user && hasPermission(user.permissions, 'platform-config:write')
  )
  const client = useQueryClient()
  const current = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
  })
  const [tab, setTab] = useState<TabId>(() => {
    if (typeof window === 'undefined') return 'ai'
    const param = new URLSearchParams(window.location.search).get('tab')
    if (param === 'analysis-ai' || param === 'platform-ai') return 'platform-ai'
    return 'ai'
  })
  const [reason, setReason] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [platformApiKey, setPlatformApiKey] = useState('')
  const [registeredBrowserAiUrl, setRegisteredBrowserAiUrl] = useState<string | undefined>()
  const [registeredPlatformAiUrl, setRegisteredPlatformAiUrl] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [editingRevision, setEditingRevision] = useState<number>()
  const form = useForm<PlatformConfigDocument>({
    resolver: zodResolver(
      platformConfigWriteDocumentSchema
    ) as Resolver<PlatformConfigDocument>,
    defaultValues: FACTORY_PLATFORM_CONFIG,
    shouldUnregister: false,
  })
  const isDirty = form.formState.isDirty

  useEffect(() => {
    if (
      !current.data ||
      busy ||
      editingRevision === current.data.revision ||
      (editingRevision !== undefined && isDirty)
    )
      return
    form.reset(cloneDocument(current.data.document))
    setEditingRevision(current.data.revision)
    setRegisteredBrowserAiUrl(current.data.document.browserAi.baseUrl)
    setRegisteredPlatformAiUrl(current.data.document.platformAi.baseUrl)
  }, [current.data, form, isDirty, busy, editingRevision])

  const document = form.watch()
  const revision = current.data?.revision
  const updatedAt = current.data?.updatedAt
  const source = current.data?.source
  const stale =
    editingRevision !== undefined &&
    revision !== undefined &&
    editingRevision !== revision

  async function resetEditor(saved: PlatformConfigCurrent) {
    await client.cancelQueries({ queryKey: ['platform-config'], exact: true })
    client.setQueryData(['platform-config'], saved)
    form.reset(cloneDocument(saved.document))
    setEditingRevision(saved.revision)
    setRegisteredBrowserAiUrl(saved.document.browserAi.baseUrl)
    setRegisteredPlatformAiUrl(saved.document.platformAi.baseUrl)
    setReason('')
    setApiKey('')
    setPlatformApiKey('')
  }

  async function persist(next: PlatformConfigDocument, persistReason: string) {
    const expectedRevision = editingRevision
    if (!expectedRevision || stale || busy) return
    setBusy(true)
    try {
      const saved = await updatePlatformConfig({
        expectedRevision,
        reason: persistReason,
        document: next,
      })
      await resetEditor(saved)
      toast.success(`已保存并生效，修订 ${saved.revision}`)
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) {
        const latest = platformConfigCurrentSchema.safeParse(
          error.payload.details
        )
        if (latest.success)
          client.setQueryData(['platform-config'], latest.data)
        else {
          await current.refetch()
        }
        toast.error(
          '配置已被他人更新，已保留你的输入。请载入最新配置后重新编辑。'
        )
        return
      }
      toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  function showWriteErrors(issues: { path: PropertyKey[]; message: string }[]) {
    for (const issue of issues) {
      const name = issue.path.join('.')
      if (name) form.setError(name as never, { type: 'manual', message: issue.message })
    }
    if (issues.some((issue) => issue.path[0] === 'browserAi')) {
      setTab('ai')
    } else if (
      issues.some((issue) => issue.path[0] === 'platformAi' || issue.path[0] === 'analysisAi')
    ) {
      setTab('platform-ai')
    }
    toast.error(issues[0]?.message ?? '配置不合法')
  }

  async function onSave() {
    const parsed = platformConfigWriteDocumentSchema.safeParse(cloneDocument(form.getValues()))
    if (!parsed.success) {
      showWriteErrors(parsed.error.issues)
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
    const parsed = platformConfigWriteDocumentSchema.safeParse(cloneDocument(form.getValues()))
    if (!parsed.success) {
      showWriteErrors(parsed.error.issues)
      return
    }
    try {
      await validatePlatformConfig(parsed.data)
      toast.success('校验通过')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '校验失败')
    }
  }

  async function onRegisterSecret(group: 'browserAi' | 'platformAi') {
    const rawKey = group === 'browserAi' ? apiKey : platformApiKey
    const key = rawKey.trim()
    if (!key) {
      toast.error('请输入模型密钥')
      return
    }
    const address = platformModelUrlSchema.safeParse(
      form.getValues(`${group}.baseUrl`)
    )
    if (!address.success) {
      toast.error('请先填写有效的模型服务地址，密钥将绑定此服务')
      return
    }
    setBusy(true)
    try {
      const registered = await registerPlatformConfigSecret({
        apiKey: key,
        baseUrl: address.data,
      })
      form.setValue(`${group}.secretRef`, registered.secretRef, {
        shouldDirty: true,
        shouldValidate: true,
      })
      if (group === 'browserAi') {
        setApiKey('')
        setRegisteredBrowserAiUrl(address.data)
      } else {
        setPlatformApiKey('')
        setRegisteredPlatformAiUrl(address.data)
      }
      toast.success('密钥已登记，保存配置后正式生效')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '登记失败')
    } finally {
      setBusy(false)
    }
  }

  function onUnbindSecret(group: 'browserAi' | 'platformAi') {
    form.setValue(`${group}.secretRef`, undefined, {
      shouldDirty: true,
      shouldValidate: true,
    })
    if (group === 'browserAi') {
      setApiKey('')
      setRegisteredBrowserAiUrl(undefined)
    } else {
      setPlatformApiKey('')
      setRegisteredPlatformAiUrl(undefined)
    }
    toast.success('已解除密钥绑定，保存配置后正式生效')
  }

  async function onTestConnection() {
    const values = form.getValues()
    if (
      !values.browserAi.baseUrl ||
      !values.browserAi.model ||
      !values.browserAi.modelFamily
    ) {
      toast.error('请先填写模型地址、模型名和视觉模型系列')
      return
    }
    if (!values.browserAi.secretRef && !apiKey.trim()) {
      toast.error('请先登记密钥后再测试连接')
      return
    }
    if (
      values.browserAi.secretRef &&
      registeredBrowserAiUrl &&
      values.browserAi.baseUrl
    ) {
      try {
        if (
          modelServiceOrigin(values.browserAi.baseUrl) !==
          modelServiceOrigin(registeredBrowserAiUrl)
        ) {
          toast.error('服务地址已变动，请重新登记密钥后再测试连接')
          return
        }
      } catch {
        // ignore parsing error
      }
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
      toast.error(
        error instanceof ApiRequestError ? error.message : '连接测试失败'
      )
    } finally {
      setBusy(false)
    }
  }

  async function onTestPlatformAiConnection() {
    const values = form.getValues()
    if (!values.platformAi.provider || !values.platformAi.baseUrl || !values.platformAi.model) {
      toast.error('请先选择模型提供商并填写服务地址和模型名')
      return
    }
    if (!values.platformAi.secretRef && !platformApiKey.trim()) {
      toast.error('请先登记密钥后再测试连接')
      return
    }
    if (
      values.platformAi.secretRef &&
      registeredPlatformAiUrl &&
      values.platformAi.baseUrl
    ) {
      try {
        if (
          modelServiceOrigin(values.platformAi.baseUrl) !==
          modelServiceOrigin(registeredPlatformAiUrl)
        ) {
          toast.error('服务地址已变动，请重新登记密钥后再测试连接')
          return
        }
      } catch {
        // ignore parsing error
      }
    }
    setBusy(true)
    try {
      const result = await testPlatformConfigConnection({
        baseUrl: values.platformAi.baseUrl,
        model: values.platformAi.model,
        provider: values.platformAi.provider,
        secretRef: values.platformAi.secretRef,
      })
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
    } catch (error) {
      toast.error(
        error instanceof ApiRequestError ? error.message : '连接测试失败'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='平台配置'
          description='保存后只影响之后新建的运行。'
        />
        {current.isPending ? (
          <PageSkeleton />
        ) : current.isError ? (
          <QueryErrorState
            title='无法加载平台配置'
            onRetry={() => void current.refetch()}
          />
        ) : editingRevision === undefined ? (
          <PageSkeleton />
        ) : (
          <section className='min-w-0 rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <p className='text-label text-muted-foreground'>
              当前修订 {revision} · {source ? SOURCE_LABELS[source] : '—'} ·{' '}
              {updatedAt ? formatTime(updatedAt) : '—'}
              {current.data?.reason ? ` · ${current.data.reason}` : ''}
            </p>
            {stale ? (
              <Alert variant='warning' className='mt-4'>
                <AlertTitle>配置已有更新，暂不能保存</AlertTitle>
                <AlertDescription>
                  <p>
                    你正在编辑修订 {editingRevision}，当前为修订 {revision}
                    。输入仍已保留；重新加载将放弃本次未保存修改。
                  </p>
                  <Button
                    type='button'
                    variant='outline'
                    disabled={busy}
                    onClick={() =>
                      current.data && void resetEditor(current.data)
                    }
                  >
                    放弃本次修改并载入最新配置
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as TabId)}
              className='mt-4 gap-4'
            >
              <TabsList className='flex h-auto w-full flex-wrap'>
                {TABS.map((item) => (
                  <TabsTrigger
                    key={item.id}
                    value={item.id}
                    disabled={busy}
                    className='flex-none'
                  >
                    {item.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Form {...form}>
                <form
                  className='flex min-w-0 flex-col'
                  onSubmit={(event) => {
                    event.preventDefault()
                    void onSave()
                  }}
                >
                  <div className='space-y-6'>
                  <TabsContent value='ai'>
                    <AiFields
                      canWrite={canWrite && !busy}
                      apiKey={apiKey}
                      secretRef={document.browserAi.secretRef}
                      boundBaseUrl={registeredBrowserAiUrl}
                      onApiKeyChange={setApiKey}
                      onRegisterSecret={() =>
                        void onRegisterSecret('browserAi')
                      }
                      onUnbindSecret={() => onUnbindSecret('browserAi')}
                      onTestConnection={() => void onTestConnection()}
                      busy={busy}
                    />
                  </TabsContent>
                  <TabsContent value='platform-ai'>
                    <PlatformAiFields
                      canWrite={canWrite && !busy}
                      apiKey={platformApiKey}
                      secretRef={document.platformAi?.secretRef}
                      boundBaseUrl={registeredPlatformAiUrl}
                      onApiKeyChange={setPlatformApiKey}
                      onRegisterSecret={() =>
                        void onRegisterSecret('platformAi')
                      }
                      onUnbindSecret={() => onUnbindSecret('platformAi')}
                      onTestConnection={() =>
                        void onTestPlatformAiConnection()
                      }
                      busy={busy}
                    />
                  </TabsContent>
                  <TabsContent value='execution'>
                    <ExecutionFields canWrite={canWrite && !busy} />
                  </TabsContent>
                  <TabsContent value='session'>
                    <SessionFields canWrite={canWrite && !busy} />
                  </TabsContent>
                  <TabsContent value='evidence'>
                    <EvidenceFields canWrite={canWrite && !busy} />
                  </TabsContent>
                  </div>
                  {tab !== 'revisions' ? (
                    <div className='sticky bottom-0 z-10 -mx-5 -mb-5 mt-6 border-t border-border bg-card px-5 py-3'>
                      <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
                        <div className='flex shrink-0 gap-2'>
                          <Can permission='platform-config:write'>
                            <Button
                              type='button'
                              variant='outline'
                              onClick={() => void onValidate()}
                            >
                              校验
                            </Button>
                          </Can>
                          <Can permission='platform-config:write'>
                            <Button
                              type='submit'
                              loading={busy}
                              disabled={stale || !editingRevision}
                            >
                              保存并生效
                            </Button>
                          </Can>
                        </div>
                        <Label htmlFor='platform-config-reason' className='shrink-0'>
                          变更原因
                        </Label>
                        <Input
                          id='platform-config-reason'
                          value={reason}
                          disabled={!canWrite || busy}
                          onChange={(event) => setReason(event.target.value)}
                          placeholder='说明这次修改的原因，会写入变更记录。'
                          className='min-w-0 flex-1'
                        />
                      </div>
                    </div>
                  ) : null}
                </form>
              </Form>
              <TabsContent value='revisions'>
                <RevisionPanel
                  canWrite={canWrite}
                  expectedRevision={revision ?? 1}
                  onRestored={resetEditor}
                  onBusyChange={setBusy}
                />
              </TabsContent>
            </Tabs>
          </section>
        )}
      </Main>
    </>
  )
}
