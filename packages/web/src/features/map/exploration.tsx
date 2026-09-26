import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Compass,
  Play,
  Search,
  ShieldAlert,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ExploreDiscovery } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import {
  createExploration,
  fetchExplorationPolicy,
  fetchMapJob,
  fetchMapSafeEntries,
  fetchExploreCandidates,
  previewExploration,
  reviewExploreCandidate,
  reviewUnknownExploreJob,
  runExploreCandidate,
  updateExplorationPolicy,
} from '@/lib/map-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { StatusBadge } from '@/components/status-badge'
import { MAP_ACCOUNT_REQUIRED, mapCapableAccounts } from './map-accounts'

export function ExplorationCard({ targetId }: { targetId: string }) {
  const canRead = useCan('map:read')
  const canExplore = useCan('map:explore')
  const canMaintain = useCan('map:maintain')
  const canWrite = canExplore && canMaintain
  const queryClient = useQueryClient()
  const [origin, setOrigin] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [accountId, setAccountId] = useState('')
  const [entryId, setEntryId] = useState('')
  const [inspectJobId, setInspectJobId] = useState('')
  const [candidateTab, setCandidateTab] = useState<'known_links' | 'reveal' | 'opaque' | 'rejected' | 'incomplete'>('known_links')

  const configQuery = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
    enabled: canRead,
  })

  const policyQuery = useQuery({
    queryKey: ['map', targetId, 'exploration-policy'],
    queryFn: () => fetchExplorationPolicy(targetId),
    enabled: canRead,
  })

  const entriesQuery = useQuery({
    queryKey: ['map', targetId, 'safe-entries'],
    queryFn: () => fetchMapSafeEntries(targetId),
    enabled: canRead,
  })

  const accountsQuery = useQuery({
    queryKey: ['target', targetId, 'accounts', 'explore'],
    queryFn: () =>
      fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: canWrite,
  })

  const policyMutation = useMutation({
    mutationFn: (exploreEnabled: boolean) =>
      updateExplorationPolicy(targetId, {
        expectedRevision: policyQuery.data?.revision ?? 0,
        idempotencyKey: `explore-policy:${Date.now()}`,
        exploreEnabled,
        mode: policyQuery.data?.policy.mode ?? 'allowlist',
        modelEnabled: false,
        allowlist: origin.trim()
          ? [
              {
                origin: origin.trim(),
                ...(pathPrefix.trim() ? { pathPrefix: pathPrefix.trim() } : {}),
              },
            ]
          : (policyQuery.data?.policy.allowlist ?? []),
        seedRefs: policyQuery.data?.policy.seedRefs ?? [],
        reason: exploreEnabled ? '控制台开启有界探索' : '控制台关闭有界探索',
      }),
    onSuccess: (result) => {
      toast.success(result.policy.exploreEnabled ? '已开启有界探索' : '已关闭有界探索')
      void queryClient.invalidateQueries({
        queryKey: ['map', targetId, 'exploration-policy'],
      })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '更新探索配置失败'
      )
    },
  })

  const previewMutation = useMutation({
    mutationFn: () =>
      previewExploration(targetId, {
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs: [],
      }),
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '预览探索失败'
      )
    },
  })

  const createMutation = useMutation({
    mutationFn: () =>
      createExploration(targetId, {
        manualId: `explore-${Date.now()}`,
        expectedExplorationRevision: policyQuery.data?.revision ?? 0,
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs: [],
      }),
    onSuccess: (result) => {
      toast.success(result.created ? '已创建探索作业' : '已返回相同作业')
      setInspectJobId(result.job.jobId)
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '创建探索作业失败'
      )
    },
  })

  const activeJobId = inspectJobId || createMutation.data?.job.jobId || ''

  const candidatesQuery = useQuery({
    queryKey: ['map', targetId, 'explorations', activeJobId, 'candidates'],
    queryFn: () => fetchExploreCandidates(targetId, activeJobId),
    enabled: Boolean(canRead && activeJobId),
    refetchInterval: 3000,
  })

  const jobQuery = useQuery({
    queryKey: ['map-job', activeJobId],
    queryFn: () => fetchMapJob(activeJobId),
    enabled: Boolean(canRead && activeJobId),
    refetchInterval: 3000,
  })

  const candidateReviewMutation = useMutation({
    mutationFn: ({
      candidateId,
      decision,
      actionCategory,
    }: {
      candidateId: string
      decision: 'approved' | 'rejected'
      actionCategory: 'reveal' | 'direct_url_open' | 'ui_activate'
    }) =>
      reviewExploreCandidate(targetId, activeJobId, candidateId, {
        expectedRevision: 0,
        idempotencyKey: `cand-rev:${Date.now()}:${candidateId.slice(0, 8)}`,
        decision,
        actionCategory,
        securityBasis: decision === 'approved' ? '控制台人工审核批准单跳动作' : '控制台人工拒绝候选控件',
        requestEnvelope: [],
        validDurationHours: 24,
      }),
    onSuccess: (res) => {
      toast.success(res.decision === 'approved' ? '候选已审核批准' : '候选已拒绝')
      void queryClient.invalidateQueries({
        queryKey: ['map', targetId, 'explorations', activeJobId, 'candidates'],
      })
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : '候选审核失败')
    },
  })

  const runCandidateMutation = useMutation({
    mutationFn: (candidateId: string) =>
      runExploreCandidate(targetId, activeJobId, candidateId, {
        expectedReviewRevision: 0,
        idempotencyKey: `run-cand:${Date.now()}:${candidateId.slice(0, 8)}`,
      }),
    onSuccess: (res) => {
      toast.success('已触发受控单跳探索作业')
      setInspectJobId(res.job.jobId)
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : '启动单跳探索失败')
    },
  })

  const reviewUnknownMutation = useMutation({
    mutationFn: (decision: 'failed' | 'cancelled') =>
      reviewUnknownExploreJob(targetId, activeJobId, {
        decision,
        reason: '控制台人工审查未知结果判定',
      }),
    onSuccess: (res) => {
      toast.success(`作业已判定为 ${res.status}`)
      void queryClient.invalidateQueries({ queryKey: ['map-job', activeJobId] })
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : '未知审查失败')
    },
  })

  const candidateItems = candidatesQuery.data?.items ?? []
  const knownLinks = candidateItems.filter((c) => !c.rejectionReason && c.evidenceStatus === 'complete' && c.candidateCategory === 'explicit_url')
  const revealControls = candidateItems.filter((c) => !c.rejectionReason && c.evidenceStatus === 'complete' && c.candidateCategory === 'reveal')
  const opaqueMenus = candidateItems.filter((c) => !c.rejectionReason && c.evidenceStatus === 'complete' && c.candidateCategory === 'opaque_navigation')
  const rejectedCandidates = candidateItems.filter((c) => Boolean(c.rejectionReason) || c.status === 'rejected')
  const incompleteCandidates = candidateItems.filter((c) => c.evidenceStatus !== 'complete' && !c.rejectionReason && c.status !== 'rejected')

  if (!canRead) return null
  const factoryOn = configQuery.data?.document.mapExplorationEnabled === true
  const enabled = policyQuery.data?.policy.exploreEnabled === true
  const entries = (entriesQuery.data?.items ?? []).filter((entry) =>
    entry.jobKinds.includes('map_explore')
  )
  const accounts = mapCapableAccounts(accountsQuery.data?.items ?? [])

  return (
    <section className='space-y-3.5 rounded-xl border border-border-card bg-surface p-4 shadow-card'>
      {/* 头部：标题、状态与直接开关 */}
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-card pb-3'>
        <div className='space-y-0.5'>
          <div className='flex items-center gap-2'>
            <Compass className='size-5 text-link shrink-0' />
            <h2 className='text-section font-semibold text-text-primary'>有界探索</h2>
            <div className='flex items-center gap-1.5'>
              <StatusBadge tone={factoryOn ? 'info' : 'neutral'}>
                平台全局：{factoryOn ? '已启用' : '已关闭'}
              </StatusBadge>
              <StatusBadge tone={enabled ? 'success' : 'neutral'}>
                目标系统：{enabled ? '已开放' : '已关闭'}
              </StatusBadge>
            </div>
          </div>
          <p className='text-caption text-text-muted'>
            导航线索扫描 / 审核一步 / 继续扫描。出厂默认关闭，仅在严格限定的域名与路径前缀下进行只读线索扫描，发现新页面与地标。扫描发现的候选线索需经人工审查方可单跳试跑，绝不自动提拔为正式地图资产。
          </p>
          <p className='sr-only'>
            当前：{factoryOn ? '平台已开放' : '平台关闭'} ·{' '}
            {enabled ? '该目标已开放' : '该目标关闭'}
          </p>
        </div>

        {canWrite ? (
          <div className='flex items-center gap-2 shrink-0'>
            <Label
              htmlFor='explore-switch'
              className='text-caption font-medium text-text-primary cursor-pointer'
            >
              {enabled ? '探索已开启' : '开启探索'}
            </Label>
            <Switch
              id='explore-switch'
              aria-label='开放探索'
              checked={enabled}
              disabled={policyMutation.isPending || !factoryOn}
              onCheckedChange={(val) => policyMutation.mutate(val)}
            />
          </div>
        ) : null}
      </div>

      {policyQuery.isPending ? (
        <p className='py-3 text-center text-caption text-text-muted'>探索配置加载中…</p>
      ) : policyQuery.isError ? (
        <div className='rounded-lg border border-border-danger bg-status-danger-subtle p-3 text-caption text-status-danger-foreground'>
          暂时无法读取探索配置：{policyQuery.error?.message}
        </div>
      ) : (
        <div className='space-y-3'>
          {(!factoryOn || !enabled) && (
            <Alert className='py-2'>
              <AlertCircle className='size-4' />
              <AlertDescription className='text-caption'>
                {!factoryOn
                  ? '平台全局尚未启用探索功能。'
                  : '当前目标系统的探索处于关闭状态。可点击右上方开关开启。'}
              </AlertDescription>
            </Alert>
          )}

          {!canWrite ? (
            <p className='text-caption text-text-muted'>
              需要探索和维护权限才能触发探索。
            </p>
          ) : (
            <>
              {/* 紧凑白名单与触发控制网格 */}
              <div className='rounded-lg border border-border-card bg-surface-subtle p-3 space-y-3'>
                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                  <div className='space-y-1'>
                    <Label htmlFor='explore-origin' className='text-caption font-medium'>
                      白名单域名 (Origin)
                    </Label>
                    <Input
                      id='explore-origin'
                      value={origin}
                      onChange={(event) => setOrigin(event.target.value)}
                      placeholder='https://shop.example.com'
                      className='h-8 text-caption'
                    />
                  </div>
                  <div className='space-y-1'>
                    <Label htmlFor='explore-prefix' className='text-caption font-medium'>
                      路径前缀 (pathPrefix，选填)
                    </Label>
                    <Input
                      id='explore-prefix'
                      value={pathPrefix}
                      onChange={(event) => setPathPrefix(event.target.value)}
                      placeholder='例如：/orders （不填则匹配整站）'
                      className='h-8 text-caption'
                    />
                  </div>
                </div>

                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1 border-t border-border-card'>
                  {/* 目标账号 */}
                  <div className='space-y-1'>
                    <Label htmlFor='explore-account' className='text-caption font-medium'>执行账号</Label>
                    <SelectField
                      id='explore-account'
                      className='w-full'
                      value={accountId}
                      onValueChange={(value) => setAccountId(value)}
                    >
                      <SelectFieldOption value=''>选择执行账号</SelectFieldOption>
                      {accounts.map((account) => (
                        <SelectFieldOption key={account.id} value={account.id}>
                          {account.displayName} ({account.username})
                        </SelectFieldOption>
                      ))}
                    </SelectField>
                  </div>

                  {/* 探索安全进入路径 */}
                  <div className='space-y-1'>
                    <Label htmlFor='explore-entry' className='text-caption font-medium'>探索入口路径</Label>
                    <SelectField
                      id='explore-entry'
                      className='w-full'
                      value={entryId}
                      onValueChange={(value) => setEntryId(value)}
                    >
                      <SelectFieldOption value=''>选择探索入口</SelectFieldOption>
                      {entries.map((entry) => (
                        <SelectFieldOption
                          key={entry.entryId}
                          value={entry.entryId}
                        >
                          {entry.name} ({entry.url})
                        </SelectFieldOption>
                      ))}
                    </SelectField>
                  </div>
                </div>

                {entries.length === 0 ? (
                  <p className='text-caption text-text-muted'>
                    当前无适用于探索的安全进入路径。可在上方安全路径卡片中编辑路径并勾选“网页受限探索”。
                  </p>
                ) : null}

                {accounts.length === 0 ? (
                  <p className='text-caption text-text-muted'>
                    {MAP_ACCOUNT_REQUIRED}
                  </p>
                ) : null}

                {/* 操作按钮 */}
                <div className='flex items-center gap-2 pt-1'>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={previewMutation.isPending || !accountId || !entryId}
                    onClick={() => previewMutation.mutate()}
                  >
                    <Search className='size-3.5 mr-1.5' />
                    {previewMutation.isPending ? '预览中…' : '预览探索范围'}
                  </Button>
                  <Button
                    size='sm'
                    disabled={
                      createMutation.isPending ||
                      !factoryOn ||
                      !enabled ||
                      !accountId ||
                      !entryId
                    }
                    onClick={() => createMutation.mutate()}
                  >
                    <Play className='size-3.5 mr-1.5' />
                    {createMutation.isPending ? '启动中…' : '开始探索'}
                  </Button>
                </div>
              </div>

              {/* 预览结果反馈 */}
              {previewMutation.data ? (
                <div className='rounded-lg border border-border-card bg-surface-subtle p-3 space-y-1.5'>
                  <div className='text-caption font-semibold text-text-primary'>
                    探索范围预览（共 {previewMutation.data.items.length} 个候选地标）
                  </div>
                  <ul className='space-y-1 text-caption text-text-muted max-h-36 overflow-y-auto'>
                    {previewMutation.data.items.map((item) => (
                      <li key={`${item.name}:${item.reason}`} className='flex items-center gap-1.5'>
                        <span className={item.included ? 'text-status-success-foreground' : 'text-text-muted'}>
                          {item.included ? '● 纳入' : '○ 排除'}
                        </span>
                        <span className='font-medium text-text-primary'>{item.name}</span>
                        <span>·</span>
                        <span>{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* 探索作业创建反馈 */}
              {createMutation.data ? (
                <div className='flex items-center gap-2 rounded-lg border border-border-success bg-status-success-subtle p-2.5 text-caption text-status-success-foreground'>
                  <CheckCircle2 className='size-4 shrink-0' />
                  <span>
                    探索作业已排队 ({createMutation.data.job.jobStatus})
                    {createMutation.data.job.firstRunId
                      ? ` · 首片运行：${createMutation.data.job.firstRunId.slice(0, 8)}…`
                      : ''}
                  </span>
                </div>
              ) : null}

              {/* 探索线索与候选审核区 */}
              <div className='rounded-lg border border-border-card bg-surface-subtle p-3 space-y-3 mt-3'>
                <div className='flex flex-wrap items-center justify-between gap-2 border-b border-border-card pb-2'>
                  <div className='space-y-0.5'>
                    <div className='flex items-center gap-2'>
                      <h3 className='text-caption font-semibold text-text-primary'>
                        导航线索与候选控件
                      </h3>
                      {activeJobId ? (
                        <span className='font-mono text-micro text-text-muted'>
                          作业：{activeJobId.slice(0, 8)}…
                        </span>
                      ) : null}
                    </div>
                    <p className='text-micro text-text-muted'>
                      来源状态扫描发现的候选线索需经人工审查方可单跳试跑，绝不自动提拔为正式地图资产。
                    </p>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Input
                      placeholder='输入探索作业 ID 审查'
                      value={inspectJobId}
                      onChange={(e) => setInspectJobId(e.target.value.trim())}
                      className='h-7 w-48 text-micro font-mono'
                    />
                  </div>
                </div>

                {/* 未知结果核查警示 */}
                {jobQuery.data?.jobStatus === 'needs_review' ? (
                  <div className='flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-warning bg-status-warning-subtle p-2.5 text-caption text-status-warning-foreground'>
                    <div className='flex items-center gap-2'>
                      <ShieldAlert className='size-4 shrink-0 text-status-warning-foreground' />
                      <span>受控动作执行结果未决 (needs_review)，等待人工核查判定。</span>
                    </div>
                    <div className='flex items-center gap-2'>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={reviewUnknownMutation.isPending}
                        onClick={() => reviewUnknownMutation.mutate('failed')}
                        className='h-7 text-micro'
                      >
                        判定为失败
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={reviewUnknownMutation.isPending}
                        onClick={() => reviewUnknownMutation.mutate('cancelled')}
                        className='h-7 text-micro'
                      >
                        取消并清理
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* 分组标签页 */}
                <div className='flex flex-wrap gap-1 border-b border-border-card pb-1'>
                  <button
                    type='button'
                    className={`px-2.5 py-1 text-micro rounded font-medium transition-colors ${
                      candidateTab === 'known_links'
                        ? 'bg-surface font-semibold text-link shadow-sm'
                        : 'text-text-muted hover:text-text-primary'
                    }`}
                    onClick={() => setCandidateTab('known_links')}
                  >
                    目标已知链接 ({knownLinks.length})
                  </button>
                  <button
                    type='button'
                    className={`px-2.5 py-1 text-micro rounded font-medium transition-colors ${
                      candidateTab === 'reveal'
                        ? 'bg-surface font-semibold text-link shadow-sm'
                        : 'text-text-muted hover:text-text-primary'
                    }`}
                    onClick={() => setCandidateTab('reveal')}
                  >
                    展开控件 ({revealControls.length})
                  </button>
                  <button
                    type='button'
                    className={`px-2.5 py-1 text-micro rounded font-medium transition-colors ${
                      candidateTab === 'opaque'
                        ? 'bg-surface font-semibold text-link shadow-sm'
                        : 'text-text-muted hover:text-text-primary'
                    }`}
                    onClick={() => setCandidateTab('opaque')}
                  >
                    目的地未知菜单 ({opaqueMenus.length})
                  </button>
                  <button
                    type='button'
                    className={`px-2.5 py-1 text-micro rounded font-medium transition-colors ${
                      candidateTab === 'rejected'
                        ? 'bg-surface font-semibold text-link shadow-sm'
                        : 'text-text-muted hover:text-text-primary'
                    }`}
                    onClick={() => setCandidateTab('rejected')}
                  >
                    已拒绝 ({rejectedCandidates.length})
                  </button>
                  <button
                    type='button'
                    className={`px-2.5 py-1 text-micro rounded font-medium transition-colors ${
                      candidateTab === 'incomplete'
                        ? 'bg-surface font-semibold text-link shadow-sm'
                        : 'text-text-muted hover:text-text-primary'
                    }`}
                    onClick={() => setCandidateTab('incomplete')}
                  >
                    采集不完整 ({incompleteCandidates.length})
                  </button>
                </div>

                {/* 候选列表 */}
                {candidatesQuery.isPending && activeJobId ? (
                  <p className='py-4 text-center text-micro text-text-muted'>正在加载候选线索…</p>
                ) : !activeJobId ? (
                  <p className='py-4 text-center text-micro text-text-muted'>
                    启动探索或输入作业 ID 后可查看采集到的候选线索。
                  </p>
                ) : (
                  <div className='space-y-2 max-h-64 overflow-y-auto pr-1'>
                    {((candidateTab === 'known_links'
                      ? knownLinks
                      : candidateTab === 'reveal'
                        ? revealControls
                        : candidateTab === 'opaque'
                          ? opaqueMenus
                          : candidateTab === 'rejected'
                            ? rejectedCandidates
                            : incompleteCandidates
                    ) as ExploreDiscovery[]).map((cand) => (
                      <div
                        key={cand.id}
                        className='flex flex-wrap items-center justify-between gap-2 rounded border border-border-card bg-surface p-2 text-caption'
                      >
                        <div className='space-y-0.5 min-w-0 flex-1'>
                          <div className='flex items-center gap-2'>
                            <span className='font-medium text-text-primary truncate'>
                              {cand.accessibleName || '未命名控件'}
                            </span>
                            <span className='font-mono text-micro text-text-muted bg-surface-subtle px-1 rounded'>
                              {cand.role}
                            </span>
                            <StatusBadge
                              tone={
                                cand.status === 'approved'
                                  ? 'success'
                                  : cand.status === 'rejected'
                                    ? 'error'
                                    : 'neutral'
                              }
                            >
                              {cand.status === 'approved'
                                ? '已批准'
                                : cand.status === 'rejected'
                                  ? '已拒绝'
                                  : '待审核'}
                            </StatusBadge>
                          </div>
                          <div className='flex items-center gap-2 text-micro text-text-muted font-mono truncate'>
                            {cand.targetUrl ? (
                              <span className='truncate text-link'>{cand.targetUrl}</span>
                            ) : (
                              <span className='truncate'>{cand.targetHint}</span>
                            )}
                            {cand.rejectionReason ? (
                              <span className='text-status-danger-foreground'>· {cand.rejectionReason}</span>
                            ) : null}
                          </div>
                        </div>

                        {/* 操作按钮 */}
                        <div className='flex items-center gap-1.5 shrink-0'>
                          {cand.status === 'discovered' && canWrite ? (
                            <>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={candidateReviewMutation.isPending}
                                onClick={() =>
                                  candidateReviewMutation.mutate({
                                    candidateId: cand.id,
                                    decision: 'approved',
                                    actionCategory:
                                      cand.candidateCategory === 'explicit_url'
                                        ? 'direct_url_open'
                                        : cand.candidateCategory === 'reveal'
                                          ? 'reveal'
                                          : 'ui_activate',
                                  })
                                }
                                className='h-7 text-micro'
                              >
                                <Check className='size-3 mr-1 text-status-success-foreground' />
                                审核批准
                              </Button>
                              <Button
                                size='sm'
                                variant='ghost'
                                disabled={candidateReviewMutation.isPending}
                                onClick={() =>
                                  candidateReviewMutation.mutate({
                                    candidateId: cand.id,
                                    decision: 'rejected',
                                    actionCategory:
                                      cand.candidateCategory === 'explicit_url'
                                        ? 'direct_url_open'
                                        : cand.candidateCategory === 'reveal'
                                          ? 'reveal'
                                          : 'ui_activate',
                                  })
                                }
                                className='h-7 text-micro text-text-muted hover:text-status-danger-foreground'
                              >
                                <X className='size-3 mr-1' />
                                拒绝
                              </Button>
                            </>
                          ) : null}

                          {cand.status === 'approved' && canWrite ? (
                            <Button
                              size='sm'
                              disabled={runCandidateMutation.isPending}
                              onClick={() => runCandidateMutation.mutate(cand.id)}
                              className='h-7 text-micro'
                            >
                              <ArrowRight className='size-3 mr-1' />
                              {runCandidateMutation.isPending ? '试跑中…' : '审核一步 (单跳试跑)'}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {(candidateTab === 'known_links'
                      ? knownLinks
                      : candidateTab === 'reveal'
                        ? revealControls
                        : candidateTab === 'opaque'
                          ? opaqueMenus
                          : candidateTab === 'rejected'
                            ? rejectedCandidates
                            : incompleteCandidates
                    ).length === 0 ? (
                      <p className='py-3 text-center text-micro text-text-muted'>
                        该分类下无候选控件。
                      </p>
                    ) : null}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
