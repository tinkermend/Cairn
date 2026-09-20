import { Link } from '@tanstack/react-router'
import {
  resolveEvidencePolicy,
  type RunDetailDto,
} from '@cairn/shared'
import { Globe, ListOrdered, ShieldCheck, Target } from 'lucide-react'
import { CatalogName } from './catalog-name'
import { StatusBadge } from '@/components/status-badge'
import {
  OutcomeAxisSummary,
  RUN_EXECUTION_AXIS_LABELS,
} from './outcome-axis'
import {
  CAPTURE_MODE_LABELS,
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  runEvidenceStatusTone,
  runStatusTone,
} from './labels'

type Props = {
  run: RunDetailDto
}

export function RunMetricStrip({ run }: Props) {
  const policy = resolveEvidencePolicy(run.snapshot.evidencePolicy)
  const succeededSteps = run.stepRuns.filter((s) => s.status === 'SUCCEEDED').length
  const totalSteps = run.stepRuns.length
  const retryCount = run.stepRuns.reduce(
    (acc, s) => acc + Math.max(0, s.attempts.length - 1),
    0,
  )

  return (
    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4'>
      {/* 1. 目标系统与账号 */}
      <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <div className='flex items-center justify-between text-muted-foreground'>
          <span className='text-label font-medium'>目标系统 / 目标账号</span>
          <Globe className='size-4 text-primary' />
        </div>
        <div className='mt-2 min-w-0'>
          <div className='text-body font-semibold text-foreground truncate'>
            <CatalogName name={run.targetName} deleted={run.targetDeleted}>
              <Link
                to='/targets/$targetId'
                params={{ targetId: run.targetId }}
                className='text-primary hover:underline'
              >
                {run.targetName}
              </Link>
            </CatalogName>
          </div>
          <p className='mt-1 text-label text-muted-foreground truncate'>
            {run.targetAccountName
              ? `账号：${run.targetAccountName}${run.targetAccountDeleted ? '（已删除）' : ''}`
              : '未指定目标账号'}
            {run.source?.kind === 'service' ? ' · 服务 API 调用' : ''}
          </p>
        </div>
        <div className='mt-3 flex items-center gap-1.5 border-t border-border-card/60 pt-2 text-label text-muted-foreground min-w-0'>
          <span className='shrink-0'>场景：</span>
          <CatalogName name={run.scenarioName} deleted={run.scenarioDeleted}>
            <Link
              to='/scenarios/$scenarioId'
              params={{ scenarioId: run.scenarioId }}
              className='text-primary hover:underline font-medium truncate'
            >
              {run.scenarioName}
            </Link>
          </CatalogName>
        </div>
      </div>

      {/* 2. 步骤完成进度 */}
      <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <div className='flex items-center justify-between text-muted-foreground'>
          <span className='text-label font-medium'>步骤执行进度</span>
          <ListOrdered className='size-4 text-primary' />
        </div>
        <div className='mt-2'>
          <div className='flex items-baseline gap-2'>
            <span className='text-title font-semibold tracking-tight text-foreground'>
              {succeededSteps} / {totalSteps}
            </span>
            <span className='text-label text-muted-foreground'>步骤完成</span>
          </div>
          <p className='mt-1 text-label text-muted-foreground truncate'>
            {retryCount > 0
              ? `${retryCount} 次重试尝试 · 最终确定结果`
              : '按冻结顺序执行 · 0 次重试'}
          </p>
        </div>
        <div className='mt-3 flex items-center justify-between border-t border-border-card/60 pt-2 text-label'>
          <div className='flex items-center gap-2'>
            {run.scenarioVersionKind === 'trial' ? (
              <StatusBadge tone='warning'>试跑</StatusBadge>
            ) : (
              <StatusBadge tone='neutral'>正式</StatusBadge>
            )}
          </div>
          <span className='text-label text-muted-foreground font-mono'>
            快照 {run.snapshot?.steps?.length ?? totalSteps} 步
          </span>
        </div>
      </div>

      {/* 3. 浏览器会话与租约 */}
      <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <div className='flex items-center justify-between text-muted-foreground'>
          <span className='text-label font-medium'>浏览器会话与租约</span>
          <ShieldCheck className='size-4 text-primary' />
        </div>
        <div className='mt-2 min-w-0'>
          <div className='text-body font-semibold text-foreground truncate'>
            {run.lease ? `Worker ${run.lease.holderWorkerId}` : '当前没有执行租约'}
          </div>
          <p className='mt-1 text-label text-muted-foreground truncate'>
            {run.lease ? `fencing ${run.lease.fencingToken}` : 'Session 与本次 Run 独立'}
          </p>
        </div>
        <div className='mt-3 border-t border-border-card/60 pt-2'>
          {run.snapshot.authVerification ? (
            <p className='text-label text-muted-foreground truncate'>
              登录核验{' '}
              {run.snapshot.authVerification.capability === 'IDENTITY_VERIFIED'
                ? '已启用主动检测 · 可核验身份'
                : run.snapshot.authVerification.capability === 'LOGIN_VERIFIED'
                  ? '已启用主动检测'
                  : '未配置主动检测'}
              {run.snapshot.authVerification.profileRevision
                ? ` · 规则修订 ${run.snapshot.authVerification.profileRevision}`
                : ''}
              {` · 新鲜度 ${run.snapshot.authVerification.freshnessSeconds} 秒`}
            </p>
          ) : (
            <p className='text-label text-muted-foreground truncate'>历史运行未冻结主动检测规则，开跑时按登录页判断。</p>
          )}
        </div>
      </div>

      {/* 4. 执行状态与双轴判定 */}
      <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <div className='flex items-center justify-between text-muted-foreground'>
          <span className='text-label font-medium'>双轴判定与证据</span>
          <Target className='size-4 text-primary' />
        </div>
        <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
          <StatusBadge tone={runStatusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</StatusBadge>
          <StatusBadge tone={runEvidenceStatusTone(run.evidenceStatus, run.status)}>
            {RUN_EVIDENCE_STATUS_LABELS[run.evidenceStatus]}
          </StatusBadge>
        </div>
        <div className='mt-2'>
          <OutcomeAxisSummary
            executionLabel={RUN_EXECUTION_AXIS_LABELS[run.status]}
            outcomeStatus={run.outcomeStatus}
          />
        </div>
        <div className='mt-2 border-t border-border-card/60 pt-2 text-label text-muted-foreground truncate'>
          本次采集：截图 {CAPTURE_MODE_LABELS[policy.screenshot]} · 录像{' '}
          {policy.video === 'always' ? '始终' : '关闭'} · Trace{' '}
          {CAPTURE_MODE_LABELS[policy.trace]}
        </div>
      </div>
    </div>
  )
}
