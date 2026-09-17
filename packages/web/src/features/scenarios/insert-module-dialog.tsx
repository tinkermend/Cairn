import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { suggestionToBinding } from '@cairn/authoring'
import {
  type ActionModuleSummary,
  type ActionModuleVersionDto,
  type ModuleInputBinding,
  type ModuleInputSuggestion,
  type ModuleResolveCandidate,
  type ModuleResolveResult,
  type ScenarioDetailDto,
} from '@cairn/shared'
import { Layers, Search } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiRequestError } from '@/lib/api-client'
import {
  closeModuleResolution,
  fetchActionModules,
  fetchActionModuleVersion,
  fetchActionModuleVersions,
  resolveActionModules,
} from '@/lib/action-modules-api'
import { acceptModuleResolution } from '@/lib/scenarios-api'
import { ModuleHealthBadge } from '@/features/action-modules/health-badge'
import {
  MODULE_EFFECT_CEILING_LABELS,
  MODULE_EXECUTION_MODE_LABELS,
} from '@/features/action-modules/labels'

type InsertTab = 'resolve' | 'catalog'

type InsertModuleDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  targetId: string
  scenarioId: string
  draftRevision: number
  anchorNodeId?: string
  onEnsureSaved?: () => Promise<number | null>
  onSelect: (module: ActionModuleSummary, version: ActionModuleVersionDto) => void
  onAccepted: (scenario: ScenarioDetailDto) => void
  onInsertAiStep: () => void
}

