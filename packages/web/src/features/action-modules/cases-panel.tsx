import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Layers,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react'
import { canonicalJson, type ActionModuleDetail, type JsonValue } from '@cairn/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  createModuleTestBatch,
  createModuleTestCase,
  deleteModuleTestCase,
  fetchModuleTestCases,
  runModuleTestCase,
  type ModuleTestCaseListItem,
} from '@/lib/action-modules-api'
import { TrialRunSheet } from './trial-run-sheet'

interface ActionModuleCasesPanelProps {
  module: ActionModuleDetail
  canWrite: boolean
  canExecute: boolean
}

async function sha256Hex(value: unknown): Promise<string> {
  const json = canonicalJson(value)
  const encoded = new TextEncoder().encode(json)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function ActionModuleCasesPanel({
  module,
  canWrite,
  canExecute,
}: ActionModuleCasesPanelProps) {
  const queryClient = useQueryClient()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [trialSheetOpen, setTrialSheetOpen] = useState(false)

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([])
  const [confirmedEnv, setConfirmedEnv] = useState(false)

  // Form states for creating test case
  const [caseName, setCaseName] = useState('')
  const [implKey, setImplKey] = useState(
    module.draftContent?.implementations[0]?.implementationKey ?? 'default',
  )
  const [inputsJson, setInputsJson] = useState('{}')
  const [expectedOutcome, setExpectedOutcome] = useState('VERIFIED')
  const [expectedFailureCode, setExpectedFailureCode] = useState('')
  const [expectedOutputsJson, setExpectedOutputsJson] = useState('{}')
  const [releaseGate, setReleaseGate] = useState(true)
  const [sampleConfirmed, setSampleConfirmed] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['module-test-cases', module.id],
    queryFn: () => fetchModuleTestCases(module.id),
  })

  const cases = data?.items ?? []

  // Run single test case mutation
  const runMutation = useMutation({
    mutationFn: (caseId: string) => runModuleTestCase(module.id, caseId),
    onSuccess: (res) => {
      setSelectedRunId(res.runId)
      setTrialSheetOpen(true)
      void queryClient.invalidateQueries({ queryKey: ['module-test-cases', module.id] })
    },
  })

  // Delete test case mutation
  const deleteMutation = useMutation({
    mutationFn: (caseId: string) => deleteModuleTestCase(module.id, caseId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['module-test-cases', module.id] })
    },
  })

  // Create test case mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      setJsonError(null)
      let parsedInputs: Record<string, JsonValue>
      let parsedOutputs: Record<string, JsonValue>
      try {
        parsedInputs = JSON.parse(inputsJson)
      } catch (err) {
        setJsonError(`输入 JSON 格式错误: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
      try {
        parsedOutputs = JSON.parse(expectedOutputsJson)
      } catch (err) {
        setJsonError(`预期输出 JSON 格式错误: ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }

      const inputsDigest = await sha256Hex(parsedInputs)
      const outputsDigest = await sha256Hex(parsedOutputs)

      return createModuleTestCase(module.id, {
        name: caseName.trim(),
        implementationKey: implKey,
        inputs: parsedInputs,
        expectedModuleOutcome: expectedOutcome,
        expectedFailureCode: expectedFailureCode.trim() || undefined,
        expectedOutputs: parsedOutputs,
        releaseGate,
        sampleReview: {
          reviewedBy: 'current-user',
          reviewedAt: new Date().toISOString(),
          inputsDigest,
          outputsDigest,
          confirmed: sampleConfirmed,
        },
      })
    },
    onSuccess: () => {
      setCreateDialogOpen(false)
      resetCreateForm()
      void queryClient.invalidateQueries({ queryKey: ['module-test-cases', module.id] })
    },
  })

  // Batch regression mutation
  const batchMutation = useMutation({
    mutationFn: () =>
      createModuleTestBatch(module.id, {
        caseIds: selectedCaseIds,
        confirmedEnv: true,
      }),
    onSuccess: () => {
      setBatchDialogOpen(false)
      setSelectedCaseIds([])
      void queryClient.invalidateQueries({ queryKey: ['module-test-cases', module.id] })
    },
  })

  const resetCreateForm = () => {
    setCaseName('')
    setInputsJson('{}')
    setExpectedOutputsJson('{}')
    setExpectedOutcome('VERIFIED')
    setExpectedFailureCode('')
    setReleaseGate(true)
    setSampleConfirmed(false)
    setJsonError(null)
  }

  const toggleSelectCase = (id: string) => {
    setSelectedCaseIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : prev.length < 20 ? [...prev, id] : prev,
    )
  }

  const selectAllCases = () => {
    if (selectedCaseIds.length === cases.length) {
      setSelectedCaseIds([])
    } else {
      setSelectedCaseIds(cases.slice(0, 20).map((c) => c.id))
    }
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div>
          <h3 className='text-title font-semibold'>回归测试用例 (AMR-04 ~ AMR-10)</h3>
          <p className='text-small text-muted-foreground'>
            管理动作模块在不同实现与入参下的预期行为，发布前须至少有 1 个正向通过用例作为可信门禁凭据。
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => refetch()}
            disabled={isLoading}
            className='gap-1.5'
          >
            <RefreshCw className={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
          {canExecute && cases.length > 0 && (
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                setConfirmedEnv(false)
                setBatchDialogOpen(true)
              }}
              className='gap-1.5'
            >
              <Layers className='size-3.5 text-primary' />
              批量回归 ({selectedCaseIds.length > 0 ? selectedCaseIds.length : '全部'})
            </Button>
          )}
          {canWrite && (
            <Button
              size='sm'
              onClick={() => setCreateDialogOpen(true)}
              className='gap-1.5'
            >
              <Plus className='size-3.5' />
              新建测试用例
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className='py-12 text-center text-small text-muted-foreground'>正在加载用例列表…</div>
      ) : cases.length === 0 ? (
        <Card className='border-dashed'>
          <CardContent className='flex flex-col items-center justify-center py-12 text-center'>
            <ShieldCheck className='size-10 text-muted-foreground/50' />
            <h4 className='mt-3 text-small font-medium'>暂无测试用例</h4>
            <p className='mt-1 max-w-sm text-label text-muted-foreground'>
              发布模块前，请先为每个实现配置并跑通至少一条正向测试用例以满足发布门禁要求。
            </p>
            {canWrite && (
              <Button
                variant='outline'
                size='sm'
                className='mt-4 gap-1.5'
                onClick={() => setCreateDialogOpen(true)}
              >
                <Plus className='size-3.5' />
                添加第一条用例
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className='space-y-3'>
          {cases.map((c) => (
            <CaseCard
              key={c.id}
              testCase={c}
              canExecute={canExecute}
              canWrite={canWrite}
              isSelected={selectedCaseIds.includes(c.id)}
              onToggleSelect={() => toggleSelectCase(c.id)}
              onRun={() => runMutation.mutate(c.id)}
              onDelete={() => deleteMutation.mutate(c.id)}
              isRunning={runMutation.isPending && runMutation.variables === c.id}
            />
          ))}
        </div>
      )}

      {/* 新建用例对话框 */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className='max-w-xl max-h-[90vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>新建回归测试用例</DialogTitle>
            <DialogDescription>
              定义预期执行结果与输出断言。测试用例将参与发布门禁核验与批量回归。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4 py-2'>
            <div className='space-y-1.5'>
              <Label htmlFor='case-name'>用例名称 *</Label>
              <Input
                id='case-name'
                value={caseName}
                onChange={(e) => setCaseName(e.target.value)}
                placeholder='例如：正常查询待发货订单状态'
              />
            </div>

            <div className='grid grid-cols-2 gap-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='impl-select'>目标实现 *</Label>
                <Select value={implKey} onValueChange={setImplKey}>
                  <SelectTrigger id='impl-select'>
                    <SelectValue placeholder='选择实现' />
                  </SelectTrigger>
                  <SelectContent>
                    {(module.draftContent?.implementations ?? []).map((impl) => (
                      <SelectItem key={impl.implementationKey} value={impl.implementationKey}>
                        {impl.implementationKey}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='outcome-select'>预期 Outcome *</Label>
                <Select value={expectedOutcome} onValueChange={setExpectedOutcome}>
                  <SelectTrigger id='outcome-select'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='VERIFIED'>VERIFIED (正向成功)</SelectItem>
                    <SelectItem value='FAILED_PRECONDITION'>FAILED_PRECONDITION (前置校验失败)</SelectItem>
                    <SelectItem value='FAILED_VERIFICATION'>FAILED_VERIFICATION (后置校验失败)</SelectItem>
                    <SelectItem value='FAILED_IMPLEMENTATION'>FAILED_IMPLEMENTATION (实现执行失败)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {expectedOutcome !== 'VERIFIED' && (
              <div className='space-y-1.5'>
                <Label htmlFor='expected-failure-code'>预期错误码 (可选)</Label>
                <Input
                  id='expected-failure-code'
                  value={expectedFailureCode}
                  onChange={(e) => setExpectedFailureCode(e.target.value)}
                  placeholder='例如：STEP_TIMEOUT'
                />
              </div>
            )}

            <div className='space-y-1.5'>
              <Label htmlFor='case-inputs'>测试入参 (JSON 键值对)</Label>
              <Textarea
                id='case-inputs'
                rows={3}
                className='font-mono text-label'
                value={inputsJson}
                onChange={(e) => setInputsJson(e.target.value)}
                placeholder='{"orderId": "ORD-12345"}'
              />
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='case-outputs'>预期输出字段 (JSON 键值对)</Label>
              <Textarea
                id='case-outputs'
                rows={3}
                className='font-mono text-label'
                value={expectedOutputsJson}
                onChange={(e) => setExpectedOutputsJson(e.target.value)}
                placeholder='{"orderStatus": "SHIPPED"}'
              />
            </div>

            <div className='flex items-center space-x-2 pt-1'>
              <Checkbox
                id='release-gate'
                checked={releaseGate}
                onCheckedChange={(c) => setReleaseGate(Boolean(c))}
              />
              <Label htmlFor='release-gate' className='text-label font-medium cursor-pointer'>
                纳入发布门禁 (Release Gate) - 正向通过后方允许发布新模块版本
              </Label>
            </div>

            <div className='rounded-lg border border-status-warning-foreground/20 bg-status-warning-background p-3 space-y-2'>
              <div className='flex items-start gap-2'>
                <Checkbox
                  id='sample-confirm'
                  checked={sampleConfirmed}
                  onCheckedChange={(c) => setSampleConfirmed(Boolean(c))}
                  className='mt-0.5'
                />
                <Label htmlFor='sample-confirm' className='text-label text-muted-foreground cursor-pointer leading-relaxed'>
                  <span className='font-semibold text-foreground'>非敏感样本审阅凭据确认：</span>
                  我已核实上述入参与预期输出不包含未脱敏生产密码、凭证等高敏感数据，同意计算 SHA-256 摘要并保存为不可变快照。
                </Label>
              </div>
            </div>

            {jsonError && (
              <div className='rounded border border-destructive/30 bg-destructive/10 p-2.5 text-label text-destructive'>
                {jsonError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setCreateDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!caseName.trim() || !sampleConfirmed || createMutation.isPending}
            >
              {createMutation.isPending ? '创建中…' : '创建用例'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 批量回归对话框 (AMR-06) */}
      <Dialog open={batchDialogOpen} onOpenChange={setBatchDialogOpen}>
        <DialogContent className='max-w-md'>
          <DialogHeader>
            <DialogTitle>发起批量回归 (AMR-06)</DialogTitle>
            <DialogDescription>
              首批支持最多 20 条测试用例聚合执行。执行过程遵循会话租约与并发隔离约束。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4 py-2 text-small'>
            <div className='flex items-center justify-between text-label text-muted-foreground'>
              <span>
                已选择用例: <strong>{selectedCaseIds.length > 0 ? selectedCaseIds.length : cases.length}</strong> / 20 条
              </span>
              <Button
                variant='ghost'
                size='sm'
                className='h-6 px-1.5 text-label'
                onClick={selectAllCases}
              >
                {selectedCaseIds.length === cases.length ? '取消全选' : '全选用例'}
              </Button>
            </div>

            <div className='rounded-lg border border-border bg-muted/40 p-3 space-y-2.5 text-label text-muted-foreground'>
              <p className='font-medium text-foreground'>环境与租约说明：</p>
              <ul className='list-disc pl-4 space-y-1'>
                <li>批次复用现有 Run 调度执行，同账号遵守会话占用约束与并发限制。</li>
                <li>若执行遇到未知副作用或 NEEDS_REVIEW 异常，作业将立即自动停派。</li>
              </ul>
            </div>

            <div className='rounded-lg border border-primary/20 bg-primary/5 p-3'>
              <div className='flex items-start gap-2'>
                <Checkbox
                  id='confirm-env'
                  checked={confirmedEnv}
                  onCheckedChange={(c) => setConfirmedEnv(Boolean(c))}
                  className='mt-0.5'
                />
                <Label htmlFor='confirm-env' className='text-label font-medium cursor-pointer leading-relaxed'>
                  我已明确核实并确认当前 Target 的测试环境范围与测试账号，认可本次批量执行。
                </Label>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setBatchDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => batchMutation.mutate()}
              disabled={!confirmedEnv || batchMutation.isPending}
            >
              {batchMutation.isPending ? '提交中…' : '确认并发起回归'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 试跑原地观测抽屉 */}
      <TrialRunSheet
        runId={selectedRunId}
        open={trialSheetOpen}
        onOpenChange={setTrialSheetOpen}
        moduleRevisionInfo={{
          draftRevision: module.draftRevision,
          versionNo: module.latestVersionNo,
          isDirty: false,
        }}
      />
    </div>
  )
}

function CaseCard({
  testCase,
  canExecute,
  canWrite,
  isSelected,
  onToggleSelect,
  onRun,
  onDelete,
  isRunning,
}: {
  testCase: ModuleTestCaseListItem
  canExecute: boolean
  canWrite: boolean
  isSelected: boolean
  onToggleSelect: () => void
  onRun: () => void
  onDelete: () => void
  isRunning: boolean
}) {
  const result = testCase.latestResult

  return (
    <Card className='transition-colors hover:border-primary/30'>
      <CardHeader className='p-4 pb-2'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2.5 min-w-0'>
            <Checkbox checked={isSelected} onCheckedChange={onToggleSelect} />
            <span className='font-medium truncate'>{testCase.name}</span>
            <Badge variant='outline' className='font-mono text-label'>
              {testCase.implementationKey}
            </Badge>
            {testCase.releaseGate && (
              <Badge variant='secondary' className='text-label bg-primary/10 text-primary'>
                发布门禁
              </Badge>
            )}
            {testCase.status === 'INCOMPATIBLE' && (
              <Badge variant='outline' className='border-status-warning-foreground/30 bg-status-warning-background text-status-warning-foreground text-label gap-1'>
                <AlertTriangle className='size-3' />
                契约不兼容
              </Badge>
            )}
          </div>

          <div className='flex items-center gap-2 shrink-0'>
            {result ? (
              <ResultBadge status={result.status} />
            ) : (
              <Badge variant='outline' className='text-label text-muted-foreground'>
                未执行
              </Badge>
            )}

            {canExecute && (
              <Button
                variant='outline'
                size='sm'
                onClick={onRun}
                disabled={isRunning}
                className='h-7 gap-1 text-label'
              >
                <Play className={`size-3 ${isRunning ? 'animate-spin' : ''}`} />
                {isRunning ? '执行中' : '运行'}
              </Button>
            )}

            {canWrite && (
              <Button
                variant='ghost'
                size='sm'
                onClick={onDelete}
                className='h-7 w-7 p-0 text-muted-foreground hover:text-destructive'
              >
                <Trash2 className='size-3.5' />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className='p-4 pt-1 text-label text-muted-foreground space-y-1.5'>
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1'>
          <span>
            预期 Outcome: <code className='text-foreground'>{testCase.expectedModuleOutcome}</code>
          </span>
          {testCase.expectedFailureCode && (
            <span>
              预期错误码: <code className='text-foreground'>{testCase.expectedFailureCode}</code>
            </span>
          )}
          <span>
            修约定编号: <span className='font-mono'>r{testCase.revision}</span>
          </span>
          {result?.settledAt && (
            <span>
              最近结算: {new Date(result.settledAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {result && result.status === 'FAIL' && result.failureReason && (
          <div className='rounded bg-destructive/10 p-2 text-destructive font-mono'>
            {result.failureReason}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ResultBadge({ status }: { status: string }) {
  switch (status) {
    case 'PASS':
      return (
        <Badge variant='outline' className='border-status-success-accent bg-status-success-background text-status-success-foreground font-medium gap-1'>
          <CheckCircle2 className='size-3' />
          PASS
        </Badge>
      )
    case 'FAIL':
      return (
        <Badge variant='outline' className='border-destructive/30 bg-destructive/10 text-destructive font-medium gap-1'>
          <XCircle className='size-3' />
          FAIL
        </Badge>
      )
    case 'PENDING':
      return (
        <Badge variant='outline' className='border-primary/30 bg-primary/10 text-primary font-medium gap-1'>
          <Clock className='size-3 animate-pulse' />
          PENDING
        </Badge>
      )
    case 'INCONCLUSIVE':
      return (
        <Badge variant='outline' className='border-status-warning-foreground/30 bg-status-warning-background text-status-warning-foreground font-medium gap-1'>
          <AlertTriangle className='size-3' />
          INCONCLUSIVE
        </Badge>
      )
    default:
      return <Badge variant='outline'>{status}</Badge>
  }
}
