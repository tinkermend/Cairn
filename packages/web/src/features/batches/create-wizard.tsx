import { useState, useTransition, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  type DataBinding,
  type DataBindingRule,
  type DatasetDetail,
  type PreflightResult,
  type ScenarioInputDecl,
  computePacingJitter,
} from '@cairn/shared'
import { fetchScenarios, fetchScenario } from '@/lib/scenarios-api'
import { fetchDatasets, preflightDataset } from '@/lib/datasets-api'
import { createBatch } from '@/lib/batches-api'
import { GeneratorConfigEditor } from '@/features/authoring/generator-editor'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertCircle,
  ChevronRight,
  Layers,
  Sparkles,
  Sliders,
  Play,
} from 'lucide-react'

interface BatchCreateWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (batchId: string) => void
}

export function BatchCreateWizard({
  open,
  onOpenChange,
  onSuccess,
}: BatchCreateWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [batchName, setBatchName] = useState('')
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('')
  const [selectedDatasetId, setSelectedDatasetId] = useState<string>('')
  const [binding, setBinding] = useState<DataBinding>({})
  const [maxConcurrency, setMaxConcurrency] = useState(1)
  const [minDelayMs, setMinDelayMs] = useState(1500)
  const [maxDelayMs, setMaxDelayMs] = useState(3500)
  const [failurePolicy, setFailurePolicy] = useState<'continue' | 'stop_on_first' | 'stop_on_threshold'>('stop_on_threshold')
  const [failureThreshold, setFailureThreshold] = useState(5)
  const [resetPage, setResetPage] = useState(true)
  const [preflightData, setPreflightData] = useState<PreflightResult | null>(null)
  const [preflightPending, setPreflightPending] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [isSubmitting, startTransition] = useTransition()

  const scenariosQuery = useQuery({
    queryKey: ['scenarios', { limit: 100 }],
    queryFn: () => fetchScenarios({ limit: 100 }),
    enabled: open,
  })

  const scenarioDetailQuery = useQuery({
    queryKey: ['scenario-detail', selectedScenarioId],
    queryFn: () => (selectedScenarioId ? fetchScenario(selectedScenarioId) : null),
    enabled: Boolean(selectedScenarioId && open),
  })

  const scenarioDetail = scenarioDetailQuery.data
  const publishedVersion = scenarioDetail?.published
  const scenarioTargetId = scenarioDetail?.targetId

  const datasetsQuery = useQuery({
    queryKey: ['datasets', { limit: 100, targetId: scenarioTargetId }],
    queryFn: () => fetchDatasets({ limit: 100, targetId: scenarioTargetId }),
    enabled: Boolean(open && scenarioTargetId),
  })

  // Extract scenario inputs
  const scenarioInputs: ScenarioInputDecl[] = useMemo(() => {
    if (!scenarioDetail) return []
    const inputs =
      scenarioDetail.published?.definition?.inputs ??
      scenarioDetail.draft?.document?.inputs ??
      []
    return inputs as unknown as ScenarioInputDecl[]
  }, [scenarioDetail])

  const selectedDataset: DatasetDetail | undefined = useMemo(() => {
    return datasetsQuery.data?.items.find((d) => d.id === selectedDatasetId)
  }, [datasetsQuery.data, selectedDatasetId])

  function resetState() {
    setStep(1)
    setBatchName('')
    setSelectedScenarioId('')
    setSelectedDatasetId('')
    setBinding({})
    setMaxConcurrency(1)
    setMinDelayMs(1500)
    setMaxDelayMs(3500)
    setFailurePolicy('stop_on_threshold')
    setFailureThreshold(5)
    setResetPage(true)
    setPreflightData(null)
    setErrorMsg(null)
  }

  function handleAutoMap() {
    if (!selectedDataset || scenarioInputs.length === 0) return
    const nextBinding: DataBinding = {}
    const columns = selectedDataset.columns

    for (const input of scenarioInputs) {
      // 1. Exact match by key
      const matchByKey = columns.find(
        (c) => c.key.toLowerCase() === input.key.toLowerCase()
      )
      if (matchByKey) {
        nextBinding[input.key] = { source: 'column', columnName: matchByKey.name }
        continue
      }
      // 2. Exact match by label
      const matchByLabel = columns.find(
        (c) => c.name.toLowerCase() === input.label.toLowerCase()
      )
      if (matchByLabel) {
        nextBinding[input.key] = { source: 'column', columnName: matchByLabel.name }
        continue
      }
      // 3. Fallback to defaultGenerator if present
      if (input.defaultGenerator) {
        nextBinding[input.key] = { source: 'generator', spec: input.defaultGenerator }
        continue
      }
      // 4. Fallback to empty fixed string
      nextBinding[input.key] = { source: 'fixed', value: '' }
    }
    setBinding(nextBinding)
  }

  async function handleRunPreflight() {
    if (!selectedDatasetId) return
    setErrorMsg(null)
    setPreflightPending(true)
    try {
      const res = await preflightDataset(selectedDatasetId, {
        scenarioInputs,
        binding,
      })
      setPreflightData(res)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '执行前置预检失败')
    } finally {
      setPreflightPending(false)
    }
  }

  function handleSubmit() {
    if (!scenarioDetail || !publishedVersion || !selectedDatasetId || !batchName.trim()) {
      setErrorMsg('请完善批次基本信息及场景版本')
      return
    }

    setErrorMsg(null)
    startTransition(async () => {
      try {
        const batch = await createBatch({
          name: batchName.trim(),
          scenarioId: scenarioDetail.id,
          scenarioVersionId: publishedVersion.versionId,
          datasetId: selectedDatasetId,
          binding,
          failurePolicy,
          failureThreshold,
          maxConcurrentSessions: maxConcurrency,
          pacing: { minDelayMs, maxDelayMs },
          resetPageBetweenItems: resetPage,
        })
        resetState()
        onOpenChange(false)
        onSuccess(batch.id)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : '创建自动化批次失败')
      }
    })
  }

  const sampleJitter = useMemo(
    () => computePacingJitter(minDelayMs, maxDelayMs),
    [minDelayMs, maxDelayMs]
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetState()
        onOpenChange(next)
      }}
    >
      <DialogContent className='max-w-3xl max-h-[90vh] flex flex-col'>
        <DialogHeader>
          <div className='flex items-center justify-between'>
            <DialogTitle className='flex items-center gap-2'>
              <Layers className='h-5 w-5 text-primary' />
              新建批量自动化运行 (Batch Automation)
            </DialogTitle>
            <div className='flex items-center gap-1.5 text-label text-muted-foreground mr-6'>
              <span className={step === 1 ? 'font-bold text-primary' : ''}>1. 场景</span>
              <ChevronRight className='h-3 w-3' />
              <span className={step === 2 ? 'font-bold text-primary' : ''}>2. 数据集</span>
              <ChevronRight className='h-3 w-3' />
              <span className={step === 3 ? 'font-bold text-primary' : ''}>3. 字段映射</span>
              <ChevronRight className='h-3 w-3' />
              <span className={step === 4 ? 'font-bold text-primary' : ''}>4. 预检与调度</span>
            </div>
          </div>
          <DialogDescription>
            使用多源数据绑定驱动高拟真场景批量并发执行，支持动态生成器及自适应防风控节奏保护。
          </DialogDescription>
        </DialogHeader>

        {errorMsg && (
          <div className='p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-label flex items-center gap-2'>
            <AlertCircle className='h-4 w-4 shrink-0' />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className='flex-1 overflow-y-auto space-y-4 pr-1 py-1'>
          {/* STEP 1: Scenario & Version */}
          {step === 1 && (
            <div className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='batch-create-name' className='text-label'>自动化批次名称</Label>
                <Input
                  id='batch-create-name'
                  className='h-8 text-label'
                  placeholder='例如: 2026Q3 批量开户联调压测'
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                />
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='batch-create-scenario' className='text-label'>选择目标场景</Label>
                <Select
                  value={selectedScenarioId}
                  onValueChange={(val) => {
                    setSelectedScenarioId(val)
                    setSelectedDatasetId('')
                    setBinding({})
                    setPreflightData(null)
                    const sc = scenariosQuery.data?.items.find((s) => s.id === val)
                    if (sc && !batchName) {
                      setBatchName(`批量运行 - ${sc.name}`)
                    }
                  }}
                >
                  <SelectTrigger id='batch-create-scenario' className='h-8 text-label'>
                    <SelectValue placeholder='选择要批量执行的场景' />
                  </SelectTrigger>
                  <SelectContent>
                    {scenariosQuery.data?.items.map((sc) => (
                      <SelectItem key={sc.id} value={sc.id}>
                        {sc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {scenarioDetail && (
                <div className='p-3 rounded-lg border bg-muted/20 space-y-2 text-label'>
                  <div className='flex items-center justify-between'>
                    <span className='text-muted-foreground'>场景已发布版本</span>
                    {publishedVersion ? (
                      <Badge variant='outline' className='text-primary border-primary/30'>
                        v{publishedVersion.versionNo}
                      </Badge>
                    ) : (
                      <Badge variant='destructive' className='text-3xs'>
                        尚未发布版本，请先发布场景
                      </Badge>
                    )}
                  </div>
                  <div className='flex items-center justify-between'>
                    <span className='text-muted-foreground'>输入参数声明数</span>
                    <span className='font-mono font-medium'>{scenarioInputs.length} 个参数</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2: Dataset */}
          {step === 2 && (
            <div className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='batch-create-dataset' className='text-label'>选择批量驱动数据集</Label>
                <Select
                  value={selectedDatasetId}
                  onValueChange={(val) => {
                    setSelectedDatasetId(val)
                    setPreflightData(null)
                  }}
                >
                  <SelectTrigger id='batch-create-dataset' className='h-8 text-label'>
                    <SelectValue placeholder='选择已导入的数据集' />
                  </SelectTrigger>
                  <SelectContent>
                    {datasetsQuery.data?.items.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name} ({d.rowCount} 行)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className='text-label text-muted-foreground'>
                  只列出该场景所属目标系统下的数据集。
                </p>
              </div>

              {selectedDataset && (
                <div className='p-3 rounded-lg border bg-muted/10 space-y-2 text-label'>
                  <div className='flex items-center justify-between'>
                    <span className='text-muted-foreground'>数据源文件</span>
                    <span className='font-mono'>{selectedDataset.sourceFilename}</span>
                  </div>
                  <div className='flex items-center justify-between'>
                    <span className='text-muted-foreground'>可用总行数</span>
                    <span className='font-mono font-bold'>{selectedDataset.rowCount} 行</span>
                  </div>
                  <div className='flex items-center justify-between'>
                    <span className='text-muted-foreground'>包含字段</span>
                    <div className='flex flex-wrap gap-1 max-w-sm justify-end'>
                      {selectedDataset.columns.map((c) => (
                        <Badge key={c.key} variant='outline' className='text-3xs'>
                          {c.name}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 3: Binding Workbench */}
          {step === 3 && (
            <div className='space-y-4'>
              <div className='flex items-center justify-between'>
                <div>
                  <h4 className='text-label font-semibold'>输入参数字段映射工作台</h4>
                  <p className='text-label text-muted-foreground'>
                    为场景中的每个入参指定来源：数据表列、动态 Mock 生成器或固定常量
                  </p>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={handleAutoMap}
                  className='h-7 text-label gap-1'
                >
                  <Sparkles className='h-3.5 w-3.5 text-primary' />
                  自动智能匹配
                </Button>
              </div>

              {scenarioInputs.length === 0 ? (
                <div className='p-6 text-center text-label text-muted-foreground border rounded-lg'>
                  该场景未声明任何输入参数，所有执行项将使用空上下文直接触发。
                </div>
              ) : (
                <div className='space-y-3 max-h-96 overflow-y-auto pr-1'>
                  {scenarioInputs.map((input) => {
                    const rule: DataBindingRule = binding[input.key] ?? (
                      input.defaultGenerator
                        ? { source: 'generator', spec: input.defaultGenerator }
                        : { source: 'column', columnName: selectedDataset?.columns[0]?.name ?? '' }
                    )

                    return (
                      <div
                        key={input.key}
                        className='p-3 border rounded-lg bg-card space-y-2.5 text-label'
                      >
                        <div className='flex items-center justify-between'>
                          <div className='flex items-center gap-2'>
                            <span className='font-semibold'>{input.label}</span>
                            <span className='text-muted-foreground font-mono text-label'>
                              ({input.key})
                            </span>
                            <Badge variant='outline' className='text-3xs'>
                              {input.type ?? 'string'}
                            </Badge>
                          </div>
                          <Select
                            value={rule.source}
                            onValueChange={(val: 'column' | 'generator' | 'fixed') => {
                              if (val === 'column') {
                                setBinding({
                                  ...binding,
                                  [input.key]: {
                                    source: 'column',
                                    columnName: selectedDataset?.columns[0]?.name ?? '',
                                  },
                                })
                              } else if (val === 'generator') {
                                setBinding({
                                  ...binding,
                                  [input.key]: {
                                    source: 'generator',
                                    spec: input.defaultGenerator ?? {
                                      kind: 'mock_preset',
                                      preset: 'phone_cn',
                                      unique: true,
                                    },
                                  },
                                })
                              } else {
                                setBinding({
                                  ...binding,
                                  [input.key]: { source: 'fixed', value: '' },
                                })
                              }
                            }}
                          >
                            <SelectTrigger className='h-7 w-32 text-label' aria-label={`${input.label} 来源`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value='column'>数据表列</SelectItem>
                              <SelectItem value='generator'>动态生成器</SelectItem>
                              <SelectItem value='fixed'>固定常量</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {rule.source === 'column' && (
                          <div className='flex items-center gap-2 pt-1'>
                            <Label className='text-label text-muted-foreground whitespace-nowrap'>
                              对应列名:
                            </Label>
                            <Select
                              value={rule.columnName}
                              onValueChange={(colName) =>
                                setBinding({
                                  ...binding,
                                  [input.key]: { source: 'column', columnName: colName },
                                })
                              }
                            >
                              <SelectTrigger className='h-7 text-label' aria-label={`${input.label} 对应列名`}>
                                <SelectValue placeholder='选择对应列' />
                              </SelectTrigger>
                              <SelectContent>
                                {selectedDataset?.columns.map((c) => (
                                  <SelectItem key={c.key} value={c.name}>
                                    {c.name} ({c.type})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {rule.source === 'fixed' && (
                          <div className='flex items-center gap-2 pt-1'>
                            <Label className='text-label text-muted-foreground whitespace-nowrap'>
                              固定输入值:
                            </Label>
                            <Input
                              className='h-7 text-label'
                              aria-label={`${input.label} 固定输入值`}
                              value={String(rule.value ?? '')}
                              placeholder='填入固定参数值'
                              onChange={(e) =>
                                setBinding({
                                  ...binding,
                                  [input.key]: { source: 'fixed', value: e.target.value },
                                })
                              }
                            />
                          </div>
                        )}

                        {rule.source === 'generator' && (
                          <GeneratorConfigEditor
                            generator={rule.spec}
                            onChange={(spec) => {
                              if (spec) {
                                setBinding({
                                  ...binding,
                                  [input.key]: { source: 'generator', spec },
                                })
                              }
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* STEP 4: Preflight & Pacing */}
          {step === 4 && (
            <div className='space-y-4'>
              {/* Preflight Check Card */}
              <div className='p-3.5 rounded-lg border bg-card space-y-3'>
                <div className='flex items-center justify-between'>
                  <div>
                    <h4 className='text-label font-semibold'>数据前置预检 (Preflight)</h4>
                    <p className='text-label text-muted-foreground'>
                      模拟对所选数据集执行全量类型校验与必填规则诊断
                    </p>
                  </div>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={preflightPending}
                    onClick={handleRunPreflight}
                    className='h-7 text-label'
                  >
                    {preflightPending ? '正在校验...' : '执行预检'}
                  </Button>
                </div>

                {preflightData && (
                  <div className='space-y-2 pt-1'>
                    <div className='grid grid-cols-4 gap-2 text-center text-label'>
                      <div className='p-2 rounded bg-muted/30'>
                        <div className='text-muted-foreground text-3xs'>预检总行数</div>
                        <div className='font-mono font-bold'>{preflightData.totalRows}</div>
                      </div>
                      <div className='p-2 rounded bg-status-success-background text-status-success-foreground'>
                        <div className='text-3xs'>有效行</div>
                        <div className='font-mono font-bold'>{preflightData.validCount}</div>
                      </div>
                      <div className='p-2 rounded bg-status-warning-background text-status-warning-foreground'>
                        <div className='text-3xs'>警告行</div>
                        <div className='font-mono font-bold'>{preflightData.warningCount}</div>
                      </div>
                      <div className='p-2 rounded bg-destructive/10 text-destructive'>
                        <div className='text-3xs'>阻断错误行</div>
                        <div className='font-mono font-bold'>{preflightData.errorCount}</div>
                      </div>
                    </div>

                    {preflightData.issues.length > 0 && (
                      <div className='p-2 rounded bg-muted/20 border max-h-28 overflow-y-auto text-label space-y-1 font-mono'>
                        {preflightData.issues.slice(0, 10).map((issue, idx) => (
                          <div
                            key={idx}
                            className={
                              issue.severity === 'error'
                                ? 'text-destructive flex items-center gap-1.5'
                                : 'text-status-warning-foreground flex items-center gap-1.5'
                            }
                          >
                            <span>第 {issue.rowIndex + 1} 行 [{issue.fieldKey}]:</span>
                            <span>{issue.message}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Execution Pacing & Circuit Breaker */}
              <div className='p-3.5 rounded-lg border bg-card space-y-3.5 text-label'>
                <h4 className='font-semibold flex items-center gap-1.5'>
                  <Sliders className='h-4 w-4 text-primary' />
                  调度并发与防风控节奏控制
                </h4>

                <div className='grid grid-cols-2 gap-3'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='batch-create-concurrency' className='text-label'>最大并发会话数 (1 ~ 10)</Label>
                    <Input
                      id='batch-create-concurrency'
                      type='number'
                      min={1}
                      max={10}
                      className='h-8 text-label'
                      value={maxConcurrency}
                      onChange={(e) => setMaxConcurrency(Number(e.target.value))}
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='batch-create-failure-policy' className='text-label'>失败策略</Label>
                    <Select
                      value={failurePolicy}
                      onValueChange={(val: 'continue' | 'stop_on_first' | 'stop_on_threshold') => setFailurePolicy(val)}
                    >
                      <SelectTrigger id='batch-create-failure-policy' className='h-8 text-label'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='stop_on_threshold'>连续 Target 故障自动熔断</SelectItem>
                        <SelectItem value='stop_on_first'>首个失败立即终止</SelectItem>
                        <SelectItem value='continue'>忽略失败继续执行全部</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {failurePolicy === 'stop_on_threshold' && (
                  <div className='space-y-1.5'>
                    <Label htmlFor='batch-create-failure-threshold' className='text-label'>熔断阈值（连续 Target 故障达到此数量自动暂停批次）</Label>
                    <Input
                      id='batch-create-failure-threshold'
                      type='number'
                      min={1}
                      max={50}
                      className='h-8 text-label'
                      value={failureThreshold}
                      onChange={(e) => setFailureThreshold(Number(e.target.value))}
                    />
                  </div>
                )}

                <div className='grid grid-cols-2 gap-3'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='batch-create-min-delay' className='text-label'>最小行间延迟 (毫秒)</Label>
                    <Input
                      id='batch-create-min-delay'
                      type='number'
                      min={0}
                      step={500}
                      className='h-8 text-label'
                      value={minDelayMs}
                      onChange={(e) => setMinDelayMs(Number(e.target.value))}
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='batch-create-max-delay' className='text-label'>最大行间延迟 (毫秒)</Label>
                    <Input
                      id='batch-create-max-delay'
                      type='number'
                      min={0}
                      step={500}
                      className='h-8 text-label'
                      value={maxDelayMs}
                      onChange={(e) => setMaxDelayMs(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className='text-label text-muted-foreground font-mono flex items-center justify-between p-2 rounded bg-muted/20'>
                  <span>随机延迟抖动预览：每次执行将随机休眠 ~{(sampleJitter / 1000).toFixed(1)} 秒</span>
                  <Badge variant='outline' className='text-3xs'>防风控保护</Badge>
                </div>

                <div className='flex items-center justify-between pt-1 border-t'>
                  <div className='space-y-0.5'>
                    <Label htmlFor='batch-create-reset-page' className='text-label'>单项执行后自动重置页面</Label>
                    <p className='text-label text-muted-foreground'>
                      每行测试执行完毕后自动返回起始 URL 并关闭弹窗阻断，确保下一行干净执行
                    </p>
                  </div>
                  <Switch id='batch-create-reset-page' checked={resetPage} onCheckedChange={setResetPage} />
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className='pt-3 border-t flex justify-between sm:justify-between items-center'>
          <div>
            {step > 1 && (
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={() => setStep((s) => s === 4 ? 3 : s === 3 ? 2 : 1)}
                disabled={isSubmitting}
              >
                上一步
              </Button>
            )}
          </div>
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              取消
            </Button>
            {step < 4 ? (
              <Button
                type='button'
                size='sm'
                disabled={
                  (step === 1 && (!scenarioDetail || !publishedVersion || !batchName.trim())) ||
                  (step === 2 && !selectedDatasetId)
                }
                onClick={() => {
                  if (step === 2 && Object.keys(binding).length === 0) {
                    handleAutoMap()
                  }
                  setStep((s) => s === 1 ? 2 : s === 2 ? 3 : 4)
                }}
              >
                下一步
                <ChevronRight className='h-4 w-4 ml-1' />
              </Button>
            ) : (
              <Button
                type='button'
                size='sm'
                disabled={isSubmitting || !batchName.trim()}
                onClick={handleSubmit}
              >
                <Play className='h-4 w-4 mr-1 fill-current' />
                {isSubmitting ? '正在创建...' : '启动批量运行'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
