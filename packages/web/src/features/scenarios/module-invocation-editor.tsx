import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  latestSelectableVersion,
  resolveInvocationSelection,
  type CompileDiagnostic,
  type ModuleInputBinding,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDocument,
  type ScenarioInputDecl,
  type ScenarioModuleInvocationNode,
} from '@cairn/shared'
import { ExternalLink, Eye, Layers, UnfoldVertical } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { fetchActionModule, fetchActionModuleVersion, fetchActionModuleVersions } from '@/lib/action-modules-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { inlineScenarioModuleInvocation } from '@/lib/scenarios-api'
import { MODULE_EXECUTION_MODE_LABELS } from '@/features/action-modules/labels'
import { ModuleUpgradeDialog } from '@/features/action-modules/upgrade-dialog'
import { ModuleExpansionPreviewDrawer } from './module-expansion-preview-drawer'
import { bindingUiKind, type BindingOption } from './studio-document'

type ModuleInvocationEditorProps = {
  node: ScenarioModuleInvocationNode
  scenarioId: string
  scenarioInputs: ScenarioInputDecl[]
  priorBindings: BindingOption[]
  baselineRevision: number
  document: ScenarioAuthoringDocumentV2 | ScenarioDocument
  diagnostics: CompileDiagnostic[]
  disabled?: boolean
  onChange: (node: ScenarioModuleInvocationNode) => void
  onInlined: () => void
}

