import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  isFinishedRunStatus,
  resolveEvidencePolicy,
  RUN_EXECUTE_ALL_OF,
  type RunDetailDto,
} from '@cairn/shared'
import {
  ArrowLeft,
  Clock,
  Copy,
  Globe,
  Info,
  MoreHorizontal,
  RotateCcw,
  Sparkles,
  User,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { Can } from '@/components/rbac/can'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAssistantStore } from '@/stores/assistant-store'
import { useCan } from '@/hooks/use-permissions'
import { retryRunReport } from '@/lib/runs-api'
import { CatalogName } from './catalog-name'
import {
  CAPTURE_MODE_LABELS,
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_REPORT_STATUS_LABELS,
  RUN_STATUS_LABELS,
  formatDuration,
  runEvidenceStatusTone,
  runReportStatusTone,
  runStatusTone,
} from './labels'
import {
  connectionLabel,
  type ObservationConnection,
} from './use-run-observation'

type Props = {
  run: RunDetailDto
  connection: ObservationConnection
  onRefresh: () => void
  onCancel: () => void
  onDelete: () => void
  onCreateNew: () => void
  busy?: boolean
  canCancel?: boolean
  canDelete?: boolean
}

export function RunHeroBanner({
  run,
  connection,
  onRefresh,
  onCancel,
  onDelete,
  onCreateNew,
  busy = false,
  canCancel = false,
  canDelete = false,
}: Props) {
  const [techInfoOpen, setTechInfoOpen] = useState(false)
  const [retryingReport, setRetryingReport] = useState(false)
  const canReadReports = useCan('report:read')
  const canExportReports = useCan('report:export')
  const openAssistant = useAssistantStore((state) => state.openPanel)
  const finished = isFinishedRunStatus(run.status)
  const durationText = formatDuration(run.startedAt, run.finishedAt)
  const policy = resolveEvidencePolicy(run.snapshot.evidencePolicy)

  const copyRunId = () => {
    void navigator.clipboard.writeText(run.id)
    toast.success('已复制运行 ID')
  }

  const handleRetryReport = async () => {
    try {
      setRetryingReport(true)
      await retryRunReport(run.id)
      toast.success('已触发重新生成报告')
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试生成报告失败')
    } finally {
      setRetryingReport(false)
    }
  }

  return (
    <>
      <header className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-card bg-card px-4 py-2.5 shadow-card'>
        {/* 左侧：返回、标题、短ID与核心状态徽标 */}
        <div className='flex flex-wrap items-center gap-3 min-w-0'>
          <Link
            to='/runs'
            className='inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border-card text-muted-foreground hover:bg-muted hover:text-foreground'
            title='返回运行记录列表'
            aria-label='返回运行记录'
          >
            <ArrowLeft className='size-4' />
          </Link>

          <div className='min-w-0'>
            <div className='flex items-center gap-2'>
              <h1 className='text-body font-semibold text-foreground truncate max-w-xs md:max-w-md'>
                <CatalogName name={run.scenarioName} deleted={run.scenarioDeleted}>
                  <Link
                    to='/scenarios/$scenarioId'
                    params={{ scenarioId: run.scenarioId }}
                    className='hover:text-primary hover:underline'
                  >
                    {run.scenarioName || '未命名场景'}
                  </Link>
                </CatalogName>
              </h1>
              <button
                type='button'
                onClick={copyRunId}
                className='inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-caption text-muted-foreground hover:bg-muted hover:text-foreground'
                title={`完整 ID: ${run.id} (点击复制)`}
              >
                <span>#{run.id.slice(0, 8)}</span>
                <Copy className='size-3 opacity-70' />
              </button>
            </div>

            {/* 紧凑副标题元数据条 */}
            <div className='mt-0.5 flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
              {/* 目标系统与账号 */}
              <span className='inline-flex items-center gap-1'>
                <Globe className='size-3 text-muted-foreground/80' />
                <CatalogName name={run.targetName} deleted={run.targetDeleted}>
                  <Link
                    to='/targets/$targetId'
                    params={{ targetId: run.targetId }}
                    className='hover:text-primary hover:underline'
                  >
                    {run.targetName}
                  </Link>
                </CatalogName>
              </span>

              {run.targetAccountName ? (
                <>
                  <span className='text-muted-foreground/40'>·</span>
                  <span className='inline-flex items-center gap-1'>
                    <User className='size-3 text-muted-foreground/80' />
                    <span>{run.targetAccountName}</span>
                  </span>
                </>
              ) : null}

              {/* 耗时 */}
              {durationText ? (
                <>
                  <span className='text-muted-foreground/40'>·</span>
                  <span className='inline-flex items-center gap-1 font-mono'>
                    <Clock className='size-3 text-muted-foreground/80' />
                    <span>{durationText}</span>
                  </span>
                </>
              ) : null}

              {/* 触发来源与时间 */}
              <span className='text-muted-foreground/40'>·</span>
              <span>
                {run.source?.kind === 'service' ? '服务API调用' : '控制台手动'} ·{' '}
                {new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>

              {/* 登录核验规则 */}
              {run.snapshot.authVerification ? (
                <>
                  <span className='text-muted-foreground/40'>·</span>
                  <span className='text-muted-foreground'>
                    登录核验{' '}
                    {run.snapshot.authVerification.capability === 'IDENTITY_VERIFIED'
                      ? '已启用登录态检测 · 可核验身份'
                      : run.snapshot.authVerification.capability === 'LOGIN_VERIFIED'
                        ? '已启用登录态检测'
                        : '未配置登录态检测'}
                    {run.snapshot.authVerification.profileRevision
                      ? ` · 规则修订 ${run.snapshot.authVerification.profileRevision}`
                      : ''}
                    {` · 新鲜度 ${run.snapshot.authVerification.freshnessSeconds} 秒`}
                  </span>
                </>
              ) : (
                <>
                  <span className='text-muted-foreground/40'>·</span>
                  <span className='text-muted-foreground'>
                    历史运行未冻结登录态检测规则，开跑时按登录页判断
                  </span>
                </>
              )}

              {/* 证据策略 */}
              <span className='text-muted-foreground/40'>·</span>
              <span className='text-muted-foreground'>
                本次采集：截图 {CAPTURE_MODE_LABELS[policy.screenshot]} · 录像{' '}
                {policy.video === 'always' ? '始终' : '关闭'} · 操作轨迹{' '}
                {CAPTURE_MODE_LABELS[policy.trace]}
              </span>
            </div>
          </div>
        </div>

        {/* 右侧：状态指示器与主操作栏 */}
        <div className='flex items-center gap-2 shrink-0'>
          {/* 执行状态与证据收集状态徽标 */}
          <div className='flex items-center gap-1.5 mr-1'>
            <StatusBadge tone={runStatusTone(run.status)}>
              {RUN_STATUS_LABELS[run.status]}
            </StatusBadge>

            {run.evidenceStatus === 'INCOMPLETE' || (run.evidenceStatus === 'PENDING' && finished) ? (
              <StatusBadge tone={runEvidenceStatusTone(run.evidenceStatus, run.status)}>
                {RUN_EVIDENCE_STATUS_LABELS[run.evidenceStatus]}
              </StatusBadge>
            ) : null}

            {canReadReports && run.runReportStatus && run.runReportStatus !== 'not_configured' ? (
              run.reportId ? (
                <Link
                  to='/reports/$reportId'
                  params={{ reportId: run.reportId }}
                  className='inline-flex hover:opacity-80'
                >
                  <StatusBadge tone={runReportStatusTone(run.runReportStatus)}>
                    {RUN_REPORT_STATUS_LABELS[run.runReportStatus]}
                  </StatusBadge>
                </Link>
              ) : (
                <span title={run.reportError ?? undefined}>
                  <StatusBadge tone={runReportStatusTone(run.runReportStatus)}>
                    {RUN_REPORT_STATUS_LABELS[run.runReportStatus]}
                  </StatusBadge>
                </span>
              )
            ) : null}

            {/* 实时连接状态圆点 */}
            {!finished ? (
              <span
                className='inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-caption text-muted-foreground'
                title={`实时推送状态: ${connectionLabel(connection)}`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    connection === 'live'
                      ? 'bg-status-success-foreground animate-pulse'
                      : connection === 'recovering'
                        ? 'bg-status-warning-foreground'
                        : 'bg-muted-foreground'
                  }`}
                />
                <span className='text-3xs'>{connectionLabel(connection)}</span>
              </span>
            ) : null}
          </div>

          {/* 进行中：取消按钮 */}
          {!finished && run.status !== 'NEEDS_REVIEW' && canCancel ? (
            <Button
              variant={run.status === 'WAITING_FOR_AUTH' ? 'outline' : 'destructive'}
              size='sm'
              disabled={busy}
              onClick={onCancel}
              className='h-8'
            >
              取消
            </Button>
          ) : null}

          {/* 失败报告重试按钮 */}
          {canExportReports && run.runReportStatus === 'failed' ? (
            <Button
              variant='outline'
              size='sm'
              disabled={busy || retryingReport}
              onClick={() => void handleRetryReport()}
              className='h-8'
            >
              重试生成报告
            </Button>
          ) : null}

          {/* 已生成报告：查看报告 */}
          {canReadReports && run.reportId ? (
            <Button variant='outline' size='sm' asChild className='h-8'>
              <Link to='/reports/$reportId' params={{ reportId: run.reportId }}>
                查看报告
              </Link>
            </Button>
          ) : null}

          {/* 重新运行 / 新建运行 */}
          <Can allOf={RUN_EXECUTE_ALL_OF}>
            <Button size='sm' onClick={onCreateNew} className='h-8 gap-1.5'>
              <RotateCcw className='size-3.5' />
              <span>重新运行</span>
            </Button>
          </Can>

          {/* 更多操作下拉菜单 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant='ghost' size='icon' className='size-8' aria-label='更多操作'>
                <MoreHorizontal className='size-4' />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-48'>
              <DropdownMenuItem onClick={onRefresh}>
                刷新
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to='/runs' search={{ runId: run.id, view: 'materials' }}>
                  现场材料检索
                </Link>
              </DropdownMenuItem>
              {canReadReports && run.reportId ? (
                <DropdownMenuItem asChild>
                  <Link to='/reports/$reportId' params={{ reportId: run.reportId }}>
                    查看交付报告
                  </Link>
                </DropdownMenuItem>
              ) : null}

              {run.suiteRunId ? (
                <DropdownMenuItem asChild>
                  <Link to='/suite-runs/$suiteRunId' params={{ suiteRunId: run.suiteRunId }}>
                    所属场景集运行
                  </Link>
                </DropdownMenuItem>
              ) : null}

              <Can allOf={['notification:read']}>
                <DropdownMenuItem asChild>
                  <Link to='/notifications' search={{ tab: 'records', runId: run.id }}>
                    通知发送记录
                  </Link>
                </DropdownMenuItem>
              </Can>

              <Can allOf={['ai:assist', 'run:read', 'target:read']}>
                <DropdownMenuItem
                  onClick={() =>
                    openAssistant({
                      question: '分析本次运行结果与执行瓶颈',
                      capabilityHint: 'run.diagnose',
                      pageContext: { page: 'run', runId: run.id },
                    })
                  }
                  className='text-primary'
                >
                  <Sparkles className='mr-1.5 size-3.5' />
                  分析本次运行
                </DropdownMenuItem>
              </Can>

              <DropdownMenuSeparator />

              <DropdownMenuItem onClick={() => setTechInfoOpen(true)}>
                <Info className='mr-1.5 size-3.5' />
                执行环境与租约详情
              </DropdownMenuItem>

              {finished && canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className='text-destructive focus:text-destructive' onClick={onDelete}>
                    删除
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>


      {/* 执行环境与底层租约弹窗（Zero-Jargon：将底层技术细节收拢在二级弹窗，不污染主界面） */}
      <Dialog open={techInfoOpen} onOpenChange={setTechInfoOpen}>
        <DialogContent className='sm:max-w-lg'>
          <DialogHeader>
            <DialogTitle>执行环境与底层租约详情</DialogTitle>
            <DialogDescription>
              平台调度系统分配的执行节点、租约状态与快照核验信息。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-3 py-2 text-label'>
            <div className='rounded-md border border-border-card bg-muted/40 p-3 space-y-2'>
              <div className='flex justify-between items-center'>
                <span className='text-muted-foreground'>分配执行节点:</span>
                <span className='font-mono font-medium'>
                  {run.lease ? run.lease.holderWorkerId : finished ? '已释放' : '等待分配'}
                </span>
              </div>
              <div className='flex justify-between items-center'>
                <span className='text-muted-foreground'>运行版本类型:</span>
                <span>{run.scenarioVersionKind === 'trial' ? '草稿试跑 (Trial)' : '正式发布版本'}</span>
              </div>
              <div className='flex justify-between items-center'>
                <span className='text-muted-foreground'>快照步骤数:</span>
                <span className='font-mono'>{run.snapshot?.steps?.length ?? run.stepRuns.length} 步</span>
              </div>
            </div>

            {run.snapshot.authVerification ? (
              <div className='rounded-md border border-border-card bg-muted/40 p-3 space-y-1.5'>
                <p className='font-medium text-foreground'>登录态核验规则</p>
                <p className='text-muted-foreground'>
                  能力级别：{run.snapshot.authVerification.capability}
                  {run.snapshot.authVerification.profileRevision
                    ? ` · 规则修订 #${run.snapshot.authVerification.profileRevision}`
                    : ''}
                  {` · 认证新鲜度 ${run.snapshot.authVerification.freshnessSeconds} 秒`}
                </p>
              </div>
            ) : null}

            {run.placement ? (
              <div className='rounded-md border border-border-card bg-muted/40 p-3 space-y-1.5'>
                <p className='font-medium text-foreground'>调度放置约束</p>
                <p className='font-mono text-muted-foreground text-caption break-all'>
                  {JSON.stringify(run.placement)}
                </p>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
