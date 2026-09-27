import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TargetAccessPurpose, TargetAccessRule, TargetAccessPolicy } from '@cairn/shared'
import { Plus, Shield, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchTargetAccessPolicy,
  updateTargetAccessPolicy,
} from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { StatusBadge } from '@/components/status-badge'

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
  const [purpose, setPurpose] =
    useState<TargetAccessPurpose>('business_surface')
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow')
  const [reason, setReason] = useState('')
  const [postOrigin, setPostOrigin] = useState('')
  const [postPath, setPostPath] = useState('')
  const [nonContentOrigin, setNonContentOrigin] = useState('')
  const [nonContentPath, setNonContentPath] = useState('')
  const [nonContentResourceType, setNonContentResourceType] = useState<'xhr' | 'fetch'>('xhr')
  const [nonContentEvidence, setNonContentEvidence] = useState('')

  const query = useQuery({
    queryKey: ['target', targetId, 'access-policy'],
    queryFn: () => fetchTargetAccessPolicy(targetId),
    enabled: canRead,
  })

  const mutation = useMutation({
    mutationFn: (change: {
      rules: TargetAccessRule[]
      readOnlyRequests: TargetAccessPolicy['readOnlyRequests']
      verifiedNonContentRequests?: NonNullable<TargetAccessPolicy['verifiedNonContentRequests']>
      postReadMode?: 'explicit' | 'balanced'
    }) =>
      updateTargetAccessPolicy(targetId, {
        expectedRevision: query.data?.revision ?? 0,
        idempotencyKey: `access:${Date.now()}`,
        ...change,
        verifiedNonContentRequests: change.verifiedNonContentRequests
          ?? query.data?.policy?.verifiedNonContentRequests ?? [],
        postReadMode: change.postReadMode ?? query.data?.policy?.postReadMode ?? 'explicit',
        reason: reason.trim() || (change.postReadMode === 'balanced'
          ? '启用地图采集 POST 平衡模式'
          : change.postReadMode === 'explicit' ? '恢复地图采集 POST 显式规则模式' : '更新访问范围'),
      }),
    onSuccess: () => {
      toast.success('已更新访问范围')
      setReason('')
      setOrigin('')
      setPathPrefix('')
      setPostOrigin('')
      setPostPath('')
      setNonContentOrigin('')
      setNonContentPath('')
      setNonContentEvidence('')
      void queryClient.invalidateQueries({
        queryKey: ['target', targetId, 'access-policy'],
      })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '更新访问范围失败'
      )
    },
  })

  if (!canRead) return null
  const current = query.data
  const rules = current?.policy?.rules ?? []
  const readOnlyRequests = current?.policy?.readOnlyRequests ?? []
  const postReadMode = current?.policy?.postReadMode ?? 'explicit'
  const verifiedNonContentRequests = current?.policy?.verifiedNonContentRequests ?? []
  const validNonContentOrigin = (() => {
    try {
      const url = new URL(nonContentOrigin.trim())
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
        && url.pathname === '/' && !url.search && !url.hash
    } catch { return false }
  })()
  const validNonContentPath = nonContentPath.startsWith('/') && nonContentPath.length <= 512
    && !/[?#*]/.test(nonContentPath)

  return (
    <Card className='min-w-0'>
      <CardHeader className='flex flex-row items-start justify-between gap-3'>
        <div>
          <CardTitle className='text-section font-semibold'>访问范围</CardTitle>
          <p className='mt-1 text-label text-muted-foreground'>
            正式运行与地图作业共用这份 origin
            用途上限。资源域单独标明，不授予点击或填写。
          </p>
        </div>
        {current ? (
          <span className='rounded bg-surface-subtle px-2 py-0.5 font-mono text-label text-muted-foreground'>
            {current.seeded
              ? '派生首版 (未发布)'
              : `修订 Rev.${current.revision}`}
          </span>
        ) : null}
      </CardHeader>
      <CardContent className='space-y-5'>
        {query.isPending ? (
          <p className='text-label text-muted-foreground'>授权加载中…</p>
        ) : query.isError ? (
          <p className='text-label text-muted-foreground'>
            暂时无法读取访问范围。
          </p>
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
                        <StatusBadge
                          tone={rule.effect === 'allow' ? 'success' : 'warning'}
                        >
                          {rule.effect === 'deny' ? '拒绝' : '允许'}
                        </StatusBadge>
                        <span className='rounded border border-border-card bg-card px-2 py-0.5 text-label font-medium text-text-secondary'>
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
                        {rule.effect === 'deny' ? '拒绝' : '允许'}{' '}
                        {PURPOSE_LABELS[rule.purpose]} {rule.origin}{' '}
                        {rule.pathPrefix ?? '整个 origin'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 追加规则表单 */}
            {canWrite ? (
              <div className='space-y-3 rounded-lg border border-border-card bg-card p-4'>
                <div className='flex items-center gap-1.5'>
                  <Plus className='size-4 text-primary' />
                  <h4 className='text-small font-medium text-text-primary'>
                    添加授权规则
                  </h4>
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
                    <SelectField
                      id='access-purpose'
                      className='w-full'
                      value={purpose}
                      onValueChange={(value) =>
                        setPurpose(value as TargetAccessPurpose)
                      }
                    >
                      <SelectFieldOption value='business_surface'>
                        业务表面
                      </SelectFieldOption>
                      <SelectFieldOption value='authentication'>
                        认证
                      </SelectFieldOption>
                      <SelectFieldOption value='resource'>
                        资源加载
                      </SelectFieldOption>
                    </SelectField>
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='access-effect'>效果</Label>
                    <SelectField
                      id='access-effect'
                      className='w-full'
                      value={effect}
                      onValueChange={(value) =>
                        setEffect(value as 'allow' | 'deny')
                      }
                    >
                      <SelectFieldOption value='allow'>允许</SelectFieldOption>
                      <SelectFieldOption value='deny'>拒绝</SelectFieldOption>
                    </SelectField>
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
                      留空表示整个 origin。`/orders` 含 `/orders/1`，不含
                      `/orders-admin`。
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
                    disabled={
                      mutation.isPending || !origin.trim() || !reason.trim()
                    }
                    onClick={() => {
                      const prefix = pathPrefix.trim()
                      const normalized =
                        prefix && !prefix.startsWith('/')
                          ? `/${prefix}`
                          : prefix
                      mutation.mutate({
                        rules: [...rules, {
                          origin: origin.trim(), purpose, effect,
                          ...(normalized ? { pathPrefix: normalized } : {}),
                        }],
                        readOnlyRequests,
                      })
                    }}
                  >
                    {mutation.isPending ? '保存中…' : '保存授权'}
                  </Button>
                </div>
              </div>
            ) : (
              <p className='text-label text-muted-foreground'>
                需要目标写权限才能改授权。
              </p>
            )}

            <div className='space-y-3 border-t border-border-divider pt-5'>
              <div>
                <h3 className='text-small font-semibold text-text-primary'>地图采集中的 POST 查询</h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  当前为{postReadMode === 'balanced' ? '平衡模式' : '显式规则模式'}。平衡模式仅在地图采集时，对业务授权域内的 XHR/fetch POST 按请求意图作有限推断；放行记录会单独审计，推断不等于已证明只读。无法归类的请求仍会阻断并使页面部分完成。
                </p>
              </div>
              {canWrite ? <Button variant='outline' disabled={mutation.isPending} onClick={() => mutation.mutate({
                rules, readOnlyRequests, postReadMode: postReadMode === 'balanced' ? 'explicit' : 'balanced',
              })}>{postReadMode === 'balanced' ? '恢复显式规则模式' : '启用平衡模式'}</Button> : null}
            </div>
            <div className='space-y-3 border-t border-border-divider pt-5'>
              <div>
                <h3 className='text-small font-semibold text-text-primary'>只读 POST 请求</h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  为已确认的查询端点配置精确路径；优先于平衡模式判定。
                </p>
              </div>
              {readOnlyRequests.length ? (
                <ul className='space-y-2'>
                  {readOnlyRequests.map((item, index) => (
                    <li key={`${item.origin}:${item.pathPattern}:${index}`} className='flex items-center justify-between gap-2 rounded-md border border-border-divider bg-surface-subtle p-3'>
                      <span className='min-w-0 break-all font-mono text-small'>POST {item.origin}{item.pathPattern}</span>
                      {canWrite ? <Button variant='outline' size='sm' disabled={mutation.isPending} onClick={() => mutation.mutate({ rules, readOnlyRequests: readOnlyRequests.filter((_, position) => position !== index) })}>移除</Button> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className='text-label text-muted-foreground'>尚未配置；默认阻断非 GraphQL POST。</p>}
              {canWrite ? (
                <div className='grid gap-3 rounded-lg border border-border-card p-4 sm:grid-cols-2'>
                  <div className='space-y-1.5'><Label htmlFor='readonly-post-origin'>来源站点</Label><Input id='readonly-post-origin' value={postOrigin} onChange={event => setPostOrigin(event.target.value)} placeholder='https://shop.example' /></div>
                  <div className='space-y-1.5'><Label htmlFor='readonly-post-path'>精确路径</Label><Input id='readonly-post-path' value={postPath} onChange={event => setPostPath(event.target.value)} placeholder='/api/list' /></div>
                  <div className='sm:col-span-2 flex justify-end'>
                    <Button variant='outline' disabled={mutation.isPending || !postOrigin.trim() || !postPath.startsWith('/')} onClick={() => mutation.mutate({ rules, readOnlyRequests: [...readOnlyRequests, { method: 'POST', origin: postOrigin.trim(), pathPattern: postPath.trim() }] })}>添加只读规则</Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className='space-y-3 border-t border-border-divider pt-5'>
              <div>
                <h3 className='text-small font-semibold text-text-primary'>已核实的非页面数据请求</h3>
                <p className='mt-1 text-label text-muted-foreground'>
                  请求仍会被拦截并记录。仅对已核实不参与页面内容的 POST，按来源、精确路径和 XHR/fetch 类型排除完整性影响；未匹配请求仍使页面标记为部分完成。
                </p>
              </div>
              {verifiedNonContentRequests.length ? (
                <ul className='space-y-2'>
                  {verifiedNonContentRequests.map((item, index) => (
                    <li key={`${item.origin}:${item.pathPattern}:${item.resourceType}:${index}`} className='flex flex-wrap items-start justify-between gap-2 rounded-md border border-border-divider bg-surface-subtle p-3'>
                      <div className='min-w-0 space-y-1'>
                        <div className='break-all font-mono text-small'>POST · {item.resourceType.toUpperCase()} · {item.origin}{item.pathPattern}</div>
                        <p className='text-label text-muted-foreground'>{item.evidence}</p>
                      </div>
                      {canWrite ? <Button variant='outline' size='sm' disabled={mutation.isPending} onClick={() => mutation.mutate({ rules, readOnlyRequests, verifiedNonContentRequests: verifiedNonContentRequests.filter((_, position) => position !== index) })}>移除</Button> : null}
                    </li>
                  ))}
                </ul>
              ) : <p className='text-label text-muted-foreground'>尚无核实规则；未知 XHR/fetch 拦截均影响完整性。</p>}
              {canWrite ? (
                <div className='grid gap-3 rounded-lg border border-border-card p-4 sm:grid-cols-2'>
                  <div className='space-y-1.5'><Label htmlFor='non-content-origin'>请求来源站点</Label><Input id='non-content-origin' value={nonContentOrigin} onChange={event => setNonContentOrigin(event.target.value)} placeholder='https://metrics.example' /><p className='text-label text-muted-foreground'>填写 http(s) Origin，不含路径或查询。</p></div>
                  <div className='space-y-1.5'><Label htmlFor='non-content-path'>请求精确路径</Label><Input id='non-content-path' value={nonContentPath} onChange={event => setNonContentPath(event.target.value)} placeholder='/collect' /><p className='text-label text-muted-foreground'>不含查询参数或通配符。</p></div>
                  <div className='space-y-1.5'><Label htmlFor='non-content-type'>浏览器请求类型</Label><SelectField id='non-content-type' className='w-full' value={nonContentResourceType} onValueChange={value => setNonContentResourceType(value as 'xhr' | 'fetch')}><SelectFieldOption value='xhr'>XHR</SelectFieldOption><SelectFieldOption value='fetch'>fetch</SelectFieldOption></SelectField></div>
                  <div className='space-y-1.5 sm:col-span-2'><Label htmlFor='non-content-evidence'>核实依据</Label><Input id='non-content-evidence' value={nonContentEvidence} onChange={event => setNonContentEvidence(event.target.value)} placeholder='说明请求用途及为何不参与页面内容' /></div>
                  <div className='sm:col-span-2 flex justify-end'>
                    <Button variant='outline' disabled={mutation.isPending || !validNonContentOrigin || !validNonContentPath || nonContentEvidence.trim().length < 12} onClick={() => mutation.mutate({ rules, readOnlyRequests, verifiedNonContentRequests: [...verifiedNonContentRequests, { method: 'POST', resourceType: nonContentResourceType, origin: nonContentOrigin.trim(), pathPattern: nonContentPath.trim(), evidence: nonContentEvidence.trim() }] })}>添加核实规则</Button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
