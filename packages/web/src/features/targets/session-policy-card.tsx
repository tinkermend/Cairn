import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_SESSION_POLICY,
  type SessionPolicy,
  type SessionReclaimMode,
  type TargetDto,
  type TargetSessionPolicyPatch,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { updateTargetSessionPolicy } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const RECLAIM_LABELS: Record<SessionReclaimMode, string> = {
  IDLE: '按空闲回收',
  AUTH_DRIVEN: '认证有效即保活',
}

function inheritLabel(overridden: boolean) {
  return overridden ? '本目标覆盖' : '继承自平台'
}

export function SessionPolicyCard({ target }: { target: TargetDto }) {
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const effective = target.effectiveSessionPolicy ?? DEFAULT_SESSION_POLICY
  const override = target.sessionPolicy ?? null
  const [draft, setDraft] = useState<SessionPolicy>(effective)

  useEffect(() => {
    setDraft(target.effectiveSessionPolicy ?? DEFAULT_SESSION_POLICY)
  }, [target.effectiveSessionPolicy])

  const mutation = useMutation({
    mutationFn: (body: TargetSessionPolicyPatch) => updateTargetSessionPolicy(target.id, body),
    onSuccess: async () => {
      toast.success('已更新会话策略')
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新会话策略失败')
    },
  })

  const saveField = (key: keyof TargetSessionPolicyPatch, value: TargetSessionPolicyPatch[keyof TargetSessionPolicyPatch]) => {
    mutation.mutate({ [key]: value })
  }

  const saveNumber = (key: 'keepAliveSeconds' | 'authProbeIntervalSeconds' | 'evictionPriority') => {
    if (draft[key] === effective[key] && override?.[key] == null) return
    if (draft[key] === override?.[key]) return
    saveField(key, draft[key])
  }

  return (
    <Card className='min-w-0'>
      <CardHeader>
        <CardTitle className='text-section font-semibold'>会话策略</CardTitle>
        <p className='mt-1 text-label text-muted-foreground'>
          控制空闲回收还是按认证保活。只影响之后新建的会话与运行，不改写已有实例。
        </p>
      </CardHeader>
      <CardContent className='space-y-4'>
        {draft.reclaim === 'AUTH_DRIVEN' ? (
          <Alert>
            <AlertDescription>
              认证保活不占人工保留配额，但占执行节点 max_sessions。容量偏小时空闲会话会先被驱逐。
            </AlertDescription>
          </Alert>
        ) : null}
        <div className='grid gap-4 sm:grid-cols-2'>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='session-reclaim'>回收模式</Label>
              <span className='text-label text-muted-foreground'>{inheritLabel(override?.reclaim != null)}</span>
            </div>
            <Select
              disabled={!canWrite || mutation.isPending}
              value={draft.reclaim}
              onValueChange={(value) => {
                const reclaim = value as SessionReclaimMode
                setDraft((current) => ({ ...current, reclaim }))
                saveField('reclaim', reclaim)
              }}
            >
              <SelectTrigger id='session-reclaim' className='w-full'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(RECLAIM_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {override?.reclaim != null ? (
              <Button variant='ghost' size='sm' disabled={!canWrite} onClick={() => saveField('reclaim', null)}>
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='session-keep-alive'>保活时长（秒）</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.keepAliveSeconds != null)}
              </span>
            </div>
            <Input
              id='session-keep-alive'
              type='number'
              disabled={!canWrite || mutation.isPending}
              value={draft.keepAliveSeconds}
              onChange={(event) =>
                setDraft((current) => ({ ...current, keepAliveSeconds: Number(event.target.value) }))
              }
              onBlur={() => saveNumber('keepAliveSeconds')}
            />
            {override?.keepAliveSeconds != null ? (
              <Button variant='ghost' size='sm' disabled={!canWrite} onClick={() => saveField('keepAliveSeconds', null)}>
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='session-probe'>巡检间隔（秒）</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.authProbeIntervalSeconds != null)}
              </span>
            </div>
            <Input
              id='session-probe'
              type='number'
              disabled={!canWrite || mutation.isPending}
              value={draft.authProbeIntervalSeconds}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  authProbeIntervalSeconds: Number(event.target.value),
                }))
              }
              onBlur={() => saveNumber('authProbeIntervalSeconds')}
            />
            {override?.authProbeIntervalSeconds != null ? (
              <Button
                variant='ghost'
                size='sm'
                disabled={!canWrite}
                onClick={() => saveField('authProbeIntervalSeconds', null)}
              >
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-2'>
              <Label htmlFor='session-eviction'>驱逐优先级</Label>
              <span className='text-label text-muted-foreground'>
                {inheritLabel(override?.evictionPriority != null)}
              </span>
            </div>
            <Input
              id='session-eviction'
              type='number'
              disabled={!canWrite || mutation.isPending}
              value={draft.evictionPriority}
              onChange={(event) =>
                setDraft((current) => ({ ...current, evictionPriority: Number(event.target.value) }))
              }
              onBlur={() => saveNumber('evictionPriority')}
            />
            {override?.evictionPriority != null ? (
              <Button variant='ghost' size='sm' disabled={!canWrite} onClick={() => saveField('evictionPriority', null)}>
                清除本项目标覆盖
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
