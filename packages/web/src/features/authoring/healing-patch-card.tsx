import { useState } from 'react'
import type { HealingDiagnosis, HealingPatch, RepairCandidate, Step, TargetDescriptor } from '@cairn/shared'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sparkles, Check, Plus, ArrowUpRight, Clock, ShieldCheck, ShieldAlert, CheckCircle2, RotateCcw } from 'lucide-react'

export interface HealingPatchCardProps {
  diagnosis?: HealingDiagnosis
  candidate?: RepairCandidate
  candidates?: RepairCandidate[]
  selectedCandidateId?: string
  onSelectCandidate?: (candidateId: string) => void
  currentStep?: Step
  onAcceptReplace?: (newTarget: TargetDescriptor) => void
  onAcceptAddCandidate?: (candidate: NonNullable<HealingPatch['suggestedCandidate']>) => void
  onUpgradeToAi?: (prompt: string) => void
  onValidate?: (candidateId: string) => void
  onAdopt?: (candidateId: string, expectedRevision: number) => void
  onReject?: (candidateId: string, reason?: string) => void
  onReopen?: (candidateId: string) => void
  onDismiss?: () => void
  currentRevision?: number
}

const CAUSE_LABELS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  LOCATOR_DRIFT: { label: '选择器漂移', variant: 'secondary' },
  TIMING_WAIT_INSUFFICIENT: { label: '时序等待不足', variant: 'outline' },
  CONTENT_CHANGED: { label: '页面文案变动', variant: 'secondary' },
  CONTEXT_MISMATCH: { label: '页面跳转偏离', variant: 'destructive' },
  TARGET_ABSENT: { label: '目标不存在', variant: 'destructive' },
  ENVIRONMENT_BLOCKED: { label: '环境阻挡/登录失效', variant: 'destructive' },
}

const STATUS_LABELS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  proposed: { label: '待验证候选', variant: 'outline' },
  validating: { label: '验证执行中', variant: 'outline' },
  validated: { label: '验证已通过', variant: 'default' },
  blocked: { label: '护栏阻断', variant: 'destructive' },
  adopted: { label: '已采纳为草稿', variant: 'secondary' },
  rejected: { label: '已驳回', variant: 'secondary' },
  expired: { label: '已过期', variant: 'outline' },
}

