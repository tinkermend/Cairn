import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AuthValidationStep, TargetAuthProfileDefinition, TargetDto } from '@cairn/shared'
import { CheckCircle2, Circle, Clock, Edit, ShieldAlert, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchAuthProfileValidation,
  fetchTargetAuthProfile,
  observeAuthProfileValidation,
  publishTargetAuthProfile,
  startAuthProfileValidation,
} from '@/lib/targets-api'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge } from '@/components/status-badge'
import { AUTH_CAPABILITY_LABELS } from './labels'

const STEP_LABELS: Record<AuthValidationStep, { title: string; desc: string }> = {
  valid_pass: {
    title: '有效凭据登录验证',
    desc: '正向探针返回成功状态码且账号身份一致',
  },
  server_revoked: {
    title: '服务端注销失效验证',
    desc: '登录凭据被服务端注销或过期后探针能准确识别失效',
  },
  other_account: {
    title: '异号身份匹配核验',
    desc: '登录账号身份与目标账号期望身份完全匹配，防串号',
  },
}

function defaultDefinition(target: TargetDto): TargetAuthProfileDefinition {
  const origin = new URL(target.entryUrl).origin
  return {
    verify: {
      mode: 'http',
      success: { status: 200 },
      failure: { status: 401 },
    },
    renew: 'none',
    scope: {
      origins: [origin],
      pathPrefixes: ['/'],
    },
  }
}