export function ModuleInvocationEditor({
  node,
  scenarioId,
  scenarioInputs,
  priorBindings,
  baselineRevision,
  document,
  diagnostics,
  disabled,
  onChange,
  onInlined,
}: ModuleInvocationEditorProps) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const [inlineConfirmOpen, setInlineConfirmOpen] = useState(false)
  const [inlining, setInlining] = useState(false)
  const [upgradeOpen, setUpgradeOpen] = useState(false)

  const moduleQuery = useQuery({
    queryKey: ['action-module', node.moduleId],
    queryFn: () => fetchActionModule(node.moduleId),
    enabled: Boolean(node.moduleId),
  })
  const versionQuery = useQuery({
    queryKey: ['action-module-version', node.moduleId, node.moduleVersionId],
    queryFn: () => fetchActionModuleVersion(node.moduleId, node.moduleVersionId!),
    enabled: Boolean(node.moduleId && node.moduleVersionId),
  })
  const versionsQuery = useQuery({
    queryKey: ['action-module-versions', node.moduleId],
    queryFn: () => fetchActionModuleVersions(node.moduleId),
    enabled: Boolean(node.moduleId),
  })
  const platformQuery = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
  })
  const latestVersion = latestSelectableVersion(versionsQuery.data?.items ?? [])
  const canUpgrade = Boolean(
    latestVersion && latestVersion.id !== node.moduleVersionId,
  )

  const version = versionQuery.data
  const moduleKey = moduleQuery.data?.key
  const implementations = version?.content.implementations ?? []
  const selection = resolveInvocationSelection(node)
  const fallbackEnabled = platformQuery.data?.document.moduleFallback.enabled === true
  const canFallback =
    fallbackEnabled &&
    version?.content.contract.effectCeiling === 'READ_ONLY' &&
    implementations.length > 1 &&
    implementations.every((item) => item.steps.every((step) => step.effectType === 'READ_ONLY'))
  const contractInputs = version?.content.contract.inputs ?? []
  const contractOutputs = version?.content.contract.outputs ?? []
  const scenarioInputKeys = scenarioInputs.map((input) => input.key)
  const priorOutputKeys = priorBindings
    .filter((item) => !scenarioInputKeys.includes(item.key) && !item.stale)
    .map((item) => item.key)

  const handleInline = async () => {
    setInlining(true)
    try {
      await inlineScenarioModuleInvocation(scenarioId, node.invocationId, {
        expectedDraftLockVersion: baselineRevision,
      })
      toast.success('已将模块展开为独立步骤')
      setInlineConfirmOpen(false)
      onInlined()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '内联展开失败')
    } finally {
      setInlining(false)
    }
  }

  const updateInputBinding = (inputKey: string, binding: ModuleInputBinding | undefined) => {
    const nextBindings = { ...node.inputBindings }
    if (binding === undefined) {
      delete nextBindings[inputKey]
    } else {
      nextBindings[inputKey] = binding
    }
    onChange({ ...node, inputBindings: nextBindings })
  }

  const updateOutputBinding = (outputKey: string, targetKey: string | undefined) => {
    const nextOutputs = { ...node.outputBindings }
    if (!targetKey || targetKey.trim() === '') {
      delete nextOutputs[outputKey]
    } else {
      nextOutputs[outputKey] = targetKey.trim()
    }
    onChange({ ...node, outputBindings: nextOutputs })
  }

  return (
    <div className='space-y-6'>
      <div className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <div className='flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between'>
          <div className='min-w-0 space-y-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <Layers className='size-5 shrink-0 text-primary' />
              <h3 className='min-w-0 text-section font-semibold break-words'>{node.name || moduleQuery.data?.name || '动作模块'}</h3>
              <Badge variant='outline' className='shrink-0'>
                {moduleKey && version
                  ? `${moduleKey}@v${version.versionNo}`
                  : node.moduleDraft
                    ? '模块草稿'
                    : '加载中…'}
              </Badge>
            </div>
            {moduleKey ? <p className='text-label text-muted-foreground break-all'>{moduleKey}</p> : null}
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Button size='sm' variant='outline' onClick={() => setPreviewOpen(true)}>
              <Eye className='size-4 mr-1' />
              查看展开步骤
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={disabled || inlining}
              onClick={() => setInlineConfirmOpen(true)}
            >
              <UnfoldVertical className='size-4 mr-1' />
              展开为独立步骤
            </Button>
            {canUpgrade && latestVersion ? (
              <Button size='sm' variant='outline' disabled={disabled} onClick={() => setUpgradeOpen(true)}>
                升级到最新
              </Button>
            ) : null}
          </div>
        </div>

        <div className='mt-3 flex flex-wrap items-center gap-2'>
          {version ? (
            <>
              <Badge variant='secondary'>
                {MODULE_EXECUTION_MODE_LABELS[version.executionMode] ?? version.executionMode}
              </Badge>
              <Badge variant='outline'>
                {version.effectCeiling === 'SIDE_EFFECT' ? '写副作用' : '只读执行'}
              </Badge>
            </>
          ) : null}
          <Link
            to='/action-modules/$moduleId'
            params={{ moduleId: node.moduleId }}
            className='inline-flex items-center gap-1 text-label text-primary hover:underline'
            target='_blank'
          >
            打开模块
            <ExternalLink className='size-3' />
          </Link>
        </div>
      </div>

      {diagnostics.length > 0 ? (
        <div className='rounded-md border border-status-warning-border bg-status-warning-background p-3 text-small text-status-warning-foreground'>
          <p className='font-medium'>关于此模块调用的诊断：</p>
          <ul className='mt-1 list-disc space-y-1 ps-4'>
            {diagnostics.map((item, index) => (
              <li key={`${item.code}-${index}`}>{item.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className='space-y-4 rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <h4 className='text-section font-semibold'>实现选择</h4>
        <div className='space-y-3'>
          <div>
            <Label className='text-label'>选择模式</Label>
            <Select
              value={selection.mode}
              disabled={disabled}
              onValueChange={(mode: 'pinned' | 'frozen_fallback') => {
                if (mode === 'frozen_fallback' && canFallback) {
                  onChange({
                    ...node,
                    implementationKey: implementations[0]?.implementationKey ?? node.implementationKey,
                    selection: {
                      mode: 'frozen_fallback',
                      candidates: implementations.slice(0, 3).map((item) => item.implementationKey),
                    },
                  })
                  return
                }
                onChange({
                  ...node,
                  selection: {
                    mode: 'pinned',
                    implementationKey: implementations[0]?.implementationKey ?? node.implementationKey,
                  },
                  implementationKey: implementations[0]?.implementationKey ?? node.implementationKey,
                })
              }}
            >
              <SelectTrigger className='w-full sm:w-64' aria-label='模块实现选择模式'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='pinned'>固定一个实现</SelectItem>
                <SelectItem value='frozen_fallback' disabled={!canFallback}>
                  只读冻结回退
                </SelectItem>
              </SelectContent>
            </Select>
            {!canFallback ? (
              <p className='mt-1 text-label text-muted-foreground'>
                {fallbackEnabled
                  ? '只有只读且有多个只读实现的模块才能声明回退。'
                  : '平台尚未开放冻结回退，调用只能固定一个实现。'}
              </p>
            ) : null}
          </div>
          {selection.mode === 'pinned' || !canFallback ? (
            <div>
              <Label className='text-label'>实现</Label>
              <Select
                value={selection.keys[0] ?? node.implementationKey}
                disabled={disabled || implementations.length === 0}
                onValueChange={(implementationKey) =>
                  onChange({
                    ...node,
                    implementationKey,
                    selection: { mode: 'pinned', implementationKey },
                  })
                }
              >
                <SelectTrigger className='w-full sm:w-64' aria-label='固定实现'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {implementations.map((item) => (
                    <SelectItem key={item.implementationKey} value={item.implementationKey}>
                      {item.implementationKey}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className='space-y-2'>
              <p className='text-label text-muted-foreground'>按顺序尝试这些实现，失败且归因于模块时才回退。</p>
              {(node.selection?.mode === 'frozen_fallback' ? node.selection.candidates : selection.keys).map((key, index) => (
                <div key={`${key}-${index}`} className='flex items-center gap-2'>
                  <span className='text-label text-muted-foreground'>{index + 1}</span>
                  <Select
                    value={key}
                    disabled={disabled}
                    onValueChange={(nextKey) => {
                      const current = node.selection?.mode === 'frozen_fallback' ? [...node.selection.candidates] : [...selection.keys]
                      current[index] = nextKey
                      onChange({
                        ...node,
                        implementationKey: current[0] ?? nextKey,
                        selection: { mode: 'frozen_fallback', candidates: current },
                      })
                    }}
                  >
                    <SelectTrigger className='w-full sm:w-64' aria-label={`回退候选 ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {implementations.map((item) => (
                        <SelectItem key={item.implementationKey} value={item.implementationKey}>
                          {item.implementationKey}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className='space-y-4 rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <h4 className='text-section font-semibold'>输入绑定</h4>
        {versionQuery.isPending ? (
          <p className='text-small text-muted-foreground'>加载模块入参契约中…</p>
        ) : contractInputs.length === 0 ? (
          <p className='text-small text-muted-foreground'>该动作模块没有声明输入参数。</p>
        ) : (
          <div className='space-y-4'>
            {contractInputs.map((input) => {
              const currentBinding = node.inputBindings[input.key]
              const sourceKind = bindingUiKind(currentBinding, scenarioInputKeys)
              return (
                <div key={input.key} className='space-y-2 rounded-md border border-border-card/60 p-3'>
                  <div className='flex items-center justify-between'>
                    <div>
                      <span className='font-medium text-body'>{input.label || input.key}</span>
                      <span className='ml-2 font-mono text-label text-muted-foreground'>{input.key}</span>
                    </div>
                    <div className='flex items-center gap-2'>
                      <Badge variant='outline' className='text-label'>
                        {input.valueType}
                      </Badge>
                      {input.required ? (
                        <Badge variant='secondary' className='text-label text-destructive'>
                          必填
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  {input.description ? (
                    <p className='text-label text-muted-foreground'>{input.description}</p>
                  ) : null}
                  <div className='grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3'>
                    <div>
                      <Label className='text-label'>绑定来源</Label>
                      <Select
                        value={sourceKind}
                        disabled={disabled}
                        onValueChange={(kind: 'literal' | 'input' | 'step') => {
                          if (kind === 'literal') {
                            updateInputBinding(input.key, { kind: 'literal', value: '' })
                            return
                          }
                          if (kind === 'input') {
                            updateInputBinding(input.key, {
                              kind: 'from',
                              key: scenarioInputs[0]?.key ?? '',
                            })
                            return
                          }
                          updateInputBinding(input.key, {
                            kind: 'from',
                            key: priorOutputKeys[0] ?? '',
                          })
                        }}
                      >
                        <SelectTrigger className='w-full'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='literal'>字面量</SelectItem>
                          <SelectItem value='input'>场景输入</SelectItem>
                          <SelectItem value='step'>前序输出</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='sm:col-span-2'>
                      <Label className='text-label'>绑定值</Label>
                      {sourceKind === 'literal' ? (
                        <Input
                          placeholder='字面量值'
                          disabled={disabled}
                          value={
                            currentBinding && currentBinding.kind === 'literal'
                              ? String(currentBinding.value ?? '')
                              : ''
                          }
                          onChange={(event) =>
                            updateInputBinding(input.key, {
                              kind: 'literal',
                              value: event.target.value,
                            })
                          }
                        />
                      ) : null}
                      {sourceKind === 'input' ? (
                        <Select
                          disabled={disabled || scenarioInputs.length === 0}
                          value={currentBinding && currentBinding.kind === 'from' ? currentBinding.key : ''}
                          onValueChange={(key) => updateInputBinding(input.key, { kind: 'from', key })}
                        >
                          <SelectTrigger className='w-full'>
                            <SelectValue placeholder='选择场景输入' />
                          </SelectTrigger>
                          <SelectContent>
                            {scenarioInputs.map((item) => (
                              <SelectItem key={item.key} value={item.key}>
                                {item.label} ({item.key})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      {sourceKind === 'step' ? (
                        <div className='flex gap-2'>
                          <Select
                            disabled={disabled || priorOutputKeys.length === 0}
                            value={currentBinding && currentBinding.kind === 'from' ? currentBinding.key : ''}
                            onValueChange={(key) =>
                              updateInputBinding(input.key, {
                                kind: 'from',
                                key,
                                field: currentBinding && currentBinding.kind === 'from' ? currentBinding.field : undefined,
                              })
                            }
                          >
                            <SelectTrigger className='w-full'>
                              <SelectValue placeholder='选择前序输出' />
                            </SelectTrigger>
                            <SelectContent>
                              {priorOutputKeys.map((key) => (
                                <SelectItem key={key} value={key}>
                                  {key}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Input
                            placeholder='字段（可选）'
                            className='w-32'
                            disabled={disabled}
                            value={
                              currentBinding && currentBinding.kind === 'from' ? currentBinding.field ?? '' : ''
                            }
                            onChange={(event) =>
                              updateInputBinding(input.key, {
                                kind: 'from',
                                key: currentBinding && currentBinding.kind === 'from' ? currentBinding.key : '',
                                field: event.target.value.trim() || undefined,
                              })
                            }
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className='space-y-4 rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <h4 className='text-section font-semibold'>输出暴露名</h4>
        {versionQuery.isPending ? (
          <p className='text-small text-muted-foreground'>加载模块出参契约中…</p>
        ) : contractOutputs.length === 0 ? (
          <p className='text-small text-muted-foreground'>该动作模块没有声明输出变量。</p>
        ) : (
          <div className='space-y-3'>
            {contractOutputs.map((output) => {
              const currentBinding = node.outputBindings[output.key]
              return (
                <div key={output.key} className='space-y-2 rounded-md border border-border-card/60 p-3'>
                  <div className='flex items-center justify-between'>
                    <div>
                      <span className='font-medium text-body'>{output.label || output.key}</span>
                      <span className='ml-2 font-mono text-label text-muted-foreground'>{output.key}</span>
                    </div>
                    <Badge variant='outline' className='text-label'>
                      {output.shape.kind}
                    </Badge>
                  </div>
                  {output.description ? (
                    <p className='text-label text-muted-foreground'>{output.description}</p>
                  ) : null}
                  <div className='flex items-center gap-2 pt-1'>
                    <Label className='whitespace-nowrap text-label'>场景上下文键</Label>
                    <Input
                      placeholder='留空表示不暴露到场景上下文'
                      disabled={disabled}
                      value={currentBinding ?? ''}
                      onChange={(event) => updateOutputBinding(output.key, event.target.value)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <ModuleExpansionPreviewDrawer
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        scenarioId={scenarioId}
        invocationId={node.invocationId}
        document={document}
      />

      {latestVersion ? (
        <ModuleUpgradeDialog
          open={upgradeOpen}
          onOpenChange={setUpgradeOpen}
          scenarioId={scenarioId}
          invocationId={node.invocationId}
          toVersionId={latestVersion.id}
          onUpgraded={() => {
            toast.success('草稿已升级')
            onInlined()
          }}
        />
      ) : null}

      <AlertDialog open={inlineConfirmOpen} onOpenChange={setInlineConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>展开为独立步骤</AlertDialogTitle>
            <AlertDialogDescription>
              确定要把这个模块调用替换成同顺序的独立步骤吗？展开后步骤会带上来源说明，此操作不可逆。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={inlining}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={inlining} onClick={handleInline}>
              {inlining ? '展开中…' : '确认展开'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
