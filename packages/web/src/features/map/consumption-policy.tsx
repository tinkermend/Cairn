import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MapConsumptionMode } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchMapConsumptionPolicy, updateMapConsumptionPolicy } from '@/lib/map-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const MODE_LABELS: Record<MapConsumptionMode, string> = {
  off: '关闭',
  shadow: '仅比较',
  read_only_fallback: '只读步骤候选',
}

type ConsumptionPolicyCardProps = {
  targetId: string
}

export function ConsumptionPolicyCard({ targetId }: ConsumptionPolicyCardProps) {
  return <PolicyForm key={targetId} targetId={targetId} />
}

function PolicyForm({ targetId }: ConsumptionPolicyCardProps) {
  const canReadMap = useCan('map:read')
  const canReadTarget = useCan('target:read')
  const canRead = canReadMap && canReadTarget
  const requestKey = useRef<{ payload: string; key: string } | null>(null)
  const canPublish = useCan('map:publish')
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<MapConsumptionMode | ''>('')
  const [reason, setReason] = useState('')
  const query = useQuery({
    queryKey: ['map', targetId, 'consumption-policy'],
    queryFn: () => fetchMapConsumptionPolicy(targetId),
    enabled: canRead,
  })
  const mutation = useMutation({
    mutationFn: () => {
      const body = { expectedRevision: query.data!.revision,
        mode: (mode || query.data!.policy.mode) as MapConsumptionMode, reason: reason.trim() }
      const payload = JSON.stringify(body)
      if (requestKey.current?.payload !== payload) requestKey.current = { payload, key: `policy:${crypto.randomUUID()}` }
      return updateMapConsumptionPolicy(targetId, { ...body, idempotencyKey: requestKey.current.key })
    },
    onSuccess: () => {
      toast.success('已更新运行消费政策')
      setReason('')
      setMode('')
      requestKey.current = null
      void queryClient.invalidateQueries({ queryKey: ['map', targetId, 'consumption-policy'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新消费政策失败')
    },
  })

  if (!canRead) return null

  const current = query.data
  const selected = mode || current?.policy.mode || 'off'
  const fallbackClosed = selected === 'read_only_fallback' && (!current?.eligibility || Boolean(current.eligibility.suspendedAt) || current.policy.allowedStepTypes.some(type => !current.eligibility!.eligibleStepTypes.includes(type)))

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>运行消费</h2>
      <p className='text-label text-muted-foreground'>
        关闭、仅比较或只读步骤候选。实际替换必须先有可校验的对照资格，不能凭一句话打开。
      </p>
      {query.isPending ? (
        <p className='text-label text-muted-foreground'>政策加载中…</p>
      ) : query.isError ? (
        <p className='text-label text-muted-foreground'>暂时无法读取消费政策。</p>
      ) : current ? (
        <>
          <p className='text-body'>
            当前：{MODE_LABELS[current.policy.mode]}
            {current.policy.mode !== 'off' ? ` · 修订 ${current.revision}` : ''}
          </p>
          {current.eligibility ? (
            current.eligibility.suspendedAt ? (
              <Alert>
                <AlertDescription>只读替换已因确认错配冻结；需新的独立对照资格后才能重新开放。</AlertDescription>
              </Alert>
            ) : (
              <p className='text-label text-muted-foreground'>
                资格 {current.eligibility.reportId} · {current.eligibility.eligibleStepTypes.join('、')}
              </p>
            )
          ) : (
            <Alert>
              <AlertDescription>尚缺只读对照资格，产品只读替换保持关闭。</AlertDescription>
            </Alert>
          )}
          {canPublish ? (
            <div className='space-y-3'>
              <div className='space-y-2'>
                <Label htmlFor='consumption-mode'>模式</Label>
                <select
                  disabled={mutation.isPending}
                  id='consumption-mode'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={selected}
                  onChange={(event) => setMode(event.target.value as MapConsumptionMode)}
                >
                  <option value='off'>关闭</option>
                  <option value='shadow'>仅比较</option>
                  <option value='read_only_fallback'>只读步骤候选</option>
                </select>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='consumption-reason'>理由</Label>
                <Input
                  disabled={mutation.isPending}
                  maxLength={512}
                  id='consumption-reason'
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder='说明为何调整消费模式'
                />
              </div>
              <Button
                disabled={mutation.isPending || fallbackClosed || !reason.trim()}
                onClick={() => mutation.mutate()}
              >
                保存政策
              </Button>
              {fallbackClosed ? (
                <p className='text-label text-muted-foreground'>没有资格记录，不能打开只读步骤候选。</p>
              ) : null}
            </div>
          ) : (
            <p className='text-label text-muted-foreground'>需要发布权限才能改消费政策。</p>
          )}
        </>
      ) : null}
    </section>
  )
}
