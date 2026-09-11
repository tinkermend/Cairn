import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { fetchScenario } from '@/lib/scenarios-api'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import { RunCreateDialog } from '@/features/runs/create-dialog'
import { EFFECT_TYPE_LABELS, STEP_TYPE_LABELS } from './labels'

export function ScenarioDetailPage() {
  const { scenarioId } = useParams({ from: '/_authenticated/scenarios/$scenarioId/' })
  const query = useQuery({
    queryKey: ['scenarios', scenarioId],
    queryFn: () => fetchScenario(scenarioId),
  })
  const [runOpen, setRunOpen] = useState(false)
  const scenario = query.data

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title={scenario?.name ?? '场景'}
          description='最小可运行定义。步骤按顺序执行，绑定的是目标系统，不是控制台用户。'
          actions={
            <Can permission='run:execute'>
              <Button onClick={() => setRunOpen(true)}>运行</Button>
            </Can>
          }
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError || !scenario ? (
          <QueryErrorState title='无法加载场景' onRetry={() => void query.refetch()} />
        ) : (
          <div className='space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <p className='text-body text-muted-foreground'>
              目标系统{' '}
              <Link
                to='/targets/$targetId'
                params={{ targetId: scenario.targetId }}
                className='text-primary hover:underline'
              >
                {scenario.targetId}
              </Link>
              {' · '}
              版本 v{scenario.latestVersionNo} · {scenario.status}
            </p>
            <ol className='space-y-3'>
              {scenario.steps.map((step, index) => (
                <li key={step.id} className='rounded-md border border-border-card p-3'>
                  <p className='font-medium'>
                    {index + 1}. {step.name}
                  </p>
                  <p className='text-label text-muted-foreground'>
                    {step.type in STEP_TYPE_LABELS
                      ? STEP_TYPE_LABELS[step.type as keyof typeof STEP_TYPE_LABELS]
                      : step.type}{' '}
                    · {EFFECT_TYPE_LABELS[step.effectType]}
                    {step.outputKey ? ` · 输出 ${step.outputKey}` : ''}
                  </p>
                  <pre className='mt-2 overflow-x-auto text-label'>
                    {JSON.stringify(step.input, null, 2)}
                  </pre>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Main>
      {scenario ? (
        <RunCreateDialog
          open={runOpen}
          onOpenChange={setRunOpen}
          defaultScenarioId={scenario.id}
          defaultTargetId={scenario.targetId}
        />
      ) : null}
    </>
  )
}
