import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  canonicalJson,
  compileModuleContent,
  moduleContentSchema,
  moduleWarningKey,
  type ActionModuleDetail,
  type ActionModuleVersionDto,
  type JsonValue,
  type ModuleContent,
  type ModulePublicationStatus,
} from '@cairn/shared'
import { toast } from 'sonner'
import {
  fetchActionModule,
  fetchActionModuleQuality,
  fetchActionModuleVersions,
  fetchModuleCapabilities,
  publishActionModule,
  saveActionModuleDraft,
  trialActionModule,
  updateActionModuleMeta,
} from '@/lib/action-modules-api'
import { ApiRequestError } from '@/lib/api-client'
import { fetchTarget } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { selectableStudioTypes } from '@/features/scenarios/step-registry'
import { ModuleContentEditor } from './content-editor'
import { MODULE_EXECUTION_MODE_LABELS, MODULE_PUBLICATION_STATUS_LABELS } from './labels'
import { ModulePublicationDialog } from './publication-dialog'
import { ActionModuleReferencesPanel } from './references-panel'
import { ActionModuleQualityPanel } from './quality-panel'

const emptyContent = (): ModuleContent => ({
  contract: {
    inputs: [],
    outputs: [],
    effectCeiling: 'READ_ONLY',
    preconditions: [],
    postconditions: [],
  },
  implementations: [
    {
      implementationKey: 'default',
      kind: 'structured_steps',
      steps: [],
      outputMapping: {},
    },
  ],
})
const metadata = (m: ActionModuleDetail) => ({
  name: m.name,
  description: m.description ?? '',
  capabilityKey: m.capabilityKey ?? '',
  tags: m.tags.join('、'),
  aliases: m.aliases.join('、'),
  intentExamples: m.intentExamples.join('\n'),
})
const split = (value: string) =>
  value
    .split(/[、,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)

export function ActionModuleDetailPage({ moduleId }: { moduleId: string }) {
  const query = useQuery({
    queryKey: ['action-module', moduleId],
    queryFn: () => fetchActionModule(moduleId),
  })
  if (query.isLoading)
    return (
      <>
        <AppHeader />
        <Main>
          <PageSkeleton />
        </Main>
      </>
    )
  if (!query.data)
    return (
      <>
        <AppHeader />
        <Main>
          <QueryErrorState
            description={query.error?.message}
            onRetry={() => void query.refetch()}
          />
        </Main>
      </>
    )
  return (
    <ActionModuleEditor
      key={moduleId}
      moduleId={moduleId}
      initial={query.data}
    />
  )
}

function ActionModuleEditor({
  moduleId,
  initial,
}: {
  moduleId: string
  initial: ActionModuleDetail
}) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const canWrite = useCan('module:write')
  const canPublish = useCan('module:publish')
  const canExecuteRun = useCan('run:execute')
  const query = useQuery({
    queryKey: ['action-module', moduleId],
    queryFn: () => fetchActionModule(moduleId),
  })
  const target = useQuery({
    queryKey: ['target', query.data?.targetId],
    queryFn: () => fetchTarget(query.data!.targetId),
    enabled: Boolean(query.data?.targetId),
  })
  const versions = useQuery({
    queryKey: ['action-module-versions', moduleId],
    queryFn: () => fetchActionModuleVersions(moduleId),
  })
  const capabilities = useQuery({
    queryKey: ['action-module-capabilities'],
    queryFn: fetchModuleCapabilities,
  })
  const quality = useQuery({
    queryKey: ['action-module-quality', moduleId],
    queryFn: () => fetchActionModuleQuality(moduleId),
  })
  const [base, setBase] = useState<ActionModuleDetail>(initial)
  const [content, setContent] = useState<ModuleContent>(
    () => initial.draftContent ?? emptyContent()
  )
  const [meta, setMeta] = useState(() => metadata(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [remote, setRemote] = useState<ActionModuleDetail | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [confirmed, setConfirmed] = useState<string[]>([])
  const [publishKey, setPublishKey] = useState('')
  const publishButton = useRef<HTMLButtonElement>(null)
  const [version, setVersion] = useState<ActionModuleVersionDto | null>(null)
  const [trialOpen, setTrialOpen] = useState(false)
  const [trialInputs, setTrialInputs] = useState<Record<string, string>>({})
  const [trialAccountId, setTrialAccountId] = useState('')
  const [trialBusy, setTrialBusy] = useState(false)
  const [trialError, setTrialError] = useState('')
  const [tab, setTab] = useState('edit')
  const [publication, setPublication] = useState<{
    version: ActionModuleVersionDto
    status: ModulePublicationStatus
  } | null>(null)
  const adopt = (module: ActionModuleDetail) => {
    setBase(module)
    setContent(module.draftContent ?? emptyContent())
    setMeta(metadata(module))
    setError('')
    setConflict(false)
    setRemote(null)
  }
  const dirty = Boolean(
    base &&
    (canonicalJson(content) !==
      canonicalJson(base.draftContent ?? emptyContent()) ||
      canonicalJson(meta) !== canonicalJson(metadata(base)))
  )
  // 后台重取只更新远端事实；绝不静默覆盖本地编辑或改变其 baseRevision。
  const changedRemote = Boolean(
    base && query.data && base.draftRevision !== query.data.draftRevision
  )
  const types = useMemo(
    () => (capabilities.data ? selectableStudioTypes(capabilities.data) : []),
    [capabilities.data]
  )
  const compile = useMemo(
    () =>
      compileModuleContent(content, { mode: 'save', executableTypes: types }),
    [content, types]
  )
  const release = useMemo(
    () =>
      compileModuleContent(content, {
        mode: 'release',
        executableTypes: types,
      }),
    [content, types]
  )
  const warnings = release.diagnostics.filter((d) => d.severity === 'warning')
  const latest = versions.data?.items[0]
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : '操作失败')
    if (
      e instanceof ApiRequestError &&
      e.payload.code === 'MODULE_DRAFT_CONFLICT'
    )
      setConflict(true)
  }
  const save = async () => {
    if (!base || busy || !canWrite) return
    setBusy(true)
    setError('')
    let current = base
    try {
      const validated = moduleContentSchema.parse(content)
      if (canonicalJson(meta) !== canonicalJson(metadata(base))) {
        current = await updateActionModuleMeta(moduleId, {
          baseRevision: current.draftRevision ?? 0,
          name: meta.name,
          description: meta.description,
          capabilityKey: meta.capabilityKey || null,
          tags: split(meta.tags),
          aliases: split(meta.aliases),
          intentExamples: meta.intentExamples
            .split('\n')
            .map((v) => v.trim())
            .filter(Boolean),
        })
        setBase(current)
      }
      current = await saveActionModuleDraft(moduleId, {
        baseRevision: current.draftRevision ?? 0,
        content: validated,
      })
      client.setQueryData(['action-module', moduleId], current)
      adopt(current)
      void client.invalidateQueries({ queryKey: ['action-modules'] })
      toast.success('草稿保存成功')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  const publish = async () => {
    if (!base || dirty || busy || !release.ok || !canPublish) return
    setBusy(true)
    setError('')
    try {
      await publishActionModule(moduleId, {
        expectedRevision: base.draftRevision ?? 0,
        idempotencyKey: publishKey,
        confirmedWarnings: confirmed,
      })
      setPublishOpen(false)
      // 幂等重试可能返回历史回执，随后读取当前事实，不能用旧回执覆盖较新草稿。
      await Promise.all([
        client.invalidateQueries({ queryKey: ['action-module', moduleId] }),
        client.invalidateQueries({
          queryKey: ['action-module-versions', moduleId],
        }),
        client.invalidateQueries({ queryKey: ['action-modules'] }),
      ])
      toast.success('版本已发布')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }
  if (query.isLoading || (query.data && !base))
    return (
      <>
        <AppHeader />
        <Main>
          <PageSkeleton />
        </Main>
      </>
    )
  if (query.isError || !base)
    return (
      <>
        <AppHeader />
        <Main>
          <QueryErrorState
            description={query.error?.message}
            onRetry={() => query.refetch()}
          />
        </Main>
      </>
    )
  return (
    <>
      <AppHeader />
      <Main className='space-y-6'>
        <Button
          variant='ghost'
          onClick={() => navigate({ to: '/action-modules' })}
        >
          返回动作库
        </Button>
        <PageHeader
          title={base.name}
          description={
            <>
              {target.data?.name ?? base.targetId} · {base.key} · 草稿 r
              {base.draftRevision ?? 0} ·{' '}
              <Badge variant='outline'>
                {MODULE_EXECUTION_MODE_LABELS[compile.executionMode]}
              </Badge>
            </>
          }
          actions={
            <>
              {canWrite && (
                <Button variant='outline' disabled={busy} onClick={save}>
                  {busy ? '处理中…' : '保存草稿'}
                </Button>
              )}
              {canExecuteRun && (
                <Button
                  variant='outline'
                  disabled={busy || trialBusy || !base.draftContent}
                  onClick={() => {
                    setTrialInputs({})
                    setTrialAccountId('')
                    setTrialError('')
                    setTrialOpen(true)
                  }}
                >
                  试跑
                </Button>
              )}
              {canPublish && (
                <Button
                  ref={publishButton}
                  disabled={
                    busy ||
                    dirty ||
                    !base.draftContent ||
                    !capabilities.data ||
                    !versions.data
                  }
                  onClick={() => {
                    setConfirmed([])
                    setPublishKey(crypto.randomUUID())
                    setError('')
                    setPublishOpen(true)
                  }}
                >
                  发布新版本
                </Button>
              )}
            </>
          }
        />
        {dirty && (
          <p role='status' className='text-body text-muted-foreground'>
            有未保存修改，请先保存草稿再发布。
          </p>
        )}
        {!canWrite && (
          <p className='text-body text-muted-foreground'>
            只读查看：当前身份没有模块写权限。
          </p>
        )}
        {error && (
          <p
            role='alert'
            className='rounded-md border border-destructive p-3 text-body text-destructive'
          >
            {error}
          </p>
        )}
        {(conflict || changedRemote) && (
          <div
            role='alert'
            className='space-y-3 rounded-md border p-4 text-body'
          >
            <p>
              远端草稿已更新，本地输入已保留。请比较后选择重新加载或继续整理本地内容。
            </p>
            <Button
              variant='outline'
              onClick={async () => {
                try {
                  setRemote(await fetchActionModule(moduleId))
                } catch (e) {
                  fail(e)
                }
              }}
            >
              加载远端用于比较
            </Button>
            {remote && (
              <>
                <p>远端修订 r{remote.draftRevision}</p>
                <div className='grid min-w-0 gap-3 md:grid-cols-2'>
                  <div>
                    <h3>本地内容</h3>
                    <pre className='text-bodyall max-h-80 overflow-auto break-all whitespace-pre-wrap'>
                      {JSON.stringify({ meta, content }, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <h3>远端内容</h3>
                    <pre className='text-bodyall max-h-80 overflow-auto break-all whitespace-pre-wrap'>
                      {JSON.stringify(
                        {
                          meta: metadata(remote),
                          content: remote.draftContent,
                        },
                        null,
                        2
                      )}
                    </pre>
                  </div>
                </div>
                <Button
                  variant='outline'
                  onClick={() => {
                    client.setQueryData(['action-module', moduleId], remote)
                    adopt(remote)
                  }}
                >
                  放弃本地修改并载入远端
                </Button>
              </>
            )}
          </div>
        )}
        {capabilities.isError && (
          <QueryErrorState
            description={capabilities.error.message}
            onRetry={() => capabilities.refetch()}
          />
        )}
        <Tabs value={tab} onValueChange={setTab} className='gap-4'>
          <TabsList>
            <TabsTrigger value='edit'>编辑</TabsTrigger>
            <TabsTrigger value='references'>引用</TabsTrigger>
            <TabsTrigger value='quality'>运行质量</TabsTrigger>
          </TabsList>
          <TabsContent value='references'>
            <ActionModuleReferencesPanel moduleId={moduleId} />
          </TabsContent>
          <TabsContent value='quality'>
            <ActionModuleQualityPanel moduleId={moduleId} versions={versions.data?.items ?? []} />
          </TabsContent>
          <TabsContent value='edit' className='space-y-6'>
        <fieldset disabled={busy} className='min-w-0 space-y-6'>
          <section className='grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-2'>
            <h2 className='text-section font-semibold sm:col-span-2'>
              业务含义与分类
            </h2>
            <label className='text-bodyall space-y-1'>
              模块名称
              <Input
                aria-label='模块名称'
                value={meta.name}
                disabled={!canWrite}
                onChange={(e) => setMeta({ ...meta, name: e.target.value })}
              />
            </label>
            <label className='text-bodyall space-y-1'>
              能力键
              <Input
                aria-label='能力键'
                value={meta.capabilityKey}
                disabled={!canWrite}
                onChange={(e) =>
                  setMeta({ ...meta, capabilityKey: e.target.value })
                }
              />
            </label>
            <label className='text-bodyall space-y-1 sm:col-span-2'>
              业务说明
              <Textarea
                value={meta.description}
                disabled={!canWrite}
                onChange={(e) =>
                  setMeta({ ...meta, description: e.target.value })
                }
              />
            </label>
            <label className='text-bodyall space-y-1'>
              标签（顿号分隔）
              <Input
                value={meta.tags}
                disabled={!canWrite}
                onChange={(e) => setMeta({ ...meta, tags: e.target.value })}
              />
            </label>
            <label className='text-bodyall space-y-1'>
              别名（顿号分隔）
              <Input
                value={meta.aliases}
                disabled={!canWrite}
                onChange={(e) => setMeta({ ...meta, aliases: e.target.value })}
              />
            </label>
            <label className='text-bodyall space-y-1 sm:col-span-2'>
              意图示例（每行一条）
              <Textarea
                value={meta.intentExamples}
                disabled={!canWrite}
                onChange={(e) =>
                  setMeta({ ...meta, intentExamples: e.target.value })
                }
              />
            </label>
          </section>
          {!version && (
            <ModuleContentEditor
              content={content}
              onChange={setContent}
              disabled={!canWrite || busy}
              types={types}
              diagnostics={compile.diagnostics}
              implementationsQuality={quality.data?.implementations}
            />
          )}
        </fieldset>
        <section className='space-y-2 rounded-xl border bg-card p-4'>
          <h2 className='text-section font-semibold'>编译诊断</h2>
          {!compile.diagnostics.length && (
            <p className='text-body text-muted-foreground'>
              静态编译通过，尚未执行验证。
            </p>
          )}
          {compile.diagnostics.map((d, i) => (
            <p
              key={i}
              className={`text-bodyall break-words ${d.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {d.code} · {d.message} · {d.fieldPath?.join('.')}
            </p>
          ))}
        </section>
        <section className='space-y-3 rounded-xl border bg-card p-4'>
          <h2 className='text-section font-semibold'>版本历史</h2>
          {versions.isError ? (
            <QueryErrorState
              description={versions.error.message}
              onRetry={() => versions.refetch()}
            />
          ) : versions.isLoading ? (
            <p>加载中…</p>
          ) : !versions.data?.items.length ? (
            <p className='text-body text-muted-foreground'>尚未发布版本。</p>
          ) : (
            versions.data.items.map((v) => (
              <div
                key={v.id}
                className='flex flex-wrap items-center justify-between gap-3 border-b py-2 text-body'
              >
                <span>
                  v{v.versionNo} ·{' '}
                  {MODULE_EXECUTION_MODE_LABELS[v.executionMode]} ·{' '}
                  {MODULE_PUBLICATION_STATUS_LABELS[v.publicationStatus]} ·{' '}
                  {new Date(v.createdAt).toLocaleString()}
                </span>
                <span className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => setVersion(v)}
                  >
                    查看 v{v.versionNo} 内容
                  </Button>
                  {canPublish && v.publicationStatus === 'published' ? (
                    <>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setPublication({ version: v, status: 'deprecated' })}
                      >
                        弃用
                      </Button>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setPublication({ version: v, status: 'withdrawn' })}
                      >
                        撤回
                      </Button>
                    </>
                  ) : null}
                  {canPublish && v.publicationStatus === 'deprecated' ? (
                    <>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setPublication({ version: v, status: 'published' })}
                      >
                        恢复
                      </Button>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setPublication({ version: v, status: 'withdrawn' })}
                      >
                        撤回
                      </Button>
                    </>
                  ) : null}
                  {canPublish && v.publicationStatus === 'withdrawn' ? (
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => setPublication({ version: v, status: 'deprecated' })}
                    >
                      恢复
                    </Button>
                  ) : null}
                </span>
              </div>
            ))
          )}
        </section>
          </TabsContent>
        </Tabs>
        {publication ? (
          <ModulePublicationDialog
            open
            onOpenChange={(open) => {
              if (!open) setPublication(null)
            }}
            moduleId={moduleId}
            version={publication.version}
            status={publication.status}
            onDone={async () => {
              setPublication(null)
              toast.success('发布状态已更新')
              await Promise.all([
                client.invalidateQueries({ queryKey: ['action-module-versions', moduleId] }),
                client.invalidateQueries({ queryKey: ['action-module-references', moduleId] }),
                client.invalidateQueries({ queryKey: ['action-modules'] }),
              ])
            }}
          />
        ) : null}
        <Dialog
          open={publishOpen}
          onOpenChange={(open) => {
            if (!busy) setPublishOpen(open)
          }}
        >
          <DialogContent
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              publishButton.current?.focus()
            }}
            className='max-h-[85dvh] overflow-y-auto'
          >
            <DialogHeader>
              <DialogTitle>发布动作模块新版本</DialogTitle>
              <DialogDescription>
                发布已保存的草稿 r{base.draftRevision}，版本内容发布后不可修改。
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-3 text-body'>
              <p>
                {latest
                  ? `与 v${latest.versionNo} 比较：契约${canonicalJson(content.contract) === canonicalJson(latest.content.contract) ? '无变化' : '有变化'}，实现${canonicalJson(content.implementations) === canonicalJson(latest.content.implementations) ? '无变化' : '有变化'}。`
                  : '首次发布。'}
              </p>
              {release.diagnostics
                .filter((d) => d.severity === 'error')
                .map((d, i) => (
                  <p role='alert' key={i} className='text-destructive'>
                    {d.message}
                  </p>
                ))}
              {warnings.map((d) => {
                const key = moduleWarningKey(d)
                return (
                  <label
                    key={key}
                    className='flex items-start gap-3 rounded-md border p-3'
                  >
                    <input
                      type='checkbox'
                      aria-label={`确认警告：${d.message}`}
                      checked={confirmed.includes(key)}
                      disabled={busy}
                      onChange={(e) =>
                        setConfirmed(
                          e.target.checked
                            ? [...confirmed, key]
                            : confirmed.filter((v) => v !== key)
                        )
                      }
                    />
                    <span className='break-words'>{d.message}</span>
                  </label>
                )
              })}
              {error && (
                <p role='alert' className='text-destructive'>
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => setPublishOpen(false)}
              >
                取消
              </Button>
              <Button
                disabled={
                  busy ||
                  dirty ||
                  !release.ok ||
                  warnings.some((d) => !confirmed.includes(moduleWarningKey(d)))
                }
                onClick={publish}
              >
                {busy ? '发布中…' : '确认发布'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={Boolean(version)}
          onOpenChange={(open) => {
            if (!open) setVersion(null)
          }}
        >
          <DialogContent className='max-h-[90dvh] overflow-y-auto sm:max-w-4xl'>
            <DialogHeader>
              <DialogTitle>版本 v{version?.versionNo} · 只读</DialogTitle>
              <DialogDescription className='break-all'>
                内容摘要：{version?.contentDigest}
              </DialogDescription>
            </DialogHeader>
            {version && (
              <ModuleContentEditor
                content={version.content}
                onChange={() => {}}
                disabled
                types={types}
                diagnostics={[]}
                implementationsQuality={quality.data?.implementations}
              />
            )}
          </DialogContent>
        </Dialog>
        <Dialog open={trialOpen} onOpenChange={setTrialOpen}>
          <DialogContent className='sm:max-w-lg'>
            <DialogHeader>
              <DialogTitle>试跑模块草稿</DialogTitle>
              <DialogDescription>
                在隔离验证场景中执行已保存的草稿 r{base.draftRevision}。
              </DialogDescription>
            </DialogHeader>
            <div className='space-y-4 text-body'>
              {dirty && (
                <p className='text-status-warning-foreground'>
                  当前有未保存的修改。试跑基于已保存的草稿，建议先保存草稿。
                </p>
              )}
              {content.contract.inputs.length > 0 ? (
                <div className='space-y-3'>
                  <h4 className='text-small font-medium'>模块输入参数</h4>
                  {content.contract.inputs.map((input) => (
                    <label key={input.key} className='block space-y-1 text-small'>
                      <div className='flex items-center justify-between'>
                        <span>{input.label || input.key} ({input.key})</span>
                        <span className='text-label text-muted-foreground'>
                          {input.valueType} · {input.required ? '必填' : '选填'}
                        </span>
                      </div>
                      <Input
                        placeholder={input.description || `请输入 ${input.label || input.key}`}
                        value={trialInputs[input.key] ?? ''}
                        onChange={(e) =>
                          setTrialInputs({ ...trialInputs, [input.key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className='text-muted-foreground'>该模块无输入参数。</p>
              )}
              {content.implementations.length > 1 ? (
                <label className='block space-y-1 text-small'>
                  <span>试跑实现</span>
                  <select
                    aria-label='试跑实现'
                    className='h-9 w-full rounded-md border border-input bg-background px-2 text-body'
                    value={trialInputs.__implementationKey ?? content.implementations[0]?.implementationKey ?? 'default'}
                    onChange={(e) =>
                      setTrialInputs({ ...trialInputs, __implementationKey: e.target.value })
                    }
                  >
                    {content.implementations.map((item) => (
                      <option key={item.implementationKey} value={item.implementationKey}>
                        {item.implementationKey}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className='block space-y-1 text-small'>
                <span>目标系统账号 ID（可选）</span>
                <Input
                  placeholder='可选 TargetAccount ID'
                  value={trialAccountId}
                  onChange={(e) => setTrialAccountId(e.target.value)}
                />
              </label>
              {trialError && (
                <p role='alert' className='text-destructive text-small'>
                  {trialError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant='outline'
                disabled={trialBusy}
                onClick={() => setTrialOpen(false)}
              >
                取消
              </Button>
              <Button
                disabled={trialBusy}
                onClick={async () => {
                  setTrialBusy(true)
                  setTrialError('')
                  try {
                    const formattedInputs: Record<string, JsonValue> = {}
                    for (const input of content.contract.inputs) {
                      const val = trialInputs[input.key]
                      if (val !== undefined && val !== '') {
                        if (input.valueType === 'number') {
                          const num = Number(val)
                          formattedInputs[input.key] = Number.isNaN(num) ? val : num
                        } else if (input.valueType === 'boolean') {
                          formattedInputs[input.key] = val === 'true' || val === '1'
                        } else if (input.valueType === 'json') {
                          try {
                            formattedInputs[input.key] = JSON.parse(val) as JsonValue
                          } catch {
                            formattedInputs[input.key] = val
                          }
                        } else {
                          formattedInputs[input.key] = val
                        }
                      }
                    }
                    const run = await trialActionModule(moduleId, {
                      inputs: formattedInputs,
                      implementationKey:
                        trialInputs.__implementationKey ||
                        content.implementations[0]?.implementationKey,
                      targetAccountId: trialAccountId.trim() || undefined,
                    })
                    setTrialOpen(false)
                    toast.success('试跑已发起')
                    void navigate({ to: '/runs/$runId', params: { runId: run.id } })
                  } catch (e) {
                    setTrialError(e instanceof Error ? e.message : '发起试跑失败')
                  } finally {
                    setTrialBusy(false)
                  }
                }}
              >
                {trialBusy ? '提交中…' : '开始试跑'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Main>
    </>
  )
}
