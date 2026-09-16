import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { mapFactViewSchema, type KnowledgeSourceRef } from '@cairn/shared'
import { apiFetch } from '@/lib/api-client'
import { Button } from '@/components/ui/button'

const LABELS: Record<KnowledgeSourceRef['kind'], string> = {
  map_asset: '地图资产',
  map_observation: '页面观察',
  map_verification: '验证事实',
  term: '术语修订',
  module_version: '做法版本',
  attempt: '执行尝试',
  evidence: '执行证据',
}

function SourceItem({
  targetId,
  source,
}: {
  targetId: string
  source: KnowledgeSourceRef
}) {
  const [opened, setOpened] = useState(false)
  const fact = useMutation({
    mutationFn: async () => {
      if (
        source.kind !== 'map_observation' &&
        source.kind !== 'map_verification'
      )
        return undefined
      const path =
        source.kind === 'map_observation'
          ? `observations/${source.observationId}`
          : `verifications/${source.verificationId}`
      return apiFetch(`/api/targets/${targetId}/map/${path}`, mapFactViewSchema)
    },
  })
  return (
    <li>
      <details
        open={opened}
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary className='cursor-pointer text-link'>
          {LABELS[source.kind]}
          {source.kind === 'term' ? ` · r${source.revision}` : ''}
        </summary>
        <pre className='max-h-64 overflow-auto rounded border p-2 text-small break-all whitespace-pre-wrap'>
          {JSON.stringify(source, null, 2)}
        </pre>
        {source.kind === 'map_observation' ||
        source.kind === 'map_verification' ? (
          <div className='mt-2 space-y-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={fact.isPending}
              loading={fact.isPending}
              onClick={() => fact.mutate()}
            >
              读取来源事实
            </Button>
            {fact.isError ? (
              <p role='alert'>来源不可读取：{fact.error.message}</p>
            ) : null}
            {fact.data ? (
              <>
                <p>
                  证据正文：
                  {fact.data.contentAvailability === 'available'
                    ? '可用'
                    : '已过期或不可用'}
                </p>
                <pre className='max-h-64 overflow-auto text-small break-all whitespace-pre-wrap'>
                  {JSON.stringify(fact.data.payload, null, 2)}
                </pre>
              </>
            ) : null}
          </div>
        ) : null}
        {source.kind === 'map_asset' ? (
          <a className='text-link underline' href={`/targets/${targetId}/map`}>
            查看目标知识
          </a>
        ) : null}
        {source.kind === 'module_version' ? (
          <a
            className='text-link underline'
            href={`/action-modules/${source.moduleId}`}
          >
            查看做法与版本
          </a>
        ) : null}
        {source.kind === 'attempt' && source.runId ? (
          <a className='text-link underline' href={`/runs/${source.runId}`}>
            查看运行证据
          </a>
        ) : null}
      </details>
    </li>
  )
}

export function KnowledgeSources({
  targetId,
  sources,
}: {
  targetId: string
  sources: KnowledgeSourceRef[]
}) {
  if (!sources.length)
    return <p className='text-small text-muted-foreground'>暂无可展示的来源</p>
  return (
    <div className='min-w-0 space-y-2'>
      <p className='font-medium'>来源</p>
      <ul className='space-y-2'>
        {sources.map((source, index) => (
          <SourceItem key={index} targetId={targetId} source={source} />
        ))}
      </ul>
    </div>
  )
}
