import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { compileModuleContent } from '@cairn/authoring'
import {
  canonicalJson,
  moduleContentSchema,
  moduleWarningKey,
  type ActionModuleDetail,
  type ActionModuleVersionDto,
  type JsonValue,
  type ModuleContent,
  type ModulePublicationStatus,
} from '@cairn/shared'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  Download,
  RotateCcw,
  Upload,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import { ImportModuleDialog } from './import-dialog'
import { TrialRunSheet } from './trial-run-sheet'
import { ModuleFixturesPanel, type ModuleTestFixture } from './fixtures-panel'
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
import { cn } from '@/lib/utils'
import { useCan } from '@/hooks/use-permissions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useOptionalSidebar } from '@/components/ui/sidebar'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { selectableStudioTypes } from '@/features/authoring'
import { ModuleContentEditor } from './content-editor'
import {
  MODULE_EXECUTION_MODE_LABELS,
  MODULE_PUBLICATION_STATUS_LABELS,
} from './labels'
import { ModulePublicationDialog } from './publication-dialog'
import { ActionModuleQualityPanel } from './quality-panel'
import { ActionModuleReferencesPanel } from './references-panel'

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
      <Main>
        <PageSkeleton />
      </Main>
    )
  if (!query.data)
    return (
      <Main>
        <QueryErrorState
          description={query.error?.message}
          onRetry={() => void query.refetch()}
        />
      </Main>
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
  const [importOpen, setImportOpen] = useState(false)
  const [trialInputs, setTrialInputs] = useState<Record<string, string>>({})
  const [trialAccountId, setTrialAccountId] = useState('')
  const [trialBusy, setTrialBusy] = useState(false)
  const [trialError, setTrialError] = useState('')
  const [tab, setTab] = useState('edit')
  const trialStorageKey = `cairn:trial-inputs:${moduleId}`

  const openTrialModal = () => {
    try {
      const cached = localStorage.getItem(trialStorageKey)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (typeof parsed === 'object' && parsed !== null) {
          setTrialInputs((prev) => ({ ...parsed, ...prev }))
        }
      }
    } catch {}
    setTrialOpen(true)
  }

  const fillDefaultTrialInputs = () => {
    const defaults: Record<string, string> = {}
    for (const input of content.contract.inputs) {
      if (input.valueType === 'boolean') {
        defaults[input.key] = 'true'
      } else if (input.valueType === 'number') {
        defaults[input.key] = '1'
      } else if (input.valueType === 'json') {
        defaults[input.key] = '{"test": true}'
      } else {
        defaults[input.key] = `test-${input.key}`
      }
    }
    setTrialInputs((prev) => ({ ...prev, ...defaults }))
    toast.success('已填充默认测试入参')
  }

  const clearTrialInputs = () => {
    setTrialInputs({})
    try {
      localStorage.removeItem(trialStorageKey)
    } catch {}
    toast.success('已清空入参')
  }

  const fixturesStorageKey = `cairn:module-fixtures:${moduleId}`
  const loadFixtures = (id: string): ModuleTestFixture[] => {
    try {
      const raw = localStorage.getItem(`cairn:module-fixtures:${id}`)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  const [fixtures, setFixtures] = useState<ModuleTestFixture[]>(() =>
    loadFixtures(moduleId)
  )
  const saveFixtures = (updated: ModuleTestFixture[]) => {
    setFixtures(updated)
    try {
      localStorage.setItem(fixturesStorageKey, JSON.stringify(updated))
    } catch {}
  }

  const [activeTrialRunId, setActiveTrialRunId] = useState<string | null>(null)
  const [trialSheetOpen, setTrialSheetOpen] = useState(false)

  const handleExport = () => {
    const payload = {
      $schema: 'https://cairn.dev/schemas/action-module-v1.json',
      exportedAt: new Date().toISOString(),
      moduleKey: base.key,
      name: meta.name,
      description: meta.description,
      capabilityKey: meta.capabilityKey,
      tags: meta.tags
        ? meta.tags
            .split(/[,，、]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      content,
      fixtures,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${base.key || 'module'}-draft.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success(`已导出模块定义：${base.key || 'module'}-draft.json`)
  }

  const handleImport = (
    importedContent: ModuleContent,
    importedMeta?: {
      name?: string
      description?: string
      capabilityKey?: string
      tags?: string[]
    },
    importedFixtures?: ModuleTestFixture[]
  ) => {
    setContent(importedContent)
    if (importedMeta) {
      setMeta((prev) => ({
        ...prev,
        name: importedMeta.name ?? prev.name,
        description: importedMeta.description ?? prev.description,
        capabilityKey: importedMeta.capabilityKey ?? prev.capabilityKey,
        tags: importedMeta.tags ? importedMeta.tags.join('、') : prev.tags,
      }))
    }
    if (importedFixtures && Array.isArray(importedFixtures)) {
      saveFixtures(importedFixtures)
    }
    toast.success('已导入模块定义，请核对草稿并保存')
  }
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
  const [advancedMetaOpen, setAdvancedMetaOpen] = useState(false)
  const sidebar = useOptionalSidebar()
  const sidebarOffset =
    !sidebar || sidebar.isMobile
      ? 'left-0'
      : sidebar.state === 'collapsed'
        ? 'left-0 md:left-[72px]'
        : 'left-0 md:left-[224px]'
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
  const errors = release.diagnostics.filter((d) => d.severity === 'error')
  const [diagnosticsDrawerOpen, setDiagnosticsDrawerOpen] = useState(false)
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
      <Main>
        <PageSkeleton />
      </Main>
    )
  if (query.isError || !base)
    return (
      <Main>
        <QueryErrorState
          description={query.error?.message}
          onRetry={() => query.refetch()}
        />
      </Main>
    )
  return (
    <Main className='space-y-6'>
      <PageHeader
        parent={
          <Link
            to='/action-modules'
            className='inline-flex items-center gap-1.5 hover:text-link'
          >
            <ArrowLeft className='size-4' />
            返回动作库
          </Link>
        }
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
            <Button
              variant='outline'
              size='sm'
              className='h-8 gap-1.5 text-label'
              title='导出当前模块定义为 JSON 文件'
              onClick={handleExport}
            >
              <Download className='size-3.5' />
              导出
            </Button>
            {canWrite && (
              <Button
                variant='outline'
                size='sm'
                className='h-8 gap-1.5 text-label'
                title='从 JSON 导入覆盖草稿'
                onClick={() => setImportOpen(true)}
              >
                <Upload className='size-3.5' />
                导入
              </Button>
            )}
            {canWrite && (
              <Button
                variant={dirty ? 'default' : 'outline'}
                disabled={busy}
                onClick={save}
              >
                {busy ? '处理中…' : '保存草稿'}
              </Button>
            )}
            {canExecuteRun && (
              <Button
                variant='outline'
                disabled={busy || trialBusy || !base.draftContent}
                onClick={() => {
                  setTrialAccountId('')
                  setTrialError('')
                  openTrialModal()
                }}
              >
                试跑
              </Button>
            )}
            {canPublish && (
              <Button
                ref={publishButton}
                variant={!dirty && release.ok ? 'default' : 'outline'}
                disabled={
                  busy ||
                  dirty ||
                  !base.draftContent ||
                  !capabilities.data ||
                  !versions.data ||
                  !release.ok
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
        <div
          role='status'
          className='flex items-center gap-2 rounded-lg border border-status-warning-accent/30 bg-status-warning-background px-4 py-2.5 text-body text-status-warning-foreground'
        >
          <AlertTriangle className='size-4 shrink-0 text-status-warning-foreground' />
          <span>有未保存修改，请先保存草稿再发布。</span>
        </div>
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
        <div role='alert' className='space-y-3 rounded-md border p-4 text-body'>
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
                  <pre className='max-h-80 overflow-auto text-body break-all whitespace-pre-wrap'>
                    {JSON.stringify({ meta, content }, null, 2)}
                  </pre>
                </div>
                <div>
                  <h3>远端内容</h3>
                  <pre className='max-h-80 overflow-auto text-body break-all whitespace-pre-wrap'>
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
          <TabsTrigger value='fixtures'>
            测试用例 {fixtures.length > 0 ? `(${fixtures.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value='references'>引用</TabsTrigger>
          <TabsTrigger value='quality'>运行质量</TabsTrigger>
        </TabsList>
        <TabsContent value='fixtures'>
          <ModuleFixturesPanel
            moduleId={moduleId}
            fixtures={fixtures}
            onUpdateFixtures={saveFixtures}
            contractInputs={content.contract.inputs}
            canWrite={canWrite}
            onRunFixture={async (fixture) => {
              const newInputs: Record<string, string> = {}
              for (const [k, v] of Object.entries(fixture.inputs)) {
                newInputs[k] =
                  typeof v === 'object' && v !== null
                    ? JSON.stringify(v)
                    : String(v)
              }
              setTrialInputs(newInputs)
              setBusy(true)
              try {
                const run = await trialActionModule(moduleId, {
                  inputs: fixture.inputs,
                  implementationKey:
                    fixture.implementationKey ||
                    content.implementations[0]?.implementationKey,
                  targetAccountId:
                    fixture.targetAccountId ||
                    trialAccountId.trim() ||
                    undefined,
                })
                setActiveTrialRunId(run.id)
                setTrialSheetOpen(true)
                toast.success(`已发起测试用例「${fixture.name}」试跑`)
              } catch (e) {
                toast.error(e instanceof Error ? e.message : '运行测试用例失败')
              } finally {
                setBusy(false)
              }
            }}
          />
        </TabsContent>
        <TabsContent value='references'>
          <ActionModuleReferencesPanel moduleId={moduleId} />
        </TabsContent>
        <TabsContent value='quality'>
          <ActionModuleQualityPanel
            moduleId={moduleId}
            versions={versions.data?.items ?? []}
          />
        </TabsContent>
        <TabsContent value='edit' className='space-y-6 pb-28'>
          <fieldset disabled={busy} className='min-w-0'>
            {!version && (
              <ModuleContentEditor
                content={content}
                onChange={setContent}
                disabled={!canWrite || busy}
                types={types}
                diagnostics={compile.diagnostics}
                implementationsQuality={quality.data?.implementations}
                metaSlot={
                  <div className='space-y-6'>
                    <section className='space-y-4 rounded-xl border bg-card p-4'>
                      <div className='flex items-center justify-between gap-2'>
                        <h2 className='text-section font-semibold'>基础定义</h2>
                      </div>
                      <div className='space-y-4'>
                        <label className='block space-y-1 text-body'>
                          <span className='flex items-center gap-1 font-medium'>
                            模块名称{' '}
                            <span
                              className='text-destructive'
                              aria-hidden='true'
                            >
                              *
                            </span>
                          </span>
                          <Input
                            aria-label='模块名称'
                            placeholder='例如：商品下架'
                            value={meta.name}
                            disabled={!canWrite}
                            onChange={(e) =>
                              setMeta({ ...meta, name: e.target.value })
                            }
                          />
                        </label>
                        <label className='block space-y-1 text-body'>
                          <span className='flex items-center gap-1 font-medium'>
                            能力键{' '}
                            <span className='text-label font-normal text-muted-foreground'>
                              (可选)
                            </span>
                          </span>
                          <Input
                            aria-label='能力键'
                            placeholder='例如：product.offshelf'
                            value={meta.capabilityKey}
                            disabled={!canWrite}
                            onChange={(e) =>
                              setMeta({
                                ...meta,
                                capabilityKey: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label className='block space-y-1 text-body'>
                          <span className='flex items-center gap-1 font-medium'>
                            业务说明{' '}
                            <span className='text-label font-normal text-muted-foreground'>
                              (可选)
                            </span>
                          </span>
                          <Textarea
                            placeholder='描述模块的功能、调用契约与适用场景'
                            rows={2}
                            value={meta.description}
                            disabled={!canWrite}
                            onChange={(e) =>
                              setMeta({ ...meta, description: e.target.value })
                            }
                          />
                        </label>
                      </div>
                    </section>

                    <Collapsible
                      open={advancedMetaOpen}
                      onOpenChange={setAdvancedMetaOpen}
                      className='space-y-3 rounded-xl border bg-card p-4'
                    >
                      <div className='flex items-center justify-between gap-2'>
                        <div className='min-w-0'>
                          <h3 className='flex items-center gap-1.5 text-body font-semibold'>
                            检索与语料配置
                            <span className='text-label font-normal text-muted-foreground'>
                              (可选)
                            </span>
                          </h3>
                          <p className='truncate text-label text-muted-foreground'>
                            标签过滤、自然语言同义词与意图识别语料
                          </p>
                        </div>
                        <CollapsibleTrigger asChild>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='gap-1 text-label'
                          >
                            {advancedMetaOpen ? '收起' : '展开'}
                            <ChevronDown
                              className={cn(
                                'size-4 transition-transform duration-200',
                                advancedMetaOpen && 'rotate-180'
                              )}
                            />
                          </Button>
                        </CollapsibleTrigger>
                      </div>
                      <CollapsibleContent className='space-y-4 border-t border-border-divider pt-2'>
                        <label className='block space-y-1 text-body'>
                          <span className='flex items-center gap-1 font-medium'>
                            标签{' '}
                            <span className='text-label font-normal text-muted-foreground'>
                              (可选，顿号分隔)
                            </span>
                          </span>
                          <Input
                            placeholder='例如：商品、库存、下架'
                            value={meta.tags}
                            disabled={!canWrite}
                            onChange={(e) =>
                              setMeta({ ...meta, tags: e.target.value })
                            }
                          />
                        </label>
                        <label className='block space-y-1 text-body'>
                          <span className='flex items-center gap-1 font-medium'>
                            别名{' '}
                            <span className='text-label font-normal text-muted-foreground'>
                              (可选，顿号分隔)
                            </span>
                          </span>
                          <Input
                            placeholder='例如：下架商品、下架'
                            value={meta.aliases}
                            disabled={!canWrite}
                            onChange={(e) =>
                              setMeta({ ...meta, aliases: e.target.value })
                            }
                          />
                        </label>
                        <label className='block space-y-1 text-body'>
                          <span className='flex items-center gap-1 font-medium'>
                            意图示例{' '}
                            <span className='text-label font-normal text-muted-foreground'>
                              (可选，每行一条)
                            </span>
                          </span>
                          <Textarea
                            placeholder='例如：帮我把这个商品下架'
                            rows={3}
                            value={meta.intentExamples}
                            disabled={!canWrite}
                            onChange={(e) =>
                              setMeta({
                                ...meta,
                                intentExamples: e.target.value,
                              })
                            }
                          />
                          <p className='mt-1 text-label text-muted-foreground'>
                            供自然语言推荐和 AI 场景编写时识别该模块使用的样本。
                          </p>
                        </label>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                }
                rightBottomSlot={
                  <>
                    <section className='space-y-2 rounded-xl border bg-card p-4'>
                      <div className='flex items-center justify-between'>
                        <h2 className='text-section font-semibold'>编译诊断</h2>
                        {!compile.diagnostics.length ? (
                          <Badge
                            variant='outline'
                            className='border-status-success/30 text-status-success gap-1'
                          >
                            <CheckCircle2 className='size-3' />
                            编译通过
                          </Badge>
                        ) : compile.diagnostics.some(
                            (d) => d.severity === 'error'
                          ) ? (
                          <Badge
                            variant='outline'
                            className='gap-1 border-destructive/30 text-destructive'
                          >
                            <AlertTriangle className='size-3' />
                            存在错误
                          </Badge>
                        ) : (
                          <Badge
                            variant='outline'
                            className='gap-1 border-status-warning-accent/30 bg-status-warning-background text-status-warning-foreground'
                          >
                            <AlertTriangle className='size-3' />
                            存在警告
                          </Badge>
                        )}
                      </div>
                      {!compile.diagnostics.length && (
                        <p className='text-body text-muted-foreground'>
                          静态编译通过，尚未执行验证。
                        </p>
                      )}
                      {compile.diagnostics.map((d, i) => (
                        <p
                          key={i}
                          className={`text-body break-words ${d.severity === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
                        >
                          {d.code} · {d.message} · {d.fieldPath?.join('.')}
                        </p>
                      ))}
                    </section>
                    <section className='space-y-3 rounded-xl border bg-card p-4'>
                      <div className='flex items-center justify-between'>
                        <h2 className='text-section font-semibold'>版本历史</h2>
                        {versions.data?.items.length ? (
                          <span className='text-label text-muted-foreground'>
                            共 {versions.data.items.length} 个版本
                          </span>
                        ) : null}
                      </div>
                      {versions.isError ? (
                        <QueryErrorState
                          description={versions.error.message}
                          onRetry={() => versions.refetch()}
                        />
                      ) : versions.isLoading ? (
                        <p className='text-body text-muted-foreground'>
                          加载中…
                        </p>
                      ) : !versions.data?.items.length ? (
                        <p className='text-body text-muted-foreground'>
                          尚未发布版本。
                        </p>
                      ) : (
                        <div className='divide-y rounded-lg border'>
                          {versions.data.items.map((v) => (
                            <div
                              key={v.id}
                              className='flex flex-wrap items-center justify-between gap-3 p-3 text-body hover:bg-muted/30'
                            >
                              <div className='flex flex-wrap items-center gap-2'>
                                <span className='font-mono font-medium'>
                                  v{v.versionNo}
                                </span>
                                <Badge variant='outline' className='text-label'>
                                  {
                                    MODULE_EXECUTION_MODE_LABELS[
                                      v.executionMode
                                    ]
                                  }
                                </Badge>
                                <Badge
                                  variant={
                                    v.publicationStatus === 'published'
                                      ? 'secondary'
                                      : 'outline'
                                  }
                                  className='text-label'
                                >
                                  {
                                    MODULE_PUBLICATION_STATUS_LABELS[
                                      v.publicationStatus
                                    ]
                                  }
                                </Badge>
                                <span className='text-label text-muted-foreground'>
                                  {new Date(v.createdAt).toLocaleString()}
                                </span>
                              </div>
                              <div className='flex flex-wrap gap-2'>
                                <Button
                                  variant='outline'
                                  size='sm'
                                  onClick={() => setVersion(v)}
                                >
                                  查看 v{v.versionNo} 内容
                                </Button>
                                {canPublish &&
                                v.publicationStatus === 'published' ? (
                                  <>
                                    <Button
                                      variant='outline'
                                      size='sm'
                                      onClick={() =>
                                        setPublication({
                                          version: v,
                                          status: 'deprecated',
                                        })
                                      }
                                    >
                                      弃用
                                    </Button>
                                    <Button
                                      variant='outline'
                                      size='sm'
                                      onClick={() =>
                                        setPublication({
                                          version: v,
                                          status: 'withdrawn',
                                        })
                                      }
                                    >
                                      撤回
                                    </Button>
                                  </>
                                ) : null}
                                {canPublish &&
                                v.publicationStatus === 'deprecated' ? (
                                  <>
                                    <Button
                                      variant='outline'
                                      size='sm'
                                      onClick={() =>
                                        setPublication({
                                          version: v,
                                          status: 'published',
                                        })
                                      }
                                    >
                                      恢复
                                    </Button>
                                    <Button
                                      variant='outline'
                                      size='sm'
                                      onClick={() =>
                                        setPublication({
                                          version: v,
                                          status: 'withdrawn',
                                        })
                                      }
                                    >
                                      撤回
                                    </Button>
                                  </>
                                ) : null}
                                {canPublish &&
                                v.publicationStatus === 'withdrawn' ? (
                                  <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() =>
                                      setPublication({
                                        version: v,
                                        status: 'deprecated',
                                      })
                                    }
                                  >
                                    恢复
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>
                  </>
                }
              />
            )}
          </fieldset>
          {tab === 'edit' && (
            <div
              data-slot='module-diagnostics-bar'
              data-testid='module-diagnostics-bar'
              className={cn(
                'fixed bottom-4 right-0 z-20 pointer-events-none px-4 md:px-6 xl:px-8 transition-[left] duration-200 ease-linear',
                sidebarOffset
              )}
            >
              <div className='pointer-events-auto mx-auto max-w-5xl rounded-xl border border-card bg-card/95 p-3 shadow-popover backdrop-blur'>
                <div className='flex items-center justify-between gap-3'>
                  <div className='flex min-w-0 flex-1 items-center gap-2'>
                    {errors.length > 0 ? (
                      <Badge
                        variant='outline'
                        className='gap-1 border-destructive/30 bg-destructive/10 text-destructive shrink-0'
                      >
                        <AlertTriangle className='size-3.5' />
                        {errors.length} 项编译错误
                      </Badge>
                    ) : warnings.length > 0 ? (
                      <Badge
                        variant='outline'
                        className='gap-1 border-status-warning-accent/30 bg-status-warning-background text-status-warning-foreground shrink-0'
                      >
                        <AlertTriangle className='size-3.5' />
                        {warnings.length} 项警告
                      </Badge>
                    ) : (
                      <Badge
                        variant='outline'
                        className='gap-1 border-status-success/30 bg-status-success-background text-status-success shrink-0'
                      >
                        <CheckCircle2 className='size-3.5' />
                        静态编译通过
                      </Badge>
                    )}
                    <span className='truncate text-small text-muted-foreground'>
                      {errors[0]
                        ? `${errors[0].code} · ${errors[0].message}`
                        : warnings[0]
                          ? `${warnings[0].code} · ${warnings[0].message}`
                          : '契约与实现校验正常，可以保存草稿或发布。'}
                    </span>
                  </div>
                  {release.diagnostics.length > 0 && (
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 gap-1 text-small shrink-0'
                      onClick={() => setDiagnosticsDrawerOpen((prev) => !prev)}
                    >
                      {diagnosticsDrawerOpen ? '收起详情' : '展开详情'}
                      <ChevronDown
                        className={cn(
                          'size-3.5 transition-transform duration-200',
                          diagnosticsDrawerOpen && 'rotate-180'
                        )}
                      />
                    </Button>
                  )}
                </div>
                {diagnosticsDrawerOpen && release.diagnostics.length > 0 && (
                  <div className='mt-2.5 max-h-48 space-y-1.5 overflow-y-auto border-t border-border-divider pt-2 text-small'>
                    {release.diagnostics.map((d, i) => (
                      <div
                        key={i}
                        className={cn(
                          'flex items-start gap-2 rounded p-1.5',
                          d.severity === 'error'
                            ? 'bg-destructive/10 text-destructive'
                            : 'bg-muted/40 text-muted-foreground'
                        )}
                      >
                        <span className='font-mono font-medium'>{d.code}</span>
                        <span>·</span>
                        <span className='flex-1'>{d.message}</span>
                        {d.fieldPath && (
                          <span className='font-mono text-label opacity-80'>
                            {d.fieldPath.join('.')}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
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
              client.invalidateQueries({
                queryKey: ['action-module-versions', moduleId],
              }),
              client.invalidateQueries({
                queryKey: ['action-module-references', moduleId],
              }),
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
                <div className='flex items-center justify-between'>
                  <h4 className='text-small font-medium'>模块输入参数</h4>
                  <div className='flex items-center gap-1.5'>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      className='h-6 gap-1 px-2 text-label text-muted-foreground hover:text-foreground'
                      onClick={fillDefaultTrialInputs}
                    >
                      <Wand2 className='size-3 text-primary' />
                      填充示例
                    </Button>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      className='h-6 gap-1 px-2 text-label text-muted-foreground hover:text-destructive'
                      onClick={clearTrialInputs}
                    >
                      <RotateCcw className='size-3' />
                      清空
                    </Button>
                  </div>
                </div>
                {content.contract.inputs.map((input) => (
                  <label key={input.key} className='block space-y-1 text-small'>
                    <div className='flex items-center justify-between'>
                      <span>
                        {input.label || input.key} ({input.key})
                      </span>
                      <span className='text-label text-muted-foreground'>
                        {input.valueType} · {input.required ? '必填' : '选填'}
                      </span>
                    </div>
                    {input.valueType === 'boolean' ? (
                      <Select
                        value={trialInputs[input.key] ?? ''}
                        onValueChange={(val) =>
                          setTrialInputs({
                            ...trialInputs,
                            [input.key]: val === '__none__' ? '' : val,
                          })
                        }
                      >
                        <SelectTrigger
                          className='w-full'
                          aria-label={input.label || input.key}
                        >
                          <SelectValue
                            placeholder={
                              input.required ? '请选择布尔值' : '未指定 (可选)'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {!input.required && (
                            <SelectItem value='__none__'>未指定</SelectItem>
                          )}
                          <SelectItem value='true'>true (是)</SelectItem>
                          <SelectItem value='false'>false (否)</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : input.valueType === 'json' ? (
                      <Textarea
                        className='font-mono text-small'
                        rows={3}
                        placeholder={
                          input.description ||
                          '例如：{"id": 123, "status": "active"}'
                        }
                        value={trialInputs[input.key] ?? ''}
                        onChange={(e) =>
                          setTrialInputs({
                            ...trialInputs,
                            [input.key]: e.target.value,
                          })
                        }
                      />
                    ) : (
                      <Input
                        type={input.valueType === 'number' ? 'number' : 'text'}
                        placeholder={
                          input.description ||
                          `请输入 ${input.label || input.key}`
                        }
                        value={trialInputs[input.key] ?? ''}
                        onChange={(e) =>
                          setTrialInputs({
                            ...trialInputs,
                            [input.key]: e.target.value,
                          })
                        }
                      />
                    )}
                  </label>
                ))}
              </div>
            ) : (
              <p className='text-muted-foreground'>该模块无输入参数。</p>
            )}
            {content.implementations.length > 1 ? (
              <label className='block space-y-1 text-small'>
                <span>试跑实现</span>
                <Select
                  value={
                    trialInputs.__implementationKey ??
                    content.implementations[0]?.implementationKey ??
                    'default'
                  }
                  onValueChange={(val) =>
                    setTrialInputs({ ...trialInputs, __implementationKey: val })
                  }
                >
                  <SelectTrigger className='w-full' aria-label='试跑实现'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {content.implementations.map((item) => (
                      <SelectItem
                        key={item.implementationKey}
                        value={item.implementationKey}
                      >
                        {item.implementationKey}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <p role='alert' className='text-small text-destructive'>
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
                        formattedInputs[input.key] = Number.isNaN(num)
                          ? val
                          : num
                      } else if (input.valueType === 'boolean') {
                        formattedInputs[input.key] =
                          val === 'true' || val === '1'
                      } else if (input.valueType === 'json') {
                        try {
                          formattedInputs[input.key] = JSON.parse(
                            val
                          ) as JsonValue
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
                  try {
                    localStorage.setItem(
                      trialStorageKey,
                      JSON.stringify(trialInputs)
                    )
                  } catch {}
                  setTrialOpen(false)
                  setActiveTrialRunId(run.id)
                  setTrialSheetOpen(true)
                  toast.success('已发起试跑，原地观测中…')
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
      <ImportModuleDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={handleImport}
      />
      <TrialRunSheet
        runId={activeTrialRunId}
        open={trialSheetOpen}
        onOpenChange={setTrialSheetOpen}
        currentInputs={trialInputs}
        onSaveAsFixture={(name, inputs, lastRun) => {
          const parsedInputs: Record<string, JsonValue> = {}
          for (const [k, v] of Object.entries(inputs)) {
            if (v !== '') {
              const contractInput = content.contract.inputs.find(
                (i) => i.key === k
              )
              if (contractInput?.valueType === 'number') {
                const num = Number(v)
                parsedInputs[k] = Number.isNaN(num) ? v : num
              } else if (contractInput?.valueType === 'boolean') {
                parsedInputs[k] = v === 'true' || v === '1'
              } else if (contractInput?.valueType === 'json') {
                try {
                  parsedInputs[k] = JSON.parse(v) as JsonValue
                } catch {
                  parsedInputs[k] = v
                }
              } else {
                parsedInputs[k] = v
              }
            }
          }
          const newFixture: ModuleTestFixture = {
            id: crypto.randomUUID(),
            name,
            inputs: parsedInputs,
            lastRun,
          }
          saveFixtures([...fixtures, newFixture])
          toast.success(`已将当前入参沉淀为测试用例「${name}」`)
        }}
      />
    </Main>
  )
}
