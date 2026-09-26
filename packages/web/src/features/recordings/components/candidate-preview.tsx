import { useState } from 'react'
import type {
  ScenarioAuthoringDocumentV2,
  RecordingGeneralizationDto,
  OutcomeContract,
} from '@cairn/shared'
import {
  Check,
  Copy,
  FileCode2,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Cpu,
  Layers,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { authoringNodeId } from '@cairn/shared'

type Props = {
  candidateDocument?: ScenarioAuthoringDocumentV2
  generalization?: RecordingGeneralizationDto
  onOpenHandoff?: () => void
  canWrite?: boolean
}

export function CandidateScenarioPreview({
  candidateDocument,
  generalization,
  onOpenHandoff,
  canWrite = true,
}: Props) {
  const [copiedDigest, setCopiedDigest] = useState(false)

  if (!candidateDocument) {
    return (
      <div className='flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-card bg-card p-6 text-center shadow-card'>
        <FileCode2 className='size-10 text-muted-foreground' />
        <p className='text-body text-muted-foreground'>暂无已折叠的候选场景草稿</p>
      </div>
    )
  }

  const handleCopyDigest = async () => {
    if (!generalization?.candidateDigest) return
    await navigator.clipboard.writeText(generalization.candidateDigest)
    setCopiedDigest(true)
    toast.success('已复制候选文档摘要')
    setTimeout(() => setCopiedDigest(false), 2000)
  }

  const inputs = candidateDocument.inputs ?? []
  const nodes = candidateDocument.nodes ?? []

  return (
    <div className='flex flex-col gap-5'>
      {/* 摘要与状态卡片 */}
      <Card className='border-border-card bg-card shadow-card'>
        <CardHeader className='pb-3'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='flex items-center gap-2'>
              <Sparkles className='size-5 text-primary' />
              <CardTitle className='text-heading-sm'>候选场景草稿（预览）</CardTitle>
            </div>
            <div className='flex items-center gap-2'>
              {generalization?.candidateDigest ? (
                <div className='flex items-center gap-1.5 rounded bg-muted/60 px-2 py-1 text-mono text-label text-muted-foreground'>
                  <span>Digest:</span>
                  <span>{generalization.candidateDigest.slice(0, 12)}...</span>
                  <Button
                    variant='ghost'
                    size='icon'
                    className='size-5'
                    onClick={() => void handleCopyDigest()}
                    title='复制完整 Digest'
                  >
                    {copiedDigest ? <Check className='size-3 text-status-success-foreground' /> : <Copy className='size-3' />}
                  </Button>
                </div>
              ) : null}
              {canWrite && onOpenHandoff ? (
                <Button size='sm' onClick={onOpenHandoff} className='gap-1.5'>
                  以草稿新建场景
                  <ArrowRight className='size-3.5' />
                </Button>
              ) : null}
            </div>
          </div>
          <CardDescription>
            经逐项决策与泛化轮次叠加折叠后的原子编排草稿。可直接原子一步新建场景并进入 Studio 调试。
          </CardDescription>
        </CardHeader>
        {inputs.length > 0 ? (
          <CardContent className='pt-0'>
            <div className='rounded-md border border-border-card/60 bg-muted/20 p-3'>
              <div className='mb-2 flex items-center gap-2 text-label font-medium text-foreground'>
                <Cpu className='size-3.5 text-primary' />
                <span>场景输入参数声明 ({inputs.length})</span>
              </div>
              <div className='flex flex-wrap gap-2'>
                {inputs.map((input) => (
                  <Badge
                    key={input.key}
                    variant='outline'
                    className='gap-1.5 bg-background font-mono text-label'
                  >
                    <span className='font-semibold text-primary'>{input.key}</span>
                    <span className='text-muted-foreground'>({input.label})</span>
                    {input.type ? <span className='text-xs text-muted-foreground/70'>:{input.type}</span> : null}
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {/* 节点流列表 */}
      <div className='flex flex-col gap-3'>
        <div className='flex items-center justify-between'>
          <h3 className='text-body font-semibold text-foreground'>编排节点序 ({nodes.length})</h3>
          <span className='text-label text-muted-foreground'>按执行顺序折叠</span>
        </div>

        <div className='flex flex-col gap-2'>
          {nodes.map((node, index) => {
            const nodeId = authoringNodeId(node)
            if (node.kind === 'step') {
              const step = node.step
              const outcomes: OutcomeContract[] =
                'outcomes' in step && Array.isArray((step as { outcomes?: OutcomeContract[] }).outcomes)
                  ? ((step as { outcomes?: OutcomeContract[] }).outcomes ?? [])
                  : []
              const fromInput = (step.input as Record<string, unknown> | undefined)?.from
              return (
                <div
                  key={nodeId}
                  className='flex flex-col gap-2 rounded-lg border border-border-card bg-card p-3 shadow-card transition-colors hover:border-primary/40'
                >
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <div className='flex items-center gap-2'>
                      <span className='flex size-5 items-center justify-center rounded bg-muted text-xs font-mono font-medium text-muted-foreground'>
                        {index + 1}
                      </span>
                      <span className='font-medium text-foreground'>{step.name}</span>
                      <Badge variant='secondary' className='text-xs font-mono'>
                        {step.type}
                      </Badge>
                      {step.effectType === 'SIDE_EFFECT' ? (
                        <Badge variant='outline' className='text-xs border-amber-500/30 text-amber-600 dark:text-amber-400'>
                          副作用
                        </Badge>
                      ) : null}
                    </div>

                    {fromInput ? (
                      <Badge variant='outline' className='gap-1 border-primary/30 text-primary'>
                        <span>引用参数:</span>
                        <span className='font-mono font-semibold'>{String(fromInput)}</span>
                      </Badge>
                    ) : null}
                  </div>

                  {/* 成功条件 Outcomes 预览 */}
                  {outcomes.length > 0 ? (
                    <div className='mt-1 flex flex-wrap gap-2 border-t border-border-card/40 pt-2'>
                      {outcomes.map((oc, ocIdx) => (
                        <div
                          key={oc.id ?? ocIdx}
                          className='flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400'
                        >
                          <ShieldCheck className='size-3.5' />
                          <span className='font-semibold'>[{oc.severity}]</span>
                          <span>{oc.meaning}</span>
                          <span className='text-[10px] text-muted-foreground'>({oc.provenance})</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            }

            return (
              <div
                key={nodeId}
                className='flex items-center gap-2 rounded-lg border border-border-card bg-muted/30 p-3 text-label text-muted-foreground'
              >
                <Layers className='size-4' />
                <span>控制块 [{node.kind}]</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
