import type { HealingDiagnosis, HealingPatch, RepairCandidate, Step, TargetDescriptor } from '@cairn/shared'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Check, Plus, ArrowUpRight, Clock, ShieldCheck, ShieldAlert, CheckCircle2 } from 'lucide-react'

export interface HealingPatchCardProps {
  diagnosis?: HealingDiagnosis
  candidate?: RepairCandidate
  currentStep?: Step
  onAcceptReplace?: (newTarget: TargetDescriptor) => void
  onAcceptAddCandidate?: (candidate: NonNullable<HealingPatch['suggestedCandidate']>) => void
  onUpgradeToAi?: (prompt: string) => void
  onValidate?: (candidateId: string) => void
  onAdopt?: (candidateId: string, expectedRevision: number) => void
  onReject?: (candidateId: string) => void
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
  rejected: { label: '已拒绝', variant: 'secondary' },
  expired: { label: '已过期', variant: 'outline' },
}

export function HealingPatchCard({
  diagnosis,
  candidate,
  onAcceptReplace,
  onAcceptAddCandidate,
  onUpgradeToAi,
  onValidate,
  onAdopt,
  onReject,
  onDismiss,
  currentRevision = 1,
}: HealingPatchCardProps) {
  const patch = candidate ? candidate.patch : diagnosis?.suggestedPatch
  const causeInfo = diagnosis
    ? CAUSE_LABELS[diagnosis.cause] ?? { label: diagnosis.cause, variant: 'outline' }
    : undefined
  const statusInfo = candidate
    ? STATUS_LABELS[candidate.status] ?? { label: candidate.status, variant: 'outline' }
    : undefined

  return (
    <Card className='border-status-warning/40 bg-status-warning-subtle'>
      <CardHeader className='pb-3'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Sparkles className='h-4 w-4 text-status-warning' />
            <CardTitle className='text-body font-semibold'>
              {candidate ? `受控修复候选 (${candidate.candidateId})` : '智能修复建议 (Step Healer)'}
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
            {statusInfo && (
              <Badge variant={statusInfo.variant} className='text-label'>
                {statusInfo.label}
              </Badge>
            )}
          </div>
        </div>
        <CardDescription className='text-label text-muted-foreground mt-1'>
          {candidate ? candidate.hypothesis : diagnosis?.analysisSummary}
        </CardDescription>
      </CardHeader>

      <CardContent className='space-y-3 text-label'>
        {/* Guardrail badges when candidate is present */}
        {candidate && (
          <div className='rounded-md border bg-background/80 p-2.5 space-y-1.5'>
            <div className='flex items-center justify-between font-medium text-foreground'>
              <span className='flex items-center gap-1.5'>
                {candidate.guardResults.overallPassed ? (
                  <ShieldCheck className='h-3.5 w-3.5 text-status-success' />
                ) : (
                  <ShieldAlert className='h-3.5 w-3.5 text-destructive' />
                )}
                静态安全护栏 (Guardrails)
              </span>
              <span className='text-label text-muted-foreground'>
                {candidate.guardResults.overallPassed ? '全部通过' : '存在阻断项'}
              </span>
            </div>
            <div className='flex flex-wrap gap-1.5 pt-1'>
              <Badge
                variant={candidate.guardResults.allowedFields.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                字段白名单: {candidate.guardResults.allowedFields.status === 'passed' ? '通过' : '拒绝'}
              </Badge>
              <Badge
                variant={candidate.guardResults.unchangedBusinessGoal.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                业务目标不变: {candidate.guardResults.unchangedBusinessGoal.status === 'passed' ? '保持' : '弱化警告'}
              </Badge>
              <Badge
                variant={candidate.guardResults.sideEffectSafety.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                副作用安全: {candidate.guardResults.sideEffectSafety.status === 'passed' ? '安全' : '风险'}
              </Badge>
              <Badge
                variant={candidate.guardResults.contextIntegrity.status === 'passed' ? 'outline' : 'destructive'}
                className='text-label'
              >
                上下文完整性: {candidate.guardResults.contextIntegrity.status === 'passed' ? '合规' : '越权'}
              </Badge>
            </div>
          </div>
        )}

        {/* Validation Scope badges */}
        {candidate && (
          <div className='rounded-md border bg-background/80 p-2.5 space-y-1.5'>
            <div className='font-medium text-foreground flex items-center justify-between'>
              <span>验证范围 (Validation Scope)</span>
            </div>
            <div className='flex flex-wrap gap-1.5 pt-1'>
              <Badge variant={candidate.validationScope.locatorValid ? 'default' : 'outline'} className='text-label'>
                定位有效: {candidate.validationScope.locatorValid ? '是' : '未验证'}
              </Badge>
              <Badge variant={candidate.validationScope.stepPassed ? 'default' : 'outline'} className='text-label'>
                单步执行: {candidate.validationScope.stepPassed ? '通过' : '未验证'}
              </Badge>
              <Badge variant={candidate.validationScope.outcomePassed ? 'default' : 'outline'} className='text-label'>
                交付达成: {candidate.validationScope.outcomePassed ? '通过' : '未验证'}
              </Badge>
              <Badge variant={candidate.validationScope.crossSampleStable ? 'default' : 'outline'} className='text-label'>
                跨样本稳定: {candidate.validationScope.crossSampleStable ? '稳定' : '单样本'}
              </Badge>
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
        <div className='flex items-center gap-2'>
          {/* Candidate-specific actions */}
          {candidate && (
            <>
              {(candidate.status === 'proposed' || candidate.status === 'validating') && onValidate && (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-7 text-label gap-1'
                  onClick={() => onValidate(candidate.id)}
                >
                  <Sparkles className='h-3.5 w-3.5 text-primary' />
                  发起隔离验证
                </Button>
              )}

              {candidate.status === 'validated' && onAdopt && (
                <Button
                  size='sm'
                  variant='default'
                  className='h-7 text-label gap-1'
                  disabled={!candidate.guardResults.overallPassed}
                  onClick={() => onAdopt(candidate.id, currentRevision)}
                >
                  <CheckCircle2 className='h-3.5 w-3.5' />
                  采纳为草稿 (v{currentRevision})
                </Button>
              )}

              {candidate.status === 'blocked' && (
                <span className='text-label text-destructive font-medium'>
                  安全护栏未通过，禁止采纳
                </span>
              )}

              {candidate.status === 'adopted' && (
                <span className='text-label text-muted-foreground flex items-center gap-1'>
                  <Check className='h-3.5 w-3.5 text-status-success' />
                  已采纳进草稿
                </span>
              )}

              {onReject && candidate.status !== 'rejected' && candidate.status !== 'adopted' && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 text-label text-muted-foreground'
                  onClick={() => onReject(candidate.id)}
                >
                  拒绝
                </Button>
              )}
            </>
          )}

          {/* Legacy diagnosis actions if candidate is not used */}
          {!candidate && patch?.suggestedCandidate && onAcceptReplace && (
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

          {!candidate && patch?.upgradeSuggestion && onUpgradeToAi && (
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

        {onDismiss && (
          <Button size='sm' variant='ghost' className='h-7 text-label text-muted-foreground' onClick={onDismiss}>
            忽略
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
