import { useNavigate } from '@tanstack/react-router'
import type { AssistantProposal, AssistantResult } from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'

const ENTITY_HREF =
  /^\/(runs|scenarios|targets)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

function assistantHrefTo(href: string) {
  const match = ENTITY_HREF.exec(href)
  if (match?.[1] === 'runs')
    return { to: '/runs/$runId' as const, params: { runId: match[2]! } }
  if (match?.[1] === 'scenarios') {
    return {
      to: '/scenarios/$scenarioId' as const,
      params: { scenarioId: match[2]! },
    }
  }
  if (match?.[1] === 'targets') {
    return {
      to: '/targets/$targetId' as const,
      params: { targetId: match[2]! },
    }
  }
  return {
    to: href as '/platform-config' | '/runs' | '/scenarios' | '/targets',
  }
}

export function AssistantResultView({
  result,
  onAdopt,
  onClarify,
  onNavigate,
  adopting,
}: {
  result: AssistantResult
  onAdopt?: (proposal: AssistantProposal) => void
  onClarify?: (optionId: string) => void
  onNavigate?: () => void
  adopting?: boolean
}) {
  const navigate = useNavigate()
  const go = (href: string) => {
    const target = assistantHrefTo(href)
    void navigate(target as never).then(() => onNavigate?.())
  }
  if (result.kind === 'clarify') {
    return (
      <div className='space-y-2'>
        <p>{result.question}</p>
        {result.options?.length ? (
          <div className='flex flex-wrap gap-2'>
            {result.options.map((item) => (
              <Button
                key={item.id}
                type='button'
                variant='outline'
                size='sm'
                onClick={() => onClarify?.(item.id)}
              >
                {item.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'unsupported') {
    return <p>{result.message}</p>
  }
  if (result.kind === 'inaccessible') {
    return <p>{result.message}</p>
  }
  if (result.kind === 'guide') {
    return (
      <ul className='space-y-3'>
        {result.items.map((item) => (
          <li
            key={item.topic}
            className='rounded-md border border-border px-3 py-2'
          >
            <div className='flex items-center justify-between gap-2'>
              <p className='font-medium'>{item.title}</p>
              <StatusBadge tone='success'>可用</StatusBadge>
            </div>
            <p className='mt-1 text-label text-muted-foreground'>
              {item.steps}
            </p>
            {item.href ? (
              <button
                type='button'
                className='mt-2 inline-block text-label text-primary'
                onClick={() => go(item.href!)}
              >
                打开入口
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    )
  }
  if (result.kind === 'explanation') {
    return (
      <div className='space-y-2'>
        <p>{result.summary}</p>
        {result.stepSummary ? <p>{result.stepSummary}</p> : null}
        {result.diagnostics.length > 0 ? (
          <ul className='space-y-1 text-label'>
            {result.diagnostics.map((item) => (
              <li key={`${item.code}-${item.stepId ?? ''}`}>
                {item.baseline ? '原有问题：' : ''}
                {item.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'diagnosis') {
    return (
      <div className='space-y-3'>
        <section>
          <h3 className='text-label font-medium'>已确认事实</h3>
          <ul className='mt-1 list-disc space-y-1 ps-5'>
            {result.facts.map((item) => (
              <li key={item.id}>{item.text}</li>
            ))}
          </ul>
        </section>
        {result.hypotheses.length > 0 ? (
          <section>
            <h3 className='text-label font-medium'>可能原因</h3>
            <ul className='mt-1 list-disc space-y-1 ps-5'>
              {result.hypotheses.map((item) => (
                <li key={item.text}>{item.text}</li>
              ))}
            </ul>
          </section>
        ) : null}
        {result.missingInformation.length > 0 ? (
          <p className='text-label text-muted-foreground'>
            还缺少：{result.missingInformation.join('；')}
          </p>
        ) : null}
        {result.nextActions.length > 0 ? (
          <section>
            <h3 className='text-label font-medium'>建议操作</h3>
            <div className='mt-2 flex flex-wrap gap-2'>
              {result.nextActions.map((item) => (
                <Button
                  key={item.kind}
                  variant='outline'
                  size='sm'
                  onClick={() => go(item.href)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    )
  }
  return (
    <div className='space-y-3'>
      <p>{result.reason}</p>
      <ul className='space-y-1 text-label'>
        {result.diffs.map((item) => (
          <li key={item.fieldPath.join('.')}>
            {item.fieldPath.join('.')}：{String(item.from ?? '空')} →{' '}
            {String(item.to ?? '空')}
          </li>
        ))}
      </ul>
      {result.diagnostics.length > 0 ? (
        <p className='text-label text-muted-foreground'>
          {result.executable
            ? '可以保存后试跑。'
            : '尚有原有编译问题，候选未新增错误。'}
        </p>
      ) : null}
      <Button
        disabled={!onAdopt || adopting}
        loading={adopting}
        onClick={() => onAdopt?.(result)}
      >
        采纳到编辑器
      </Button>
    </div>
  )
}
