import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import {
  compileScenarioDocument,
  EXECUTABLE_STEP_TYPES,
  MAX_SCENARIO_STEPS,
  type CompileDiagnostic,
  type ExecutableStepType,
  type ScenarioDocument,
} from '@cairn/shared'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ListOrdered,
  Play,
  Plus,
  Save,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchScenario, publishScenario, saveScenarioDraft } from '@/lib/scenarios-api'
import { fetchTarget } from '@/lib/targets-api'
import { cn } from '@/lib/utils'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { RunCreateDialog } from '@/features/runs/create-dialog'
import { createBlankStep } from './blank-step'
import { InputsEditor, StepEditor } from './step-editor'
import { TrialDialog } from './trial-dialog'
import { SCENARIO_STATUS_LABELS, STEP_TYPE_LABELS } from './labels'

function sameDocument(left: ScenarioDocument, right: ScenarioDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function ScenarioDetailPage() {
  const { scenarioId } = useParams({
    from: '/_authenticated/scenarios/$scenarioId/',
  })
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['scenarios', scenarioId],
    queryFn: () => fetchScenario(scenarioId),
  })
  const canReadTarget = useCan('target:read')
  const canWrite = useCan('workflow:write')
  const canRun = useCan('run:execute')
  const scenario = query.data
  const targetQuery = useQuery({
    queryKey: ['target', scenario?.targetId],
    queryFn: () => fetchTarget(scenario!.targetId),
    enabled: !!scenario && canReadTarget,
  })
  const target = canReadTarget ? targetQuery.data : undefined
  const [document, setDocument] = useState<ScenarioDocument | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [trialOpen, setTrialOpen] = useState(false)
  const [runOpen, setRunOpen] = useState(false)

  useEffect(() => {
    if (!scenario?.draft) return
    setDocument(scenario.draft.document)
    setSelectedId((current) => current ?? scenario.draft!.document.steps[0]?.id ?? null)
    setConflict(false)
  }, [scenario?.id, scenario?.draft?.revision])

  const savedDocument = scenario?.draft?.document
  const dirty = Boolean(document && savedDocument && !sameDocument(document, savedDocument))
  const compile = useMemo(() => {
    if (!document) return scenario?.compile
    return compileScenarioDocument(document, {
      mode: 'release',
      target: target
        ? { exists: true, status: target.status }
        : scenario
          ? { exists: true, status: 'active' }
          : undefined,
    })
  }, [document, scenario, target])

  const selected = selectedId
    ? (document?.steps.find((step) => step.id === selectedId) ?? document?.steps[0] ?? null)
    : null
  const selectedIndex = selected
    ? (document?.steps.findIndex((step) => step.id === selected.id) ?? 0)
    : -1
  const bindings = [
    ...(document?.inputs ?? []).map((input) => ({
      key: input.key,
      label: `输入 · ${input.label}`,
    })),
    ...(document?.steps ?? [])
      .filter((step) => step.outputKey)
      .map((step) => ({ key: step.outputKey!, label: `步骤 · ${step.name}` })),
  ]
  const disabled = !canWrite || saving || publishing
  const canTrial = canWrite && canRun && !dirty && Boolean(compile?.ok) && scenario?.status === 'active' && target?.status !== 'disabled'
  const canPublish = Boolean(
    canWrite && !dirty && compile?.ok && scenario && scenario.status === 'active' && target?.status !== 'disabled',
  )
  const unpublishedDraft = Boolean(scenario?.draftDirty)

  function move(index: number, delta: number) {
    if (!document) return
    const nextIndex = index + delta
    if (nextIndex < 0 || nextIndex >= document.steps.length) return
    const steps = [...document.steps]
    const [item] = steps.splice(index, 1)
    steps.splice(nextIndex, 0, item!)
    setDocument({ ...document, steps })
  }

  useEffect(() => {
    if (!canWrite || !document || selectedIndex < 0) return
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey) return
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        move(selectedIndex, -1)
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        move(selectedIndex, 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canWrite, document, selectedIndex])

  async function save() {
    if (!document || !scenario?.draft || saving) return
    setSaving(true)
    try {
      const next = await saveScenarioDraft(scenario.id, {
        revision: scenario.draft.revision,
        document,
      })
      queryClient.setQueryData(['scenarios', scenarioId], next)
      setDocument(next.draft!.document)
      setConflict(false)
      toast.success('草稿已保存')
    } catch (error) {
      if (error instanceof ApiRequestError && error.payload.code === 'SCENARIO_DRAFT_CONFLICT') {
        setConflict(true)
        toast.error('他人已更新这份草稿，请重新加载')
      } else {
        toast.error(error instanceof ApiRequestError ? error.message : '保存失败')
      }
    } finally {
      setSaving(false)
    }
  }

  async function publish() {
    if (!scenario?.draft || dirty || publishing) return
    setPublishing(true)
    try {
      const next = await publishScenario(scenario.id, { revision: scenario.draft.revision })
      queryClient.setQueryData(['scenarios', scenarioId], next)
      toast.success('已发布新版本')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <>
      <AppHeader
        fixed
        leading={
          <Link
            to='/scenarios'
            className='me-auto flex items-center gap-2 text-small text-muted-foreground hover:text-link'
          >
            <ArrowLeft className='size-4' />
            返回场景
          </Link>
        }
      />
      <Main className='flex min-w-0 flex-1 flex-col gap-5'>
        <PageHeader
          title={scenario?.name ?? '场景'}
          description='编辑有序步骤、查看编译诊断，保存草稿后再试跑或发布。试跑进度需在运行详情中刷新。'
          actions={
            scenario && !query.isError ? (
              <div className='flex flex-wrap items-center gap-2'>
                {canWrite ? (
                  <Button
                    variant={dirty ? 'default' : 'outline'}
                    disabled={!dirty || saving}
                    loading={saving}
                    onClick={() => void save()}
                  >
                    <Save />
                    保存草稿
                  </Button>
                ) : null}
                {canTrial ? (
                  <Button onClick={() => setTrialOpen(true)}>
                    <Play />
                    试跑
                  </Button>
                ) : canRun ? (
                  <Button
                    variant='outline'
                    disabled
                    title={
                      compile?.ok === false
                        ? '先修复编译错误'
                        : dirty
                          ? '先保存草稿'
                          : '当前不能试跑'
                    }
                  >
                    <Play />
                    试跑
                  </Button>
                ) : null}
                {canWrite && (dirty || unpublishedDraft) ? (
                  <Button
                    variant='outline'
                    disabled={!canPublish || publishing}
                    loading={publishing}
                    onClick={() => void publish()}
                  >
                    发布
                  </Button>
                ) : null}
                {canRun && !dirty && compile?.ok && !unpublishedDraft ? (
                  <Button variant='outline' onClick={() => setRunOpen(true)}>
                    运行已发布版本
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant='outline'>
                      更多
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align='end'>
                    {canWrite && !dirty && !unpublishedDraft ? (
                      <DropdownMenuItem disabled={!canPublish || publishing} onClick={() => void publish()}>
                        发布
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem disabled={!canRun} onClick={() => setRunOpen(true)}>
                      运行已发布版本
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null
          }
        />
        {query.isPending || !document ? (
          query.isError ? (
            <QueryErrorState title='无法加载场景' onRetry={() => void query.refetch()} />
          ) : (
            <PageSkeleton />
          )
        ) : (
          <>
            {conflict ? (
              <Alert variant='warning'>
                <AlertDescription className='flex flex-wrap items-center justify-between gap-3'>
                  他人已更新这份草稿。重新加载会丢掉未保存的本地修改。
                  <Button
                    size='sm'
                    variant='outline'
                    onClick={() => {
                      void query.refetch().then((result) => {
                        if (result.data?.draft) setDocument(result.data.draft.document)
                        setConflict(false)
                      })
                    }}
                  >
                    重新加载
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {scenario.status === 'disabled' || target?.status === 'disabled' ? (
              <Alert variant='warning'>
                <AlertDescription>
                  {scenario.status === 'disabled'
                    ? '场景已停用，不能发布或试跑。'
                    : '绑定的目标系统已停用，不能发布或试跑。'}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className='flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border-card bg-card px-5 py-4 shadow-card'>
              <div>
                <p className='text-label text-muted-foreground'>目标系统</p>
                {canReadTarget ? (
                  <Link
                    to='/targets/$targetId'
                    params={{ targetId: scenario.targetId }}
                    className='text-body font-medium text-link hover:underline'
                  >
                    {target?.name ?? scenario.targetId}
                  </Link>
                ) : (
                  <p className='font-mono text-label'>{scenario.targetId}</p>
                )}
              </div>
              <div>
                <p className='text-label text-muted-foreground'>已发布</p>
                <p className='text-body font-medium'>v{scenario.latestVersionNo}</p>
              </div>
              <div>
                <p className='text-label text-muted-foreground'>草稿</p>
                <p className='text-body font-medium'>r{scenario.draft?.revision ?? 1}</p>
              </div>
              <StatusBadge tone={dirty || scenario.draftDirty ? 'warning' : 'success'}>
                {dirty ? '未保存' : scenario.draftDirty ? '有未发布草稿' : '与已发布一致'}
              </StatusBadge>
              {compile?.ok === false ? (
                <StatusBadge tone='error'>编译未通过</StatusBadge>
              ) : null}
              <StatusBadge tone={scenario.status === 'active' ? 'success' : 'neutral'}>
                {SCENARIO_STATUS_LABELS[scenario.status]}
              </StatusBadge>
            </div>
            <div className='grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]'>
              <section
                aria-label='执行步骤'
                className='min-w-0 overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='flex items-center justify-between gap-3 border-b border-border-divider px-5 py-4'>
                  <h2 className='flex items-center gap-2 text-section font-semibold'>
                    <ListOrdered className='size-4 text-primary' />
                    执行步骤
                  </h2>
                  {canWrite ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || document.steps.length >= MAX_SCENARIO_STEPS}
                        >
                          <Plus />
                          添加步骤
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        {EXECUTABLE_STEP_TYPES.map((type) => (
                          <DropdownMenuItem
                            key={type}
                            onClick={() => {
                              const next = createBlankStep(type)
                              setDocument({ ...document, steps: [...document.steps, next] })
                              setSelectedId(next.id)
                            }}
                          >
                            {STEP_TYPE_LABELS[type]}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <ol className='max-h-[65vh] space-y-2 overflow-y-auto p-4'>
                  {document.steps.map((step, index) => {
                    const stepDiagnostics = (compile?.diagnostics ?? []).filter((item) => item.stepId === step.id)
                    const hasError = stepDiagnostics.some((item) => item.severity === 'error')
                    const hasWarning = stepDiagnostics.some((item) => item.severity === 'warning')
                    return (
                      <li key={step.id} className='flex min-w-0 items-center gap-2'>
                        <span className='w-5 shrink-0 text-center font-mono text-label text-muted-foreground'>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <button
                          type='button'
                          aria-pressed={selected?.id === step.id}
                          onClick={() => setSelectedId(step.id)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-3 rounded-md border p-4 text-left',
                            selected?.id === step.id
                              ? 'border-selection-border bg-selection-background shadow-control-focus'
                              : 'border-border-default bg-card hover:bg-action-hover',
                            hasError && 'border-status-error-foreground',
                            !hasError && hasWarning && 'border-status-warning-foreground',
                          )}
                        >
                          <span className='min-w-0 flex-1'>
                            <span className='block text-body font-medium break-words'>{step.name}</span>
                            <span className='mt-1 text-label text-muted-foreground'>
                              {STEP_TYPE_LABELS[step.type as ExecutableStepType] ?? step.type}
                              {step.outputKey ? ` · 输出 ${step.outputKey}` : ''}
                            </span>
                          </span>
                          {hasError ? <TriangleAlert className='size-4 text-status-error-foreground' /> : null}
                          <ChevronRight className='size-4 shrink-0 text-muted-foreground' />
                        </button>
                      </li>
                    )
                  })}
                </ol>
                <p className='border-t border-border-divider bg-surface-header px-5 py-3 text-label text-muted-foreground'>
                  使用 Alt + ↑ / Alt + ↓ 重排当前步骤。删除需要确认。
                </p>
              </section>
              <section
                aria-label={selected ? '步骤属性' : '场景输入'}
                className='min-w-0 rounded-lg border border-border-card bg-card shadow-card'
              >
                <div className='border-b border-border-divider p-5'>
                  <p className='text-label text-muted-foreground'>
                    {selected ? `步骤 ${selectedIndex + 1} / ${document.steps.length}` : '场景级'}
                  </p>
                  <h2 className='mt-1 text-section font-semibold break-words'>
                    {selected ? selected.name : '输入与诊断'}
                  </h2>
                </div>
                <div className='space-y-6 p-5'>
                  {selected ? (
                    <>
                      <StepEditor
                        step={selected}
                        index={selectedIndex}
                        bindings={bindings}
                        diagnostics={(compile?.diagnostics ?? []) as CompileDiagnostic[]}
                        disabled={disabled}
                        onChange={(next) =>
                          setDocument({
                            ...document,
                            steps: document.steps.map((step) => (step.id === next.id ? next : step)),
                          })
                        }
                      />
                      <div className='flex flex-wrap gap-2'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || selectedIndex === 0}
                          onClick={() => move(selectedIndex, -1)}
                        >
                          上移
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || selectedIndex === document.steps.length - 1}
                          onClick={() => move(selectedIndex, 1)}
                        >
                          下移
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={disabled || document.steps.length <= 1}
                          onClick={() => setDeleteId(selected.id)}
                        >
                          删除
                        </Button>
                      </div>
                    </>
                  ) : (
                    <InputsEditor
                      inputs={document.inputs}
                      disabled={disabled}
                      onChange={(inputs) => setDocument({ ...document, inputs })}
                    />
                  )}
                  {!selected ? (
                    <DiagnosticList diagnostics={compile?.diagnostics ?? []} />
                  ) : (
                    <button
                      type='button'
                      className='text-small text-link hover:underline'
                      onClick={() => setSelectedId(null)}
                    >
                      查看场景输入与全局诊断
                    </button>
                  )}
                </div>
              </section>
            </div>
          </>
        )}
      </Main>
      <AlertDialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这一步？</AlertDialogTitle>
            <AlertDialogDescription>删除后需要保存才会写入草稿。引用它的后续步骤可能会变成前向引用。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!document || !deleteId) return
                const steps = document.steps.filter((step) => step.id !== deleteId)
                setDocument({ ...document, steps })
                setSelectedId(steps[Math.max(0, selectedIndex - 1)]?.id ?? null)
                setDeleteId(null)
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {scenario && trialOpen ? (
        <TrialDialog
          open
          onOpenChange={setTrialOpen}
          scenarioId={scenario.id}
          targetId={scenario.targetId}
          revision={scenario.draft?.revision ?? 1}
          inputs={document?.inputs ?? []}
        />
      ) : null}
      {scenario && runOpen ? (
        <RunCreateDialog
          key={scenario.id}
          open
          onOpenChange={setRunOpen}
          defaultScenarioId={scenario.id}
          defaultTargetId={scenario.targetId}
        />
      ) : null}
    </>
  )
}

function DiagnosticList({ diagnostics }: { diagnostics: CompileDiagnostic[] }) {
  if (diagnostics.length === 0) {
    return <p className='text-small text-muted-foreground'>当前没有编译诊断。</p>
  }
  return (
    <ul className='space-y-2' aria-label='编译诊断'>
      {diagnostics.map((item) => (
        <li
          key={`${item.code}-${item.stepId ?? item.inputKey ?? 'global'}-${item.message}`}
          className={
            item.severity === 'error'
              ? 'rounded-md bg-status-error-background p-3 text-small text-status-error-foreground'
              : 'rounded-md bg-status-warning-background p-3 text-small text-status-warning-foreground'
          }
        >
          {item.message}
        </li>
      ))}
    </ul>
  )
}
