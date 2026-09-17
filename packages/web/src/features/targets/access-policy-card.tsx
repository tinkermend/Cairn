import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TargetAccessPurpose, TargetAccessRule } from '@cairn/shared'
import { Plus, Shield, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchTargetAccessPolicy, updateTargetAccessPolicy } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/status-badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const PURPOSE_LABELS: Record<TargetAccessPurpose, string> = {
  business_surface: '业务表面',
  authentication: '认证',
  resource: '资源加载',
}

export function AccessPolicyCard({ targetId }: { targetId: string }) {
  const canRead = useCan('map:read')
  const canWrite = useCan('target:write')
  const queryClient = useQueryClient()
  const [origin, setOrigin] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [purpose, setPurpose] = useState<TargetAccessPurpose>('business_surface')
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow')
  const [reason, setReason] = useState('')

  const query = useQuery({
    queryKey: ['target', targetId, 'access-policy'],
    queryFn: () => fetchTargetAccessPolicy(targetId),
    enabled: canRead,
  })

  const mutation = useMutation({
    mutationFn: (rules: TargetAccessRule[]) =>
      updateTargetAccessPolicy(targetId, {
        expectedRevision: query.data?.revision ?? 0,
        idempotencyKey: `access:${Date.now()}`,
        rules,
        reason: reason.trim() || '更新目标授权',
      }),
    onSuccess: () => {
      toast.success('已更新目标授权')
      setReason('')
      setOrigin('')
      setPathPrefix('')
      void queryClient.invalidateQueries({ queryKey: ['target', targetId, 'access-policy'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新目标授权失败')
    },
  })

  if (!canRead) return null
  const current = query.data
  const rules = current?.policy?.rules ?? []

  return (
    <Card className='min-w-0'>
      <CardHeader className='flex flex-row items-start justify-between gap-3'>
        <div>
          <CardTitle className='text-section font-semibold'>目标授权</CardTitle>
          <p className='mt-1 text-label text-muted-foreground'>
            正式运行与地图作业共用这份 origin 用途上限。资源域单独标明，不授予点击或填写。
          </p>
        </div>
        {current ? (
          <span className='rounded bg-surface-subtle px-2 py-0.5 font-mono text-label text-muted-foreground'>
            {current.seeded ? '派生首版 (未发布)' : `修订 Rev.${current.revision}`}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className='space-y-5'>
        {query.isPending ? (
          <p className='text-label text-muted-foreground'>授权加载中…</p>
        ) : query.isError ? (
          <p className='text-label text-muted-foreground'>暂时无法读取目标授权。</p>
        ) : current ? (
          <>
            <p className='text-body'>
              {current.seeded
                ? '尚未发布，当前显示从入口/登录派生的首版'
                : `已发布修订 ${current.revision}`}
            </p>

            {current.resourceLoadsUnrestricted ? (
              <Alert>
                <AlertDescription>
                  资源加载仍按现网不拦，不把资源域算进可操作 origin。
                </AlertDescription>
              </Alert>
            ) : null}

            {/* 已生效规则列表 */}
            <div className='space-y-2'>
              <div className='flex items-center gap-2'>
                <ShieldCheck className='size-4 text-primary' />
                <h3 className='text-small font-semibold text-text-primary'>
                  已配置授权边界 ({rules.length} 条)
                </h3>
              </div>

              {rules.length === 0 ? (
                <div className='rounded-lg border border-dashed border-border-card p-4 text-center'>
                  <Shield className='mx-auto size-7 text-muted-foreground' />
                  <p className='mt-1 text-label text-muted-foreground'>
                    还没有可操作授权规则。请在下方追加 Origin。
                  </p>
                </div>
              ) : (
                <ul className='space-y-2 text-body'>
                  {rules.map((rule, index) => (
                    <li
                      key={`${rule.origin}:${rule.purpose}:${rule.effect}:${rule.pathPrefix ?? ''}:${index}`}
                      className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-divider bg-surface-subtle p-3'
                    >
                      <div className='flex flex-wrap items-center gap-2'>
                        <StatusBadge tone={rule.effect === 'allow' ? 'success' : 'warning'}>
                          {rule.effect === 'deny' ? '拒绝' : '允许'}
                        </StatusBadge>
                        <span className='rounded bg-card px-2 py-0.5 text-label font-medium text-text-secondary border border-border-card'>
                          {PURPOSE_LABELS[rule.purpose]}
                        </span>
                        <code className='font-mono text-small text-text-primary'>
                          {rule.origin}
                        </code>
                        <span className='text-label text-muted-foreground'>
                          {rule.pathPrefix ?? '整个 origin'}
                        </span>
                      </div>
                      <span className='sr-only'>
                        {rule.effect === 'deny' ? '拒绝' : '允许'} {PURPOSE_LABELS[rule.purpose]} {rule.origin}{' '}
                        {rule.pathPrefix ?? '整个 origin'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 追加规则表单 */}
            {canWrite ? (
              <div className='rounded-lg border border-border-card p-4 space-y-3 bg-card'>
                <div className='flex items-center gap-1.5'>
                  <Plus className='size-4 text-primary' />
                  <h4 className='text-small font-medium text-text-primary'>添加授权规则</h4>
                </div>
                <div className='grid gap-3 sm:grid-cols-3'>
                  <div className='space-y-1.5 sm:col-span-3'>
                    <Label htmlFor='access-origin'>Origin</Label>
                    <Input
                      id='access-origin'
                      value={origin}
                      onChange={(event) => setOrigin(event.target.value)}
                      placeholder='https://shop.example'
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='access-purpose'>用途</Label>
                    <select
                      id='access-purpose'
                      className='flex h-9 w-full rounded-md border border-input bg-surface-card px-3 text-body focus-visible:outline-2 focus-visible:outline-ring'
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value as TargetAccessPurpose)}
                    >
                      <option value='business_surface'>业务表面</option>
                      <option value='authentication'>认证</option>
                      <option value='resource'>资源加载</option>
                    </select>
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='access-effect'>效果</Label>
                    <select
                      id='access-effect'
                      className='flex h-9 w-full rounded-md border border-input bg-surface-card px-3 text-body focus-visible:outline-2 focus-visible:outline-ring'
                      value={effect}
                      onChange={(event) => setEffect(event.target.value as 'allow' | 'deny')}
                    >
                      <option value='allow'>允许</option>
                      <option value='deny'>拒绝</option>
                    </select>
                  </div>
                  <div className='space-y-1.5 sm:col-span-3'>
                    <Label htmlFor='access-prefix'>可选 pathPrefix</Label>
                    <Input
                      id='access-prefix'
                      value={pathPrefix}
                      onChange={(event) => setPathPrefix(event.target.value)}
                      placeholder='/orders'
                    />
                    <p className='text-label text-muted-foreground'>
                      留空表示整个 origin。`/orders` 含 `/orders/1`，不含 `/orders-admin`。
                    </p>
                  </div>
                  <div className='space-y-1.5 sm:col-span-3'>
                    <Label htmlFor='access-reason'>理由</Label>
                    <Input
                      id='access-reason'
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder='说明为何调整授权'
                    />
                  </div>
                </div>
                <div className='flex justify-end pt-1'>
                  <Button
                    disabled={mutation.isPending || !origin.trim() || !reason.trim()}
                    onClick={() => {
                      const prefix = pathPrefix.trim()
                      const normalized = prefix && !prefix.startsWith('/') ? `/${prefix}` : prefix
                      mutation.mutate([
                        ...rules,
                        {
                          origin: origin.trim(),
                          purpose,
                          effect,
                          ...(normalized ? { pathPrefix: normalized } : {}),
                        },
                      ])
                    }}
                  >
                    {mutation.isPending ? '保存中…' : '保存授权'}
                  </Button>
                </div>
              </div>
            ) : (
              <p className='text-label text-muted-foreground'>需要目标写权限才能改授权。</p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