function newKey(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

function matchReason(candidate: ModuleResolveCandidate) {
  return candidate.matchedBy.map((item) => `${fieldLabel(item.field)}「${item.text}」`).join('、')
}

function fieldLabel(field: ModuleResolveCandidate['matchedBy'][number]['field']) {
  switch (field) {
    case 'name':
      return '名称'
    case 'key':
      return 'key'
    case 'alias':
      return '别名'
    case 'intentExample':
      return '意图示例'
    case 'capabilityKey':
      return '能力键'
    case 'tag':
      return '标签'
    case 'term':
      return '术语'
  }
}

function suggestionHint(suggestion: ModuleInputSuggestion | undefined, expression: string) {
  if (!suggestion) return null
  if (suggestion.kind === 'literal') {
    const excerpt = expression.slice(suggestion.span[0], suggestion.span[1])
    return `规则建议字面量，原文 ${suggestion.span[0]}–${suggestion.span[1]}「${excerpt}」`
  }
  if (suggestion.kind === 'from') return `规则建议引用上下文「${suggestion.key}」`
  return '未抽取到建议，必填项需手工补全，仍可接受'
}

export function InsertModuleDialog({
  open,
  onOpenChange,
  targetId,
  scenarioId,
  draftRevision,
  anchorNodeId,
  onEnsureSaved,
  onSelect,
  onAccepted,
  onInsertAiStep,
}: InsertModuleDialogProps) {
  const [tab, setTab] = useState<InsertTab>('resolve')
  const [search, setSearch] = useState('')
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [confirmDeprecated, setConfirmDeprecated] = useState(false)
  const [expression, setExpression] = useState('')
  const [resolving, setResolving] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [result, setResult] = useState<ModuleResolveResult | null>(null)
  const [resolveVersionId, setResolveVersionId] = useState<string | null>(null)
  const [bindings, setBindings] = useState<Record<string, ModuleInputBinding>>({})
  const pendingRequestId = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTab('resolve')
    setSearch('')
    setSelectedModuleId(null)
    setSelectedVersionId(null)
    setConfirmDeprecated(false)
    setExpression('')
    setResolving(false)
    setAccepting(false)
    setResolveError('')
    setResult(null)
    setResolveVersionId(null)
    setBindings({})
  }, [open])

  const catalogQuery = search.trim()
  const modulesQuery = useQuery({
    queryKey: ['action-modules', { targetId, q: catalogQuery }],
    queryFn: () =>
      fetchActionModules({
        targetId,
        q: catalogQuery || undefined,
        pageSize: 100,
      }),
    enabled: open,
  })

  const versionsQuery = useQuery({
    queryKey: ['action-module-versions', selectedModuleId],
    queryFn: () => fetchActionModuleVersions(selectedModuleId!),
    enabled: Boolean(open && tab === 'catalog' && selectedModuleId),
  })

  const selectedCandidate = useMemo(
    () => result?.candidates.find((item) => item.moduleVersionId === resolveVersionId) ?? null,
    [result, resolveVersionId],
  )

  const versionQuery = useQuery({
    queryKey: ['action-module-version', selectedCandidate?.moduleId, selectedCandidate?.moduleVersionId],
    queryFn: () => fetchActionModuleVersion(selectedCandidate!.moduleId, selectedCandidate!.moduleVersionId),
    enabled: Boolean(open && selectedCandidate),
  })

  const filteredModules = useMemo(() => {
    return (modulesQuery.data?.items ?? []).filter(
      (m) => m.publicationStatus !== 'withdrawn' && Boolean(m.latestVersionNo),
    )
  }, [modulesQuery.data?.items])
  const healthByModuleId = useMemo(() => {
    return new Map((modulesQuery.data?.items ?? []).map((item) => [item.id, item.health]))
  }, [modulesQuery.data?.items])

  const selectedModule = useMemo(() => {
    return (modulesQuery.data?.items ?? []).find((m) => m.id === selectedModuleId) ?? null
  }, [modulesQuery.data?.items, selectedModuleId])

  const versions = versionsQuery.data?.items ?? []
  const publishedVersions = useMemo(() => {
    return versions.filter((v) => v.publicationStatus !== 'withdrawn')
  }, [versions])

  const selectedVersion = useMemo(() => {
    if (selectedVersionId) {
      return publishedVersions.find((v) => v.id === selectedVersionId) ?? null
    }
    return publishedVersions[0] ?? null
  }, [publishedVersions, selectedVersionId])

  function abandonPending() {
    const requestId = pendingRequestId.current
    pendingRequestId.current = null
    if (!requestId) return
    void closeModuleResolution(requestId, { outcome: 'abandoned' }).catch(() => undefined)
  }

  function handleOpenChange(next: boolean) {
    if (!next) abandonPending()
    onOpenChange(next)
  }

  function selectCandidate(candidate: ModuleResolveCandidate, resolved: ModuleResolveResult) {
    setResolveVersionId(candidate.moduleVersionId)
    setConfirmDeprecated(false)
    const next: Record<string, ModuleInputBinding> = {}
    const suggestions = resolved.inputSuggestions[candidate.moduleVersionId] ?? {}
    for (const [key, suggestion] of Object.entries(suggestions)) {
      const binding = suggestionToBinding(suggestion)
      if (binding) next[key] = binding
    }
    setBindings(next)
  }

  async function handleResolve() {
    const text = expression.trim()
    if (!text || resolving) return
    setResolving(true)
    setResolveError('')
    abandonPending()
    try {
      const next = await resolveActionModules({
        targetId,
        scenarioId,
        draftRevision,
        anchorNodeId,
        expression: text,
        mode: 'rules_then_ai',
        idempotencyKey: newKey('resolve'),
      })
      pendingRequestId.current = next.outcome === 'pending' ? next.requestId : null
      setResult(next)
      if (next.status === 'matched' && next.candidates[0]) {
        selectCandidate(next.candidates[0], next)
      } else {
        setResolveVersionId(null)
        setBindings({})
        setConfirmDeprecated(false)
      }
    } catch (error) {
      setResolveError(error instanceof ApiRequestError ? error.message : '查找失败')
    } finally {
      setResolving(false)
    }
  }

  async function handleAccept() {
    if (!result || !selectedCandidate || accepting) return
    setAccepting(true)
    setResolveError('')
    try {
      const revision = onEnsureSaved ? await onEnsureSaved() : draftRevision
      if (revision == null) {
        setResolveError('请先保存或修正草稿后再写入。')
        return
      }
      const accepted = await acceptModuleResolution(scenarioId, result.requestId, {
        moduleVersionId: selectedCandidate.moduleVersionId,
        inputBindings: bindings,
        outputBindings: {},
        anchorNodeId,
        baseRevision: revision,
        idempotencyKey: newKey('accept'),
      })
      pendingRequestId.current = null
      onAccepted(accepted.scenario)
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        setResolveError('草稿已被他人更新，候选仍保留，请重新载入后再接受。')
      } else if (error instanceof ApiRequestError && error.payload.code === 'RESOLUTION_CANDIDATE_UNAVAILABLE') {
        setResolveError('候选版本已被撤回，请重新查找。')
      } else {
        setResolveError(error instanceof ApiRequestError ? error.message : '写入草稿失败')
      }
    } finally {
      setAccepting(false)
    }
  }

  const handleCatalogConfirm = () => {
    if (selectedModule && selectedVersion) {
      onSelect(selectedModule, selectedVersion)
      handleOpenChange(false)
    }
  }

  const catalogDisabled =
    !selectedModule ||
    !selectedVersion ||
    (selectedVersion.publicationStatus === 'deprecated' && !confirmDeprecated)

  const resolveDisabled =
    !selectedCandidate ||
    accepting ||
    (selectedCandidate.notes.includes('deprecated') && !confirmDeprecated)

  const contractInputs = versionQuery.data?.content.contract.inputs ?? []
  const suggestionMap = selectedCandidate
    ? (result?.inputSuggestions[selectedCandidate.moduleVersionId] ?? {})
    : {}
  const inputKeys = contractInputs.length > 0 ? contractInputs.map((item) => item.key) : Object.keys(suggestionMap)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl'>
        <DialogHeader className='shrink-0'>
          <DialogTitle className='flex items-center gap-2'>
            <Layers className='size-5 text-primary' />
            插入动作模块
          </DialogTitle>
          <DialogDescription>
            用业务说法查找当前目标系统的模块，或继续从库中手工选择。确认后才写入草稿。
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as InsertTab)}
          className='flex min-h-0 flex-1 flex-col overflow-hidden'
        >
          <TabsList className='shrink-0'>
            <TabsTrigger value='resolve'>按说法查找</TabsTrigger>
            <TabsTrigger value='catalog'>从库中选择</TabsTrigger>
          </TabsList>

          <TabsContent value='resolve' className='min-h-0 flex-1 overflow-y-auto'>
            <div className='space-y-3 pb-2'>
              <div className='flex flex-col gap-2 sm:flex-row'>
                <Input
                  aria-label='业务说法'
                  placeholder='例如：把商品 10086 下架'
                  value={expression}
                  onChange={(event) => setExpression(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void handleResolve()
                    }
                  }}
                />
                <Button type='button' loading={resolving} disabled={!expression.trim()} onClick={() => void handleResolve()}>
                  查找
                </Button>
              </div>
              {result?.aiSkipped === 'ai_layer_not_open' ? (
                <Alert>
                  <AlertDescription>AI 层未开放，已按规则层结果展示。</AlertDescription>
                </Alert>
              ) : null}
              {resolveError ? (
                <p role='alert' className='text-small text-destructive'>
                  {resolveError}
                </p>
              ) : null}
              {result?.status === 'no_match' ? (
                <div className='space-y-3 rounded-md border border-border-card p-3'>
                  <p className='text-body'>没有找到可插入的模块。不会自动试跑，也不会触发探索。</p>
                  <div className='flex flex-col gap-2 sm:flex-row'>
                    <Button asChild variant='outline'>
                      <a href='/action-modules/'>新建模块草稿</a>
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      onClick={() => {
                        onInsertAiStep()
                        handleOpenChange(false)
                      }}
                    >
                      插入 AI Step 草稿
                    </Button>
                    <Button type='button' variant='outline' onClick={() => setTab('catalog')}>
                      手工编写（从库中选择）
                    </Button>
                  </div>
                </div>
              ) : null}
              {result && result.status !== 'no_match' ? (
                <div className='space-y-3'>
                  {result.status === 'matched' ? (
                    <p className='text-small text-muted-foreground'>已预选最确定的模块，确认后才写入草稿。</p>
                  ) : (
                    <p className='text-small text-muted-foreground'>有多个或不够确定的模块，请选择。</p>
                  )}
                  <div className='space-y-2'>
                    {result.candidates.map((candidate) => {
                      const selected = candidate.moduleVersionId === resolveVersionId
                      return (
                        <button
                          key={candidate.moduleVersionId}
                          type='button'
                          onClick={() => selectCandidate(candidate, result)}
                          className={`w-full rounded-md border p-3 text-left transition-colors ${
                            selected
                              ? 'border-primary bg-primary/5 ring-1 ring-primary'
                              : 'border-border-card hover:bg-muted/50'
                          }`}
                        >
                          <div className='flex flex-wrap items-center justify-between gap-2'>
                            <span className='font-medium text-body'>{candidate.name}</span>
                            <div className='flex flex-wrap items-center gap-1'>
                              <Badge variant='outline' className='text-label'>
                                {candidate.key}@v{candidate.versionNo}
                              </Badge>
                              <Badge variant='outline' className='text-label'>
                                {MODULE_EXECUTION_MODE_LABELS[candidate.executionMode]}
                              </Badge>
                              <Badge variant='outline' className='text-label'>
                                {MODULE_EFFECT_CEILING_LABELS[candidate.effectCeiling]}
                              </Badge>
                              {candidate.notes.includes('deprecated') ? (
                                <Badge variant='secondary' className='text-label text-muted-foreground'>
                                  已弃用
                                </Badge>
                              ) : null}
                              <ModuleHealthBadge health={healthByModuleId.get(candidate.moduleId)} />
                            </div>
                          </div>
                          <p className='mt-1 text-label text-muted-foreground'>匹配：{matchReason(candidate)}</p>
                        </button>
                      )
                    })}
                  </div>
                  {selectedCandidate ? (
                    <div className='space-y-3 rounded-md border border-border-card bg-muted/20 p-3'>
                      <h4 className='text-section font-medium'>输入建议</h4>
                      {inputKeys.length === 0 ? (
                        <p className='text-small text-muted-foreground'>该模块没有输入。</p>
                      ) : (
                        inputKeys.map((key) => {
                          const input = contractInputs.find((item) => item.key === key)
                          const suggestion = suggestionMap[key]
                          const binding = bindings[key]
                          const missing = suggestion?.kind === 'missing' || !binding
                          return (
                            <div key={key} className={`space-y-2 rounded-md border p-3 ${missing && input?.required ? 'border-status-warning-border' : 'border-border-card'}`}>
                              <div className='flex flex-wrap items-center justify-between gap-2'>
                                <Label htmlFor={`resolve-input-${key}`}>{input?.label || key}</Label>
                                {input?.required ? (
                                  <Badge variant='secondary' className='text-label text-destructive'>
                                    必填
                                  </Badge>
                                ) : null}
                              </div>
                              {suggestionHint(suggestion, expression) ? (
                                <p className='text-label text-muted-foreground'>{suggestionHint(suggestion, expression)}</p>
                              ) : null}
                              <Input
                                id={`resolve-input-${key}`}
                                value={
                                  binding?.kind === 'literal'
                                    ? String(binding.value ?? '')
                                    : binding?.kind === 'from'
                                      ? `from:${binding.key}`
                                      : ''
                                }
                                placeholder={missing ? '未建议，可留空后接受' : '可改写建议值'}
                                onChange={(event) => {
                                  const value = event.target.value
                                  setBindings((current) => {
                                    const next = { ...current }
                                    if (!value.trim()) {
                                      delete next[key]
                                      return next
                                    }
                                    if (value.startsWith('from:')) {
                                      next[key] = { kind: 'from', key: value.slice(5) }
                                    } else if (input?.valueType === 'number' && Number.isFinite(Number(value))) {
                                      next[key] = { kind: 'literal', value: Number(value) }
                                    } else {
                                      next[key] = { kind: 'literal', value }
                                    }
                                    return next
                                  })
                                }}
                              />
                            </div>
                          )
                        })
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value='catalog' className='min-h-0 flex-1 overflow-y-auto'>
            <div className='relative mb-2'>
              <Search className='absolute left-3 top-2.5 size-4 text-muted-foreground' />
              <Input
                placeholder='按名称、key 或别名搜索动作模块…'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className='pl-9'
              />
            </div>
            <div className='grid min-h-0 grid-cols-1 gap-4 sm:grid-cols-2'>
              <div className='space-y-2 pr-1'>
                {modulesQuery.isPending ? (
                  <p className='text-small text-muted-foreground'>加载模块列表中…</p>
                ) : filteredModules.length === 0 ? (
                  <p className='text-small text-muted-foreground'>未找到匹配的动作模块。</p>
                ) : (
                  filteredModules.map((m) => {
                    const isSelected = m.id === selectedModuleId
                    return (
                      <button
                        key={m.id}
                        type='button'
                        onClick={() => {
                          setSelectedModuleId(m.id)
                          setSelectedVersionId(null)
                          setConfirmDeprecated(false)
                        }}
                        className={`w-full rounded-md border p-3 text-left transition-colors ${
                          isSelected
                            ? 'border-primary bg-primary/5 ring-1 ring-primary'
                            : 'border-border-card hover:bg-muted/50'
                        }`}
                      >
                        <div className='flex items-center justify-between gap-1'>
                          <span className='font-medium text-body'>{m.name}</span>
                          {m.publicationStatus === 'deprecated' ? (
                            <Badge variant='outline' className='text-label text-muted-foreground'>
                              已弃用
                            </Badge>
                          ) : null}
                          <ModuleHealthBadge health={m.health} />
                        </div>
                        <p className='text-label text-muted-foreground'>{m.key}</p>
                        {m.description && (
                          <p className='mt-1 line-clamp-2 text-label text-muted-foreground'>
                            {m.description}
                          </p>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
              <div className='rounded-md border border-border-card bg-muted/20 p-4'>
                {selectedModule ? (
                  <div className='space-y-4 text-body'>
                    <div>
                      <h4 className='font-medium'>{selectedModule.name}</h4>
                      <p className='text-label text-muted-foreground'>{selectedModule.key}</p>
                    </div>
                    {selectedModule.description && (
                      <p className='text-small text-muted-foreground'>{selectedModule.description}</p>
                    )}
                    <div className='space-y-2'>
                      <label className='block text-label font-medium'>选择已发布版本</label>
                      {versionsQuery.isPending ? (
                        <p className='text-label text-muted-foreground'>加载版本信息中…</p>
                      ) : publishedVersions.length === 0 ? (
                        <p className='text-small text-status-warning-foreground'>
                          该模块尚未发布有效版本，无法插入场景。
                        </p>
                      ) : (
                        <div className='space-y-1.5'>
                          {publishedVersions.map((v) => {
                            const isVerSelected =
                              selectedVersion?.id === v.id ||
                              (!selectedVersionId && v.id === publishedVersions[0]?.id)
                            return (
                              <button
                                key={v.id}
                                type='button'
                                onClick={() => {
                                  setSelectedVersionId(v.id)
                                  setConfirmDeprecated(false)
                                }}
                                className={`flex w-full items-center justify-between rounded-md border p-2 text-left text-small transition-colors ${
                                  isVerSelected
                                    ? 'border-primary bg-primary/5 font-medium ring-1 ring-primary'
                                    : 'border-border-card hover:bg-muted/40'
                                }`}
                              >
                                <div className='flex items-center gap-2'>
                                  <span>v{v.versionNo}</span>
                                  <Badge variant='outline' className='text-label'>
                                    {MODULE_EXECUTION_MODE_LABELS[v.executionMode] ?? v.executionMode}
                                  </Badge>
                                  {v.publicationStatus === 'deprecated' && (
                                    <Badge variant='secondary' className='text-label text-muted-foreground'>
                                      已弃用
                                    </Badge>
                                  )}
                                </div>
                                <span className='text-label text-muted-foreground'>
                                  {MODULE_EFFECT_CEILING_LABELS[v.effectCeiling] ?? v.effectCeiling}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className='flex h-full items-center justify-center text-small text-muted-foreground'>
                    请在左侧选择要插入的动作模块
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {(tab === 'catalog' && selectedVersion?.publicationStatus === 'deprecated') ||
        (tab === 'resolve' && selectedCandidate?.notes.includes('deprecated')) ? (
          <label className='flex shrink-0 items-start gap-3 rounded-md border p-3 text-body'>
            <Checkbox
              aria-label='确认插入已弃用版本'
              checked={confirmDeprecated}
              onCheckedChange={(value) => setConfirmDeprecated(value === true)}
            />
            <span>该版本已弃用。确认后仍可插入，建议尽快升级到最新可选版本。</span>
          </label>
        ) : null}

        <DialogFooter className='shrink-0 pt-2'>
          <Button variant='outline' onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          {tab === 'catalog' ? (
            <Button disabled={catalogDisabled} onClick={handleCatalogConfirm}>
              插入模块节点
            </Button>
          ) : (
            <Button disabled={resolveDisabled} loading={accepting} onClick={() => void handleAccept()}>
              写入草稿
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
