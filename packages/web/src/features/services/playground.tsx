import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  servicePlaygroundRunBodySchema,
  type ExternalRunDto,
  type ServiceCredentialCatalog,
  type ServiceCredentialDto,
} from '@cairn/shared'
import { ClipboardCopy, Download, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  createServicePlaygroundRun,
  downloadServiceOpenApi,
  fetchServiceCredentialCatalog,
} from '@/lib/services-api'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { RUN_STATUS_LABELS, runStatusTone } from '@/features/runs/labels'
import {
  connectionLabel,
  connectionTone,
  useRunObservation,
} from '@/features/runs/use-run-observation'

export type ServiceSnippetLanguage = 'curl' | 'node' | 'python' | 'go'

export function buildServiceCodeSnippet(input: {
  language: ServiceSnippetLanguage
  credentialId: string
  body: string
  baseUrl: string
}): string {
  const endpoint = `${input.baseUrl.replace(/\/$/, '')}/api/open/v1/runs`
  const authorization = `cairn_sk_${input.credentialId}.<SECRET>`
  const body = input.body.trim() || '{}'
  const curlBody = `'${body.replace(/'/g, `'\\''`)}'`
  if (input.language === 'curl') {
    return [
      `curl -X POST '${endpoint}' \\`,
      `  -H 'Authorization: Bearer ${authorization}' \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d ${curlBody}`,
    ].join('\n')
  }
  if (input.language === 'node') {
    return [
      `const response = await fetch('${endpoint}', {`,
      "  method: 'POST',",
      '  headers: {',
      `    Authorization: 'Bearer ${authorization}',`,
      "    'Content-Type': 'application/json',",
      '  },',
      `  body: JSON.stringify(${body}),`,
      '})',
      'if (!response.ok) throw new Error(`HTTP ${response.status}`)',
      'console.log(await response.json())',
    ].join('\n')
  }
  if (input.language === 'python') {
    return [
      'import json',
      'import requests',
      '',
      `payload = json.loads(${JSON.stringify(body)})`,
      `response = requests.post('${endpoint}',`,
      `    headers={'Authorization': 'Bearer ${authorization}'},`,
      '    json=payload, timeout=30)',
      'response.raise_for_status()',
      'print(response.json())',
    ].join('\n')
  }
  return [
    'package main',
    '',
    'import (',
    '  "bytes"',
    '  "fmt"',
    '  "io"',
    '  "net/http"',
    ')',
    '',
    'func main() {',
    `  body := []byte(${JSON.stringify(body)})`,
    `  req, err := http.NewRequest(http.MethodPost, "${endpoint}", bytes.NewReader(body))`,
    '  if err != nil { panic(err) }',
    `  req.Header.Set("Authorization", "Bearer ${authorization}")`,
    '  req.Header.Set("Content-Type", "application/json")',
    '  res, err := http.DefaultClient.Do(req)',
    '  if err != nil { panic(err) }',
    '  defer res.Body.Close()',
    '  payload, _ := io.ReadAll(res.Body)',
    '  fmt.Println(res.Status, string(payload))',
    '}',
  ].join('\n')
}

const snippetLabel: Record<ServiceSnippetLanguage, string> = {
  curl: 'cURL',
  node: 'Node.js',
  python: 'Python',
  go: 'Go',
}

function newIdempotencyKey() {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `playground-${Date.now()}-${suffix}`
}

function requestTemplate(
  scenario: ServiceCredentialCatalog['items'][number]['scenarios'][number],
  accountId: string | undefined
) {
  return JSON.stringify(
    {
      scenarioId: scenario.scenarioId,
      scenarioVersionId: scenario.versionId,
      ...(accountId ? { targetAccountId: accountId } : {}),
      input: Object.fromEntries(scenario.inputs.map((item) => [item.key, ''])),
      idempotencyKey: newIdempotencyKey(),
    },
    null,
    2
  )
}

export function ServicePlaygroundPanel({
  callerId,
  credentials,
  canRun,
}: {
  callerId: string
  credentials: ServiceCredentialDto[]
  canRun: boolean
}) {
  const [credentialId, setCredentialId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [scenarioVersionId, setScenarioVersionId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [requestBody, setRequestBody] = useState('')
  const [response, setResponse] = useState<ExternalRunDto>()
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [snippetLanguage, setSnippetLanguage] =
    useState<ServiceSnippetLanguage>('curl')

  useEffect(() => {
    if (!credentials.length) {
      setCredentialId('')
      return
    }
    if (!credentials.some((credential) => credential.id === credentialId))
      setCredentialId(credentials[0]!.id)
  }, [credentialId, credentials])

  const catalog = useQuery({
    queryKey: ['service', callerId, 'credential', credentialId, 'catalog'],
    queryFn: () => fetchServiceCredentialCatalog(callerId, credentialId),
    enabled: !!credentialId,
  })
  const target = useMemo(
    () => catalog.data?.items.find((item) => item.targetId === targetId),
    [catalog.data?.items, targetId]
  )
  const scenario = useMemo(
    () =>
      target?.scenarios.find((item) => item.versionId === scenarioVersionId),
    [scenarioVersionId, target?.scenarios]
  )
  const responseRunId = response?.id ?? ''
  const observation = useRunObservation(
    responseRunId,
    Boolean(responseRunId && canRun)
  )
  const liveRun = observation.run ?? response
  const accountSelectionValid = Boolean(target?.allowAnonymous || accountId)

  useEffect(() => {
    const items = catalog.data?.items ?? []
    if (!items.length) {
      setTargetId('')
      return
    }
    if (!items.some((item) => item.targetId === targetId))
      setTargetId(items[0]!.targetId)
  }, [catalog.data?.items, targetId])

  useEffect(() => {
    if (!target?.scenarios.length) {
      setScenarioVersionId('')
      return
    }
    if (!target.scenarios.some((item) => item.versionId === scenarioVersionId))
      setScenarioVersionId(target.scenarios[0]!.versionId)
  }, [scenarioVersionId, target?.scenarios])

  useEffect(() => {
    if (!target) {
      setAccountId('')
      return
    }
    if (target.accounts.some((account) => account.id === accountId)) return
    setAccountId(target.accounts[0]?.id ?? '')
  }, [accountId, target])

  useEffect(() => {
    if (!scenario || !target) {
      setRequestBody('')
      return
    }
    setRequestBody(requestTemplate(scenario, accountId || undefined))
  }, [accountId, scenario, target])

  const codeBaseUrl =
    typeof window === 'undefined'
      ? 'https://cairn.example.com'
      : window.location.origin

  async function copySnippet(language: ServiceSnippetLanguage) {
    const code = buildServiceCodeSnippet({
      language,
      credentialId,
      body: requestBody,
      baseUrl: codeBaseUrl,
    })
    try {
      await navigator.clipboard.writeText(code)
      toast.success(`${snippetLabel[language]} 调用代码已复制`)
    } catch {
      toast.error('无法复制代码，请手动复制')
    }
  }

  async function submit() {
    if (!canRun || !credentialId) return
    setError('')
    if (!accountSelectionValid) {
      setError('请先选择此凭据已授权的目标账号。')
      return
    }
    let body: unknown
    try {
      body = JSON.parse(requestBody)
    } catch {
      setError('请求参数必须是有效 JSON。')
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      setError('请求参数必须是 JSON 对象。')
      return
    }
    const parsed = servicePlaygroundRunBodySchema.safeParse({
      ...body,
      credentialId,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请求参数不符合接口契约。')
      return
    }
    setBusy(true)
    try {
      const result = await createServicePlaygroundRun(callerId, parsed.data)
      setResponse(result)
      toast.success('测试执行已受理')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '发起测试执行失败')
    } finally {
      setBusy(false)
    }
  }

  async function downloadOpenApi() {
    setDownloading(true)
    try {
      const result = await downloadServiceOpenApi(callerId)
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download =
        result.fileName ?? `cairn-service-${callerId}-openapi.json`
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      toast.success('OpenAPI 规范已下载')
    } catch (reason) {
      toast.error(
        reason instanceof Error ? reason.message : '下载 OpenAPI 失败'
      )
    } finally {
      setDownloading(false)
    }
  }

  if (!credentials.length) {
    return (
      <EmptyState
        title='没有可用于调试的有效凭据'
        description='请先在概览页签发一个有效凭据并授予目标和账号范围。'
      />
    )
  }

  return (
    <div className='space-y-6' aria-label='API 调试台'>
      <section className='flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border-card bg-card p-4 sm:p-5'>
        <div>
          <h3 className='text-section font-semibold'>API Playground</h3>
          <p className='mt-1 max-w-3xl text-small text-muted-foreground'>
            选择一把有效服务凭据和它被授予的已发布场景。服务端会重新验证
            凭据、Target、账号和执行权限。
          </p>
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => void downloadOpenApi()}
          disabled={downloading}
        >
          <Download />
          {downloading ? '生成中…' : '下载 OpenAPI 3.0'}
        </Button>
      </section>

      <section className='grid gap-4 rounded-lg border border-border-card bg-card p-4 sm:p-5 lg:grid-cols-3'>
        <label className='block space-y-2 text-small'>
          <span>服务凭据</span>
          <select
            className='h-10 w-full rounded-md border border-input bg-surface-control px-3 text-sm'
            value={credentialId}
            onChange={(event) => setCredentialId(event.target.value)}
            disabled={catalog.isFetching}
          >
            {credentials.map((credential) => (
              <option key={credential.id} value={credential.id}>
                {credential.name}
              </option>
            ))}
          </select>
        </label>
        <label className='block space-y-2 text-small'>
          <span>目标系统</span>
          <select
            className='h-10 w-full rounded-md border border-input bg-surface-control px-3 text-sm'
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            disabled={!catalog.data?.items.length}
          >
            {catalog.data?.items.map((item) => (
              <option key={item.targetId} value={item.targetId}>
                {item.targetName}
              </option>
            ))}
          </select>
        </label>
        <label className='block space-y-2 text-small'>
          <span>已发布场景版本</span>
          <select
            className='h-10 w-full rounded-md border border-input bg-surface-control px-3 text-sm'
            value={scenarioVersionId}
            onChange={(event) => setScenarioVersionId(event.target.value)}
            disabled={!target?.scenarios.length}
          >
            {target?.scenarios.map((item) => (
              <option key={item.versionId} value={item.versionId}>
                {item.name} · v{item.versionNo}
              </option>
            ))}
          </select>
        </label>
        <label className='block space-y-2 text-small'>
          <span>目标账号</span>
          <select
            className='h-10 w-full rounded-md border border-input bg-surface-control px-3 text-sm'
            value={accountId || '__anonymous__'}
            onChange={(event) =>
              setAccountId(
                event.target.value === '__anonymous__' ? '' : event.target.value
              )
            }
            disabled={!target}
          >
            {target?.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
            {target?.allowAnonymous ? (
              <option value='__anonymous__'>不指定账号</option>
            ) : null}
            {!target?.accounts.length && !target?.allowAnonymous ? (
              <option value=''>没有可用账号</option>
            ) : null}
          </select>
        </label>
        {scenario ? (
          <div className='self-end text-small text-muted-foreground lg:col-span-2'>
            输入参数：
            {scenario.inputs.length
              ? scenario.inputs.map((input) => input.label).join('、')
              : '此场景没有声明输入参数'}
          </div>
        ) : null}
      </section>

      {catalog.isPending ? (
        <PageSkeleton rows={3} />
      ) : catalog.isError ? (
        <QueryErrorState
          title='无法加载凭据可调用目录'
          onRetry={() => void catalog.refetch()}
        />
      ) : !target || !scenario ? (
        <EmptyState
          title='该凭据没有可调试的已发布场景'
          description='请检查凭据的 Target、账号授权和场景发布状态。'
        />
      ) : (
        <section className='grid gap-5 lg:grid-cols-2'>
          <div className='space-y-4 rounded-lg border border-border-card bg-card p-4 sm:p-5'>
            <div>
              <h3 className='text-section font-semibold'>请求参数</h3>
              <p className='mt-1 text-small text-muted-foreground'>
                这里展示开放 API 的请求正文。认证凭据只用于 Playground
                受控入口，不会写入 JSON。
              </p>
            </div>
            <Textarea
              aria-label='请求参数 JSON'
              className='min-h-88 font-mono text-xs leading-5'
              value={requestBody}
              onChange={(event) => setRequestBody(event.target.value)}
              spellCheck={false}
              disabled={!canRun || busy}
            />
            {error ? (
              <p className='text-small text-destructive'>{error}</p>
            ) : null}
            {!canRun ? (
              <p className='text-small text-status-warning-foreground'>
                需要服务写入、运行执行和运行读取权限，且调用方不能处于归档状态，才能使用在线调试。
              </p>
            ) : null}
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                onClick={() => void submit()}
                disabled={!canRun || !accountSelectionValid || busy}
              >
                <Play />
                {busy ? '提交中…' : '发起测试执行'}
              </Button>
              <Button
                type='button'
                variant='outline'
                onClick={() =>
                  setRequestBody(
                    requestTemplate(scenario, accountId || undefined)
                  )
                }
                disabled={busy}
              >
                <RefreshCw />
                重置骨架
              </Button>
            </div>
            <Tabs
              value={snippetLanguage}
              onValueChange={(value) =>
                setSnippetLanguage(value as ServiceSnippetLanguage)
              }
              className='gap-3 border-t pt-4'
            >
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <TabsList className='max-w-full overflow-x-auto'>
                  {(Object.keys(snippetLabel) as ServiceSnippetLanguage[]).map(
                    (language) => (
                      <TabsTrigger key={language} value={language}>
                        {snippetLabel[language]}
                      </TabsTrigger>
                    )
                  )}
                </TabsList>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => void copySnippet(snippetLanguage)}
                >
                  <ClipboardCopy />
                  复制当前代码
                </Button>
              </div>
              {(Object.keys(snippetLabel) as ServiceSnippetLanguage[]).map(
                (language) => (
                  <TabsContent key={language} value={language}>
                    <div className='space-y-2'>
                      <pre className='max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs leading-5 whitespace-pre-wrap'>
                        {buildServiceCodeSnippet({
                          language,
                          credentialId,
                          body: requestBody,
                          baseUrl: codeBaseUrl,
                        })}
                      </pre>
                      <Button
                        type='button'
                        size='sm'
                        variant='outline'
                        onClick={() => void copySnippet(language)}
                      >
                        <ClipboardCopy />
                        复制 {snippetLabel[language]} 代码
                      </Button>
                    </div>
                  </TabsContent>
                )
              )}
            </Tabs>
          </div>

          <div className='space-y-4 rounded-lg border border-border-card bg-card p-4 sm:p-5'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div>
                <h3 className='text-section font-semibold'>响应与运行状态</h3>
                <p className='mt-1 text-small text-muted-foreground'>
                  成功受理后通过 Run 的 SSE 事件刷新持久化状态，不使用高频轮询。
                </p>
              </div>
              {responseRunId ? (
                <Button size='sm' variant='outline' asChild>
                  <Link to='/runs/$runId' params={{ runId: responseRunId }}>
                    查看完整运行
                  </Link>
                </Button>
              ) : null}
            </div>
            {!response ? (
              <EmptyState
                title='等待测试执行'
                description='提交后会在这里显示响应报文与运行推进状态。'
              />
            ) : (
              <>
                <div className='flex flex-wrap items-center gap-2'>
                  <StatusBadge tone={runStatusTone(liveRun!.status)}>
                    {RUN_STATUS_LABELS[liveRun!.status] ?? liveRun!.status}
                  </StatusBadge>
                  <StatusBadge tone={connectionTone(observation.connection)}>
                    实时连接：{connectionLabel(observation.connection)}
                  </StatusBadge>
                  <span className='text-small text-muted-foreground'>
                    证据：{liveRun!.evidenceStatus}
                  </span>
                </div>
                <dl className='grid gap-x-4 gap-y-2 text-small sm:grid-cols-[8rem_1fr]'>
                  <dt className='text-muted-foreground'>Run ID</dt>
                  <dd>
                    <code className='break-all'>{response.id}</code>
                  </dd>
                  <dt className='text-muted-foreground'>目标 / 场景</dt>
                  <dd>
                    <code>{response.targetId}</code> /{' '}
                    <code>{response.scenarioVersionId}</code>
                  </dd>
                  <dt className='text-muted-foreground'>启动 / 结束</dt>
                  <dd>
                    {response.startedAt ?? '尚未启动'} ·{' '}
                    {response.finishedAt ?? '运行中'}
                  </dd>
                </dl>
                <details open>
                  <summary className='cursor-pointer text-small font-medium'>
                    响应报文
                  </summary>
                  <pre className='mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs leading-5 whitespace-pre-wrap'>
                    {JSON.stringify(response, null, 2)}
                  </pre>
                </details>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
