import { useQuery } from '@tanstack/react-query'
import type { ScenarioAuthoringDocumentV2, ScenarioDocument } from '@cairn/shared'
import { Eye, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { previewScenarioExpansion } from '@/lib/scenarios-api'
import { stepTypeLabel } from './labels'

type ModuleExpansionPreviewDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  scenarioId: string
  invocationId: string
  document: ScenarioAuthoringDocumentV2 | ScenarioDocument
}

export function ModuleExpansionPreviewDrawer({
  open,
  onOpenChange,
  scenarioId,
  invocationId,
  document,
}: ModuleExpansionPreviewDrawerProps) {
  const previewQuery = useQuery({
    queryKey: ['scenario-expansion-preview', scenarioId, invocationId],
    queryFn: () => previewScenarioExpansion(scenarioId, { document }),
    enabled: open,
  })

  const preview = previewQuery.data
  const manifestEntry = preview?.manifest?.entries.find((entry) => entry.invocationId === invocationId)
  const expandedSteps = preview?.definition?.steps ?? []
  const targetStepIds = new Set(manifestEntry?.expandedStepIds ?? [])
  const currentInvocationSteps = expandedSteps.filter((step) => targetStepIds.has(step.id))
  const preconditionIds = new Set(manifestEntry?.preconditionStepIds ?? [])
  const postconditionIds = new Set(manifestEntry?.postconditionStepIds ?? [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90vh] flex-col sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Eye className='size-5 text-primary' />
            模块展开步骤预览 · 只读
          </DialogTitle>
          <DialogDescription>
            {manifestEntry
              ? `「${manifestEntry.name}」${manifestEntry.moduleKey}${manifestEntry.versionNo ? `@v${manifestEntry.versionNo}` : ''} 将展开为以下独立步骤。`
              : '查看模块调用节点展开后的具体步骤序列。'}
          </DialogDescription>
        </DialogHeader>

        {previewQuery.isPending ? (
          <div className='p-8 text-center text-small text-muted-foreground'>正在计算编译展开步骤…</div>
        ) : previewQuery.isError ? (
          <div className='p-6 text-small text-destructive'>
            展开预览失败：{(previewQuery.error as Error).message}
          </div>
        ) : (
          <div className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'>
            {(preview?.diagnostics.length ?? 0) > 0 ? (
              <div className='rounded-md border border-status-warning-border bg-status-warning-background p-3 text-small text-status-warning-foreground'>
                <p className='font-medium'>编译诊断提示：</p>
                <ul className='mt-1 list-disc space-y-1 ps-4'>
                  {(preview?.diagnostics ?? []).map((item, index) => (
                    <li key={`${item.code ?? 'diag'}-${index}`}>{item.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className='space-y-2'>
              <h4 className='text-small font-medium text-muted-foreground'>
                展开步骤序列（共 {currentInvocationSteps.length} 步）
              </h4>
              <ol className='space-y-2'>
                {currentInvocationSteps.map((step, index) => (
                  <li
                    key={step.id}
                    className='flex items-center justify-between rounded-md border border-border-card bg-muted/20 p-3 text-small'
                  >
                    <div className='flex items-center gap-3'>
                      <span className='font-mono text-label text-muted-foreground'>
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div>
                        <p className='font-medium text-body'>{step.name}</p>
                        <p className='text-label text-muted-foreground'>
                          {stepTypeLabel(step.type)} · ID: {step.id.slice(0, 8)}
                        </p>
                      </div>
                    </div>
                    <div className='flex items-center gap-2'>
                      {preconditionIds.has(step.id) ? (
                        <Badge variant='outline' className='text-label'>
                          <ShieldCheck className='mr-1 size-3' />
                          前置条件
                        </Badge>
                      ) : null}
                      {postconditionIds.has(step.id) ? (
                        <Badge variant='outline' className='text-label'>
                          <ShieldAlert className='mr-1 size-3' />
                          后置条件
                        </Badge>
                      ) : null}
                      <Badge variant='secondary' className='text-label'>
                        {step.effectType === 'SIDE_EFFECT' ? '副作用' : '只读'}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}

        <div className='flex justify-end pt-2'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