export function HealingPatchCard({
  diagnosis,
  candidate,
  candidates,
  selectedCandidateId,
  onSelectCandidate,
  onAcceptReplace,
  onAcceptAddCandidate,
  onUpgradeToAi,
  onValidate,
  onAdopt,
  onReject,
  onReopen,
  onDismiss,
  currentRevision = 1,
}: HealingPatchCardProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | undefined>()
  const [showRejectInput, setShowRejectInput] = useState(false)
  const [rejectReason, setRejectReason] = useState('')

  const activeCandidate = candidates && candidates.length > 0
    ? (candidates.find((c) => c.id === (selectedCandidateId ?? internalSelectedId)) ?? candidates[0])
    : candidate

  const patch = activeCandidate ? activeCandidate.patch : diagnosis?.suggestedPatch
  const causeInfo = diagnosis
    ? CAUSE_LABELS[diagnosis.cause] ?? { label: diagnosis.cause, variant: 'outline' }
    : undefined
  const statusInfo = activeCandidate
    ? STATUS_LABELS[activeCandidate.status] ?? { label: activeCandidate.status, variant: 'outline' }
    : undefined

  return (
    <Card className='border-status-warning/40 bg-status-warning-subtle'>
      <CardHeader className='pb-3'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Sparkles className='h-4 w-4 text-status-warning' />
            <CardTitle className='text-body font-semibold'>
              {activeCandidate ? `受控修复候选 (${activeCandidate.candidateId})` : '智能修复建议 (Step Healer)'}
            </CardTitle>
          </div>
          <div className='flex items-center gap-1.5'>
            {causeInfo && (
              <Badge variant={causeInfo.variant} className='text-label'>
                {causeInfo.label}
              </Badge>
            )}
            {diagnosis?.confidence !== undefined && (
              <Badge variant='outline' className='text-label font-mono'>
                置信度 {Math.round(diagnosis.confidence * 100)}%
              </Badge>
            )}
            {activeCandidate?.observationCount !== undefined && activeCandidate.observationCount > 1 && (
              <Badge variant='outline' className='text-label font-mono'>
                观测 {activeCandidate.observationCount} 次
              </Badge>
            )}
            {statusInfo && (
              <Badge variant={statusInfo.variant} className='text-label'>
                {statusInfo.label}
              </Badge>
            )}
          </div>
        </div>

        {/* Multiple candidates selector */}
        {candidates && candidates.length > 1 && (
          <div className='flex items-center gap-1.5 pt-1.5 overflow-x-auto'>
            <span className='text-label font-medium text-foreground shrink-0'>
              修复建议 {Math.max(1, candidates.findIndex((c) => c.id === activeCandidate?.id) + 1)}/{candidates.length}:
            </span>
            {candidates.map((c, idx) => (
              <Button
                key={c.id}
                size='sm'
                variant={c.id === activeCandidate?.id ? 'secondary' : 'ghost'}
                className='h-6 text-label px-2 font-mono'
                onClick={() => {
                  if (onSelectCandidate) onSelectCandidate(c.id)
                  else setInternalSelectedId(c.id)
                }}
              >
                #{idx + 1} {c.candidateId}
                {c.observationCount > 1 ? ` (${c.observationCount}次)` : ''}
              </Button>
            ))}
          </div>
        )}

        <CardDescription className='text-label text-muted-foreground mt-1'>
          {activeCandidate ? activeCandidate.hypothesis : diagnosis?.analysisSummary}
        </CardDescription>
      </CardHeader>

      <CardContent className='space-y-3 text-label'>
        {/* Guardrail badges when candidate is present */}
        {activeCandidate && (
          <div className='rounded-md border bg-background/80 p-2.5 space-y-1.5'>
            <div className='flex items-center justify-between font-medium text-foreground'>
              <span className='flex items-center gap-1.5'>
                {activeCandidate.guardResults.overallPassed ? (
                  <ShieldCheck className='h-3.5 w-3.5 text-status-success' />
                ) : (
                  <ShieldAlert className='h-3.5 w-3.5 text-destructive' />
                )}
                静态安全护栏 (Guardrails)
              </span>
              <span className='text-label text-muted-foreground'>
                {activeCandidate.guardResults.overallPassed ? '全部通过' : '存在阻断项'}
              </span>
            </div>
            <div className='flex flex-wrap gap-1.5 pt-1'>
              <Badge
                variant={activeCandidate.guardResults.allowedFields.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                字段白名单: {activeCandidate.guardResults.allowedFields.status === 'passed' ? '通过' : '拒绝'}
              </Badge>
              <Badge
                variant={activeCandidate.guardResults.unchangedBusinessGoal.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                业务目标不变: {activeCandidate.guardResults.unchangedBusinessGoal.status === 'passed' ? '保持' : '弱化警告'}
              </Badge>
              <Badge
                variant={activeCandidate.guardResults.sideEffectSafety.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                副作用安全: {activeCandidate.guardResults.sideEffectSafety.status === 'passed' ? '安全' : '风险'}
              </Badge>
              <Badge
                variant={activeCandidate.guardResults.contextIntegrity.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                上下文完整性: {activeCandidate.guardResults.contextIntegrity.status === 'passed' ? '合规' : '越权'}
              </Badge>
            </div>
          </div>
        )}

        {/* Validation Scope badges */}
        {activeCandidate && (
          <div className='rounded-md border bg-background/80 p-2.5 space-y-1.5'>
            <div className='font-medium text-foreground flex items-center justify-between'>
              <span>验证范围 (Validation Scope)</span>
            </div>
            <div className='flex flex-wrap gap-1.5 pt-1'>
              <Badge variant={activeCandidate.validationScope.locatorValid ? 'default' : 'outline'} className='text-label'>
                定位有效: {activeCandidate.validationScope.locatorValid ? '是' : '未验证'}
              </Badge>
              <Badge variant={activeCandidate.validationScope.stepPassed ? 'default' : 'outline'} className='text-label'>
                单步执行: {activeCandidate.validationScope.stepPassed ? '通过' : '未验证'}
              </Badge>
              <Badge variant={activeCandidate.validationScope.outcomePassed ? 'default' : 'outline'} className='text-label'>
                交付达成: {activeCandidate.validationScope.outcomePassed ? '通过' : '未验证'}
              </Badge>
              <Badge variant={activeCandidate.validationScope.crossSampleStable ? 'default' : 'outline'} className='text-label'>
                跨样本稳定: {activeCandidate.validationScope.crossSampleStable ? '稳定' : '单样本'}
              </Badge>
            </div>
          </div>
        )}

        {/* Rejection info callout when rejected */}
        {activeCandidate?.status === 'rejected' && (
          <div className='rounded-md border border-muted bg-muted/30 p-2.5 space-y-1.5'>
            <div className='flex items-center justify-between font-medium'>
              <span className='text-muted-foreground flex items-center gap-1.5'>
                <RotateCcw className='h-3.5 w-3.5' />
                已驳回候选记录
              </span>
              {(activeCandidate.rejectedObservationCount ?? 0) >= 10 && (
                <Badge variant='destructive' className='text-label'>
                  高频复现 (≥10次)
                </Badge>
              )}
            </div>
            <div className='space-y-1 text-label text-muted-foreground'>
              {activeCandidate.rejection?.reason && (
                <div>
                  驳回原因: <span className='text-foreground'>{activeCandidate.rejection.reason}</span>
                </div>
              )}
              {activeCandidate.rejection?.rejectedBy && (
                <div>
                  驳回操作者: <span className='font-mono'>{activeCandidate.rejection.rejectedBy}</span>
                </div>
              )}
              {(activeCandidate.rejectedObservationCount ?? 0) > 0 && (
                <div className='text-status-warning font-medium'>
                  驳回后在运行中又命中 {activeCandidate.rejectedObservationCount} 次（总计观测 {activeCandidate.observationCount} 次）
                </div>
              )}
            </div>
          </div>
        )}

        {patch?.suggestedCandidate && (
          <div className='rounded-md border bg-background/80 p-2.5 space-y-1.5'>
            <div className='font-medium text-foreground flex items-center justify-between'>
              <span>推荐定位候选 (Candidate)</span>
              <span className='font-mono text-muted-foreground'>{patch.suggestedCandidate.by}</span>
            </div>
            <div className='font-mono text-label bg-muted/50 p-1.5 rounded overflow-x-auto text-primary'>
              {patch.suggestedCandidate.by === 'role'
                ? `role="${patch.suggestedCandidate.value}"${patch.suggestedCandidate.name ? ` [name="${patch.suggestedCandidate.name}"]` : ''}`
                : patch.suggestedCandidate.value}
            </div>
          </div>
        )}

        {patch?.suggestedWaitMs && (
          <div className='flex items-center gap-2 text-muted-foreground'>
            <Clock className='h-3.5 w-3.5' />
            <span>建议前置等待增加: {patch.suggestedWaitMs}ms</span>
          </div>
        )}

        {patch?.upgradeSuggestion && (
          <div className='rounded-md border border-primary/30 bg-primary/5 p-2.5 space-y-1'>
            <div className='flex items-center gap-1.5 font-medium text-primary'>
              <Sparkles className='h-3.5 w-3.5' />
              <span>建议升级为 Midscene AI 步骤</span>
            </div>
            <p className='text-muted-foreground text-label'>
              该步骤在多版本改版中选择器频繁失效，建议使用自然语言语义执行：
            </p>
            <p className='font-mono text-label text-foreground font-semibold'>
              &quot;{patch.upgradeSuggestion.prompt}&quot;
            </p>
          </div>
        )}
      </CardContent>

      <CardFooter className='flex flex-wrap items-center justify-between gap-2 pt-1 border-t bg-muted/10'>
        {showRejectInput ? (
          <div className='flex items-center gap-2 w-full py-1'>
            <Input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder='请输入驳回原因（选填）'
              className='h-7 text-label flex-1'
            />
            <Button
              size='sm'
              variant='destructive'
              className='h-7 text-label shrink-0'
              onClick={() => {
                if (activeCandidate) {
                  onReject?.(activeCandidate.id, rejectReason || undefined)
                }
                setShowRejectInput(false)
                setRejectReason('')
              }}
            >
              确认驳回
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='h-7 text-label shrink-0'
              onClick={() => {
                setShowRejectInput(false)
                setRejectReason('')
              }}
            >
              取消
            </Button>
          </div>
        ) : (
          <div className='flex items-center gap-2'>
            {/* Candidate-specific actions */}
            {activeCandidate && (
              <>
                {(activeCandidate.status === 'proposed' || activeCandidate.status === 'validating') && onValidate && (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-label gap-1'
                    onClick={() => onValidate(activeCandidate.id)}
                  >
                    <Sparkles className='h-3.5 w-3.5 text-primary' />
                    发起隔离验证
                  </Button>
                )}

                {(activeCandidate.status === 'proposed' || activeCandidate.status === 'validating' || activeCandidate.status === 'validated') && onAdopt && (
                  <Button
                    size='sm'
                    variant='default'
                    className='h-7 text-label gap-1'
                    disabled={!activeCandidate.guardResults.overallPassed}
                    onClick={() => onAdopt(activeCandidate.id, currentRevision)}
                  >
                    <CheckCircle2 className='h-3.5 w-3.5' />
                    采纳为草稿 (v{currentRevision})
                  </Button>
                )}

                {activeCandidate.status === 'blocked' && (
                  <span className='text-label text-destructive font-medium'>
                    安全护栏未通过，禁止采纳
                  </span>
                )}

                {activeCandidate.status === 'adopted' && (
                  <span className='text-label text-muted-foreground flex items-center gap-1'>
                    <Check className='h-3.5 w-3.5 text-status-success' />
                    已采纳进草稿
                  </span>
                )}

                {activeCandidate.status === 'rejected' && onReopen && (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-label gap-1'
                    onClick={() => onReopen(activeCandidate.id)}
                  >
                    <RotateCcw className='h-3.5 w-3.5' />
                    重新打开
                  </Button>
                )}

                {onReject && activeCandidate.status !== 'rejected' && activeCandidate.status !== 'adopted' && (
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 text-label text-muted-foreground'
                    onClick={() => setShowRejectInput(true)}
                  >
                    拒绝
                  </Button>
                )}
              </>
            )}

            {/* Legacy diagnosis actions if candidate is not used */}
            {!activeCandidate && patch?.suggestedCandidate && onAcceptReplace && (
              <>
                <Button
                  size='sm'
                  variant='default'
                  className='h-7 text-label gap-1'
                  onClick={() => {
                    if (patch.targetDescriptor) {
                      onAcceptReplace(patch.targetDescriptor)
                    } else if (patch.suggestedCandidate) {
                      onAcceptReplace({
                        framePath: [],
                        candidates: [patch.suggestedCandidate],
                      })
                    }
                  }}
                >
                  <Check className='h-3.5 w-3.5' />
                  采纳为新定位器
                </Button>
                {onAcceptAddCandidate && (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-label gap-1'
                    onClick={() => {
                      if (patch.suggestedCandidate) {
                        onAcceptAddCandidate(patch.suggestedCandidate)
                      }
                    }}
                  >
                    <Plus className='h-3.5 w-3.5' />
                    追加为备选候选
                  </Button>
                )}
              </>
            )}

            {!activeCandidate && patch?.upgradeSuggestion && onUpgradeToAi && (
              <Button
                size='sm'
                variant='secondary'
                className='h-7 text-label gap-1 text-primary'
                onClick={() => onUpgradeToAi(patch.upgradeSuggestion!.prompt)}
              >
                <ArrowUpRight className='h-3.5 w-3.5' />
                一键升级为 AI 步骤
              </Button>
            )}
          </div>
        )}

        {!showRejectInput && onDismiss && (
          <Button size='sm' variant='ghost' className='h-7 text-label text-muted-foreground' onClick={onDismiss}>
            忽略
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