export function AuthProfileCard({ target }: { target: TargetDto }) {
  const queryClient = useQueryClient()
  const profileQuery = useQuery({
    queryKey: ['target', target.id, 'auth-profile'],
    queryFn: () => fetchTargetAuthProfile(target.id),
  })
  const current = profileQuery.data?.current ?? null
  const definition = current?.definition

  const [editOpen, setEditOpen] = useState(false)
  const [successStatus, setSuccessStatus] = useState(200)
  const [failureStatus, setFailureStatus] = useState(401)
  const [pathPrefix, setPathPrefix] = useState('/')
  const [freshness, setFreshness] = useState('')
  const [operationId, setOperationId] = useState<string | null>(null)

  const validationQuery = useQuery({
    queryKey: ['target', target.id, 'auth-validation', operationId],
    queryFn: () => fetchAuthProfileValidation(target.id, operationId!),
    enabled: Boolean(operationId),
  })

  const publish = useMutation({
    mutationFn: () => {
      const origin = new URL(target.entryUrl).origin
      const nextDefinition = {
        ...defaultDefinition(target),
        verify: {
          mode: 'http' as const,
          success: { status: successStatus },
          failure: { status: failureStatus },
        },
        scope: { origins: [origin], pathPrefixes: [pathPrefix || '/'] },
        ...(freshness ? { freshnessSeconds: Number(freshness) } : {}),
      }
      return publishTargetAuthProfile(target.id, {
        expectedRevision: current?.revision ?? 0,
        definition: nextDefinition,
      })
    },
    onSuccess: async () => {
      toast.success('已发布登录核验规则')
      setEditOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '发布失败')
    },
  })

  const startValidation = useMutation({
    mutationFn: async () => {
      const accountId = profileQuery.data?.accounts[0]?.accountId
      if (!accountId || !current) throw new Error('需要先发布规则并至少有一个账号')
      return startAuthProfileValidation(target.id, {
        targetAccountId: accountId,
        expectedRevision: current.revision,
        idempotencyKey: `validate-${target.id}-${current.revision}-${accountId}`,
      })
    },
    onSuccess: (result) => {
      setOperationId(result.operation.id)
      toast.success(result.created ? '已提交接入验收' : '复用已有接入验收')
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '提交验收失败')
    },
  })

  const observe = useMutation({
    mutationFn: (step: 'valid_pass' | 'server_revoked' | 'other_account') =>
      observeAuthProfileValidation(target.id, operationId!, { step }),
    onSuccess: async () => {
      toast.success('已记录该步核验')
      await queryClient.invalidateQueries({ queryKey: ['target', target.id] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '记录核验失败')
    },
  })

  const derivedCapability = profileQuery.data?.accounts[0]?.capability ?? 'LEGACY'
  const detectionLabel = !current
    ? AUTH_CAPABILITY_LABELS.LEGACY
    : derivedCapability === 'LEGACY'
      ? '规则已发布、验收未齐（登录态检测未开放）'
      : AUTH_CAPABILITY_LABELS[derivedCapability]

  const openEditor = () => {
    if (definition?.verify.mode === 'http') {
      const succ = 'status' in definition.verify.success ? definition.verify.success.status : 200
      const fail = 'status' in definition.verify.failure ? definition.verify.failure.status : 401
      setSuccessStatus(succ ?? 200)
      setFailureStatus(fail ?? 401)
      setPathPrefix(definition.scope.pathPrefixes[0] ?? '/')
      setFreshness(definition.freshnessSeconds ? String(definition.freshnessSeconds) : '')
    }
    setEditOpen(true)
  }

  return (
    <>
      <Card className='min-w-0'>
        <CardHeader className='flex flex-row items-start justify-between gap-3'>
          <div>
            <CardTitle className='text-section font-semibold'>登录态检测（可选）</CardTitle>
            <p className='mt-1 text-label text-muted-foreground'>
              当前修订 {current?.revision ?? '未发布'} · 用于非登录页探活、身份比对、保活与运行中恢复，不是会话是否就绪。
            </p>
          </div>
          <div className='flex flex-wrap items-center gap-2'>
            <Can permission='target:write'>
              <Button variant='outline' size='sm' onClick={openEditor}>
                <Edit className='size-3.5' />
                {current ? '修改规则' : '配置规则'}
              </Button>
            </Can>
          </div>
        </CardHeader>
        <CardContent className='space-y-5'>
          {/* 能力徽章栏 */}
          <div className='flex flex-wrap items-center gap-2'>
            <StatusBadge tone={derivedCapability === 'LEGACY' ? 'neutral' : 'info'}>{detectionLabel}</StatusBadge>
            {current ? (
              <span className='rounded bg-surface-subtle px-2 py-0.5 font-mono text-label text-muted-foreground'>
                修订版本 Rev.{current.revision}
              </span>
            ) : null}
          </div>

          {/* 生效规则参数摘要 */}
          {current && definition ? (
            <div className='rounded-lg border border-border-divider bg-surface-subtle p-4'>
              <div className='mb-3 flex items-center justify-between'>
                <span className='text-small font-medium text-text-primary'>已生效探针参数</span>
                <span className='text-label text-muted-foreground'>
                  探测方式：{definition.verify.mode === 'http' ? 'HTTP 响应比对' : '页面 DOM 定位'}
                </span>
              </div>
              <div className='grid grid-cols-2 gap-4 text-small sm:grid-cols-4'>
                <div>
                  <span className='block text-label text-muted-foreground'>成功状态码</span>
                  <span className='font-mono font-medium text-text-primary'>
                    {definition.verify.mode === 'http' && 'status' in definition.verify.success
                      ? definition.verify.success.status ?? 200
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className='block text-label text-muted-foreground'>失效状态码</span>
                  <span className='font-mono font-medium text-text-primary'>
                    {definition.verify.mode === 'http' && 'status' in definition.verify.failure
                      ? definition.verify.failure.status ?? 401
                      : '—'}
                  </span>
                </div>
                <div>
                  <span className='block text-label text-muted-foreground'>核验路径</span>
                  <span className='font-mono font-medium text-text-primary'>
                    {definition.scope.pathPrefixes[0] || '/'}
                  </span>
                </div>
                <div>
                  <span className='block text-label text-muted-foreground'>新鲜度阈值</span>
                  <span className='font-medium text-text-primary'>
                    {definition.freshnessSeconds ? `${definition.freshnessSeconds} 秒` : '平台默认 (300s)'}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className='rounded-lg border border-dashed border-border-card p-4 text-center'>
              <ShieldAlert className='mx-auto size-8 text-muted-foreground' />
              <p className='mt-2 text-small text-text-secondary'>未配置登录态检测</p>
              <p className='mt-1 text-label text-muted-foreground'>
                会话过期后若回到登录页，将按已录入的登录框和口令自动重登。需要在非登录页探活或后台保活时再配置规则。
              </p>
              <Can permission='target:write'>
                <Button size='sm' className='mt-3' onClick={openEditor}>
                  配置登录态检测
                </Button>
              </Can>
            </div>
          )}

          {/* 接入验收步进向导 */}
          <div className='space-y-3 rounded-lg border border-border-card p-4'>
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <div className='flex items-center gap-2'>
                <Sparkles className='size-4 text-primary' />
                <h3 className='text-small font-semibold text-text-primary'>
                  接入验收
                </h3>
              </div>
              <Can permission='target:write'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={!current || startValidation.isPending}
                  onClick={() => startValidation.mutate()}
                >
                  {startValidation.isPending ? '提交验收中…' : '发起接入验收'}
                </Button>
              </Can>
            </div>
            <p className='text-label text-muted-foreground'>
              用于在非登录页上探活、核验身份、后台保活或运行中恢复。日常准备会话与开跑不依赖此验收。
            </p>

            <div className='space-y-2 pt-1'>
              {(['valid_pass', 'server_revoked', 'other_account'] as const).map((stepKey, idx) => {
                const info = STEP_LABELS[stepKey]
                const isPassed = current?.validation?.steps?.[stepKey] !== undefined
                const isRequired = validationQuery.data?.requiredSteps.includes(stepKey)
                const isCurrent = validationQuery.data?.currentStep === stepKey

                return (
                  <div
                    key={stepKey}
                    className='flex flex-wrap items-center justify-between gap-2 rounded-md border border-border-divider p-3 text-body'
                  >
                    <div className='flex items-start gap-3'>
                      <div className='mt-0.5'>
                        {isPassed ? (
                          <CheckCircle2 className='size-4 text-primary' />
                        ) : isCurrent ? (
                          <Clock className='size-4 text-muted-foreground' />
                        ) : (
                          <Circle className='size-4 text-muted-foreground' />
                        )}
                      </div>
                      <div>
                        <div className='flex items-center gap-2'>
                          <span className='font-medium text-text-primary'>
                            步骤 {idx + 1}：{info.title}
                          </span>
                          {isPassed ? (
                            <StatusBadge tone='success'>已通过</StatusBadge>
                          ) : isCurrent ? (
                            <StatusBadge tone='info'>待记录</StatusBadge>
                          ) : (
                            <span className='text-label text-muted-foreground'>未开始</span>
                          )}
                        </div>
                        <p className='mt-0.5 text-label text-muted-foreground'>{info.desc}</p>
                      </div>
                    </div>
                    {isRequired && isCurrent ? (
                      <Can permission='target:write'>
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={observe.isPending}
                          onClick={() => observe.mutate(stepKey)}
                        >
                          记录此步核验
                        </Button>
                      </Can>
                    ) : null}
                  </div>
                )
              })}
            </div>

            {validationQuery.data ? (
              <div className='mt-2 rounded bg-surface-subtle p-2.5 text-label text-muted-foreground'>
                当前验收批次：状态「{validationQuery.data.status}」
                {validationQuery.data.currentStep ? ` · 当前执行步骤：${validationQuery.data.currentStep}` : ''}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* 规则编辑受控弹窗 */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle className='text-section font-semibold'>配置登录核验规则</DialogTitle>
            <DialogDescription className='text-small text-muted-foreground'>
              设定目标系统的正向成功判定与失效判定条件。发布后将产生新的规则修订版本。
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 py-2 text-body'>
            <div className='grid grid-cols-2 gap-3'>
              <div className='space-y-1'>
                <Label htmlFor='auth-success-status'>成功状态码</Label>
                <Input
                  id='auth-success-status'
                  type='number'
                  value={successStatus}
                  onChange={(event) => setSuccessStatus(Number(event.target.value))}
                />
              </div>
              <div className='space-y-1'>
                <Label htmlFor='auth-failure-status'>失效状态码</Label>
                <Input
                  id='auth-failure-status'
                  type='number'
                  value={failureStatus}
                  onChange={(event) => setFailureStatus(Number(event.target.value))}
                />
              </div>
            </div>
            <div className='space-y-1'>
              <Label htmlFor='auth-path'>核验路径 (相对入口 Origin)</Label>
              <Input
                id='auth-path'
                value={pathPrefix}
                onChange={(event) => setPathPrefix(event.target.value)}
                placeholder='/'
              />
            </div>
            <div className='space-y-1'>
              <Label htmlFor='auth-freshness'>新鲜度覆盖（秒，留空使用平台默认 300s）</Label>
              <Input
                id='auth-freshness'
                type='number'
                value={freshness}
                onChange={(event) => setFreshness(event.target.value)}
                placeholder='300'
              />
            </div>
          </div>
          <DialogFooter className='gap-2 sm:justify-end'>
            <Button variant='outline' onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button disabled={publish.isPending} onClick={() => publish.mutate()}>
              {publish.isPending ? '发布中…' : '发布规则'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
