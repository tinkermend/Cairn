import type { HealingDiagnosis, HealingPatch, Step, TargetDescriptor } from '@cairn/shared'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sparkles, Check, Plus, ArrowUpRight, Clock } from 'lucide-react'

export interface HealingPatchCardProps {
  diagnosis: HealingDiagnosis
  currentStep: Step
  onAcceptReplace: (newTarget: TargetDescriptor) => void
  onAcceptAddCandidate: (candidate: NonNullable<HealingPatch['suggestedCandidate']>) => void
  onUpgradeToAi: (prompt: string) => void
  onDismiss?: () => void
}

const CAUSE_LABELS: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  LOCATOR_DRIFT: { label: '选择器漂移', variant: 'secondary' },
  TIMING_WAIT_INSUFFICIENT: { label: '时序等待不足', variant: 'outline' },
  CONTENT_CHANGED: { label: '页面文案变动', variant: 'secondary' },
  CONTEXT_MISMATCH: { label: '页面跳转偏离', variant: 'destructive' },
  TARGET_ABSENT: { label: '目标不存在', variant: 'destructive' },
  ENVIRONMENT_BLOCKED: { label: '环境阻挡/登录失效', variant: 'destructive' },
}

export function HealingPatchCard({
  diagnosis,
  onAcceptReplace,
  onAcceptAddCandidate,
  onUpgradeToAi,
  onDismiss,
}: HealingPatchCardProps) {
  const patch = diagnosis.suggestedPatch
  const causeInfo = CAUSE_LABELS[diagnosis.cause] ?? { label: diagnosis.cause, variant: 'outline' }

  return (
    <Card className='border-status-warning/40 bg-status-warning-subtle'>
      <CardHeader className='pb-3'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <Sparkles className='h-4 w-4 text-status-warning' />
            <CardTitle className='text-body font-semibold'>智能修复建议 (Step Healer)</CardTitle>
          </div>
          <div className='flex items-center gap-1.5'>
            <Badge variant={causeInfo.variant} className='text-label'>
              {causeInfo.label}
            </Badge>
            <Badge variant='outline' className='text-label font-mono'>
              置信度 {Math.round(diagnosis.confidence * 100)}%
            </Badge>
          </div>
        </div>
        <CardDescription className='text-label text-muted-foreground mt-1'>
          {diagnosis.analysisSummary}
        </CardDescription>
      </CardHeader>

      <CardContent className='space-y-3 text-label'>
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
          {patch?.suggestedCandidate && (
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
            </>
          )}

          {patch?.upgradeSuggestion && (
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
