import { useId, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  SERVICE_SCOPES,
  issueServiceCredentialSchema,
  serviceCallerBodySchema,
  serviceCredentialPolicySchema,
  type ServiceCallerDto,
  type ServiceCredentialDto,
  type ServiceCredentialPolicy,
  type ServiceScope,
} from '@cairn/shared'
import { toast } from 'sonner'
import {
  issueCredential,
  saveService,
  updateCredential,
} from '@/lib/services-api'
import { fetchTargets, fetchTargetAccounts } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'

export const SCOPE_LABELS: Record<ServiceScope, string> = {
  'run:execute': '执行已发布场景',
  'run:read': '查看本应用的运行',
  'run:cancel': '取消本应用的运行',
  'evidence:read': '读取已发布证据',
  'ai:execute': '执行 AI 步骤',
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '保存失败，请重试'
export function CallerDialog({
  caller,
  onClose,
  onSaved,
}: {
  caller?: ServiceCallerDto
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const id = useId(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const data = new FormData(event.currentTarget)
    const parsed = serviceCallerBodySchema.safeParse({
      name: data.get('name'),
      owner: data.get('owner'),
      status: data.get('status'),
      requestsPerMinute: Number(data.get('rpm')),
      maxOutstandingRuns: Number(data.get('capacity')),
      runTimeoutSeconds: Number(data.get('timeout')),
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message)
      return
    }
    setBusy(true)
    try {
      const result = await saveService(caller?.id ?? null, parsed.data)
      onSaved(result.caller.id)
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {caller ? '编辑服务调用方' : '新建服务调用方'}
          </DialogTitle>
          <DialogDescription>
            一个外部应用对应一个调用方，多把 Key 共享调用频率和执行额度。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className='space-y-4'>
          <label htmlFor={`${id}-name`} className='block space-y-2 text-small'>
            <span>应用名称</span>
            <Input
              id={`${id}-name`}
              name='name'
              required
              maxLength={128}
              defaultValue={caller?.name}
            />
          </label>
          <label htmlFor={`${id}-owner`} className='block space-y-2 text-small'>
            <span>负责人</span>
            <Input
              id={`${id}-owner`}
              name='owner'
              required
              maxLength={128}
              defaultValue={caller?.owner}
            />
          </label>
          <div className='grid gap-4 sm:grid-cols-2'>
            <label htmlFor={`${id}-rpm`} className='space-y-2 text-small'>
              <span>每分钟请求上限</span>
              <Input
                id={`${id}-rpm`}
                name='rpm'
                type='number'
                min={1}
                max={600}
                required
                defaultValue={caller?.requestsPerMinute ?? 60}
              />
            </label>
            <label htmlFor={`${id}-capacity`} className='space-y-2 text-small'>
              <span>未结束运行上限</span>
              <Input
                id={`${id}-capacity`}
                name='capacity'
                type='number'
                min={1}
                max={20}
                required
                defaultValue={caller?.maxOutstandingRuns ?? 2}
              />
            </label>
          </div>
          <p className='text-small text-muted-foreground'>
            排队、执行、恢复、等待登录和待核查均占用额度。
          </p>
          <label
            htmlFor={`${id}-timeout`}
            className='block space-y-2 text-small'
          >
            <span>总执行时限（秒）</span>
            <Input
              id={`${id}-timeout`}
              name='timeout'
              type='number'
              min={1}
              max={3600}
              required
              defaultValue={caller?.runTimeoutSeconds ?? 600}
            />
          </label>
          <label
            htmlFor={`${id}-status`}
            className='block space-y-2 text-small'
          >
            <span>服务状态</span>
            <select
              id={`${id}-status`}
              name='status'
              defaultValue={caller?.status ?? 'active'}
              className='h-10 w-full rounded-md border bg-background px-3'
            >
              <option value='active'>启用</option>
              <option value='disabled'>停用</option>
            </select>
          </label>
          <p className='text-small text-muted-foreground'>
            停用立即阻止新 API
            调用；已接纳的运行继续遵循原时限，可在运行页取消。
          </p>
          {error && (
            <p role='alert' className='text-small text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button type='submit' disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
function AccountChoices({
  targetId,
  grant,
  onChange,
}: {
  targetId: string
  grant: ServiceCredentialPolicy['grants'][number]
  onChange: (g: typeof grant) => void
}) {
  const query = useQuery({
    queryKey: ['targets', targetId, 'accounts'],
    queryFn: () => fetchTargetAccounts(targetId),
  })
  if (query.isPending)
    return <p className='text-small text-muted-foreground'>加载目标账号…</p>
  if (query.isError)
    return (
      <QueryErrorState
        title='无法加载目标账号'
        onRetry={() => void query.refetch()}
      />
    )
  return (
    <div className='space-y-2 border-l pl-4'>
      {query.data.items.map((account) => (
        <label
          key={account.id}
          className='flex min-h-9 items-center gap-2 text-small'
        >
          <input
            type='checkbox'
            className='size-4 accent-primary'
            checked={grant.accountIds.includes(account.id)}
            onChange={(event) =>
              onChange({
                ...grant,
                accountIds: event.target.checked
                  ? [...grant.accountIds, account.id]
                  : grant.accountIds.filter((id) => id !== account.id),
              })
            }
          />
          <span>
            {account.displayName}{' '}
            <span className='text-muted-foreground'>({account.username})</span>
          </span>
        </label>
      ))}
      {!query.data.items.length && (
        <p className='text-small text-muted-foreground'>
          该目标系统还没有账号。
        </p>
      )}
      <label className='flex min-h-9 items-center gap-2 text-small'>
        <input
          type='checkbox'
          className='size-4 accent-primary'
          checked={grant.allowAnonymous}
          onChange={(event) =>
            onChange({ ...grant, allowAnonymous: event.target.checked })
          }
        />
        允许无账号任务（浏览器步骤仍需目标账号）
      </label>
    </div>
  )
}
export function CredentialDialog({
  callerId,
  credential,
  rotate = false,
  onClose,
  onSaved,
}: {
  callerId: string
  credential?: ServiceCredentialDto
  rotate?: boolean
  onClose: () => void
  onSaved: (token?: string) => void
}) {
  const id = useId(),
    editing = !!credential && !rotate
  const [name, setName] = useState(
    credential ? `${credential.name}${rotate ? '（轮换）' : ''}` : ''
  )
  const [scopes, setScopes] = useState<ServiceScope[]>(
    credential?.scopes ?? ['run:execute', 'run:read', 'run:cancel']
  )
  const [grants, setGrants] = useState<ServiceCredentialPolicy['grants']>(
    credential?.grants ?? []
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const targets = useQuery({ queryKey: ['targets'], queryFn: fetchTargets })
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const parsed = editing
      ? serviceCredentialPolicySchema.safeParse({ name, scopes, grants })
      : issueServiceCredentialSchema.safeParse({
          name,
          scopes,
          grants,
          expiresInDays: Number(
            new FormData(event.currentTarget).get('expires')
          ),
        })
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message)
      return
    }
    setBusy(true)
    try {
      if (editing) {
        await updateCredential(callerId, credential.id, parsed.data)
        onSaved()
      } else {
        const issued = await issueCredential(
          callerId,
          issueServiceCredentialSchema.parse(parsed.data)
        )
        onSaved(issued.token)
      }
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className='max-h-[90dvh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            {editing
              ? '编辑凭据授权'
              : rotate
                ? '轮换服务凭据'
                : '签发服务凭据'}
          </DialogTitle>
          <DialogDescription>
            {rotate
              ? '先签发新 Key，外部应用切换完成后再吊销旧 Key。'
              : '允许调用所选目标下的全部已发布场景；目标账号逐项授权，新增目标和账号不会自动授权。'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className='space-y-5'>
          <label htmlFor={`${id}-name`} className='block space-y-2 text-small'>
            <span>凭据名称</span>
            <Input
              id={`${id}-name`}
              required
              maxLength={128}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <fieldset className='space-y-2'>
            <legend className='mb-2 text-small font-medium'>可调用能力</legend>
            <div className='grid gap-1 sm:grid-cols-2'>
              {SERVICE_SCOPES.map((scope) => (
                <label
                  key={scope}
                  className='flex min-h-10 items-center gap-2 text-small'
                >
                  <input
                    type='checkbox'
                    className='size-4 accent-primary'
                    checked={scopes.includes(scope)}
                    onChange={(e) =>
                      setScopes(
                        e.target.checked
                          ? [...scopes, scope]
                          : scopes.filter((s) => s !== scope)
                      )
                    }
                  />
                  {SCOPE_LABELS[scope]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className='space-y-3'>
            <legend className='mb-2 text-small font-medium'>
              目标系统与账号范围
            </legend>
            {targets.isPending ? (
              <PageSkeleton />
            ) : targets.isError ? (
              <QueryErrorState
                title='无法加载目标系统，请确认具备目标查看权限'
                onRetry={() => void targets.refetch()}
              />
            ) : (
              targets.data.items.map((target) => {
                const grant = grants.find((g) => g.targetId === target.id)
                return (
                  <div
                    key={target.id}
                    className='space-y-2 rounded-md border bg-card p-3'
                  >
                    <label className='flex min-h-9 items-center gap-2 text-small font-medium'>
                      <input
                        type='checkbox'
                        className='size-4 accent-primary'
                        checked={!!grant}
                        onChange={(e) =>
                          setGrants(
                            e.target.checked
                              ? [
                                  ...grants,
                                  {
                                    targetId: target.id,
                                    accountIds: [],
                                    allowAnonymous: false,
                                  },
                                ]
                              : grants.filter((g) => g.targetId !== target.id)
                          )
                        }
                      />
                      {target.name}
                      {target.status === 'disabled' && (
                        <span className='text-muted-foreground'>
                          （已停用）
                        </span>
                      )}
                    </label>
                    {grant && (
                      <AccountChoices
                        targetId={target.id}
                        grant={grant}
                        onChange={(next) =>
                          setGrants(
                            grants.map((g) =>
                              g.targetId === target.id ? next : g
                            )
                          )
                        }
                      />
                    )}
                  </div>
                )
              })
            )}
            {!targets.isPending &&
              !targets.isError &&
              !targets.data.items.length && (
                <p className='text-small text-muted-foreground'>
                  请先在目标系统页面登记系统与账号。
                </p>
              )}
            {!grants.length && (
              <p className='text-small text-status-warning-foreground'>
                尚未授权目标系统，此 Key 暂时无法执行任务。
              </p>
            )}
          </fieldset>
          {!editing && (
            <label
              htmlFor={`${id}-expires`}
              className='block space-y-2 text-small'
            >
              <span>有效期（天）</span>
              <Input
                id={`${id}-expires`}
                name='expires'
                type='number'
                min={1}
                max={365}
                defaultValue={90}
                required
              />
            </label>
          )}
          {error && (
            <p role='alert' className='text-small text-destructive'>
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              type='submit'
              disabled={busy || targets.isPending || targets.isError}
            >
              {busy ? '保存中…' : editing ? '保存授权' : '签发 Key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
export function TokenDialog({
  token,
  onClose,
}: {
  token: string
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>保存服务凭据</DialogTitle>
          <DialogDescription>
            完整 Key
            仅显示这一次。请保存到外部应用的凭据管理处，关闭后无法再次查看。
          </DialogDescription>
        </DialogHeader>
        <code
          className='block rounded-md bg-muted p-4 text-small break-all'
          data-testid='issued-service-token'
        >
          {token}
        </code>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() =>
              void navigator.clipboard
                .writeText(token)
                .then(() => toast.success('已复制'))
                .catch(() => toast.error('复制失败，请手动选择并复制'))
            }
          >
            复制 Key
          </Button>
          <Button onClick={onClose}>已保存，关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
