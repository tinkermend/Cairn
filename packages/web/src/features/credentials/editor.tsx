import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CredentialListItem } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  clearCredential,
  fetchCredentialOwners,
  replaceCredential,
  updateCredentialMetadata,
} from '@/lib/credentials-api'
import { updateTargetAccount } from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PasswordInput } from '@/components/password-input'
import {
  defaultValidityFields,
  localDateTime,
  toValidityWrite,
  ValidityInput,
} from './validity-fields'

export type CredentialAction =
  'account' | 'password' | 'validity' | 'owner' | 'clear' | 'delete'
const titles: Record<CredentialAction, string> = {
  account: '编辑账号',
  password: '更新密码',
  validity: '设置有效期',
  owner: '设置负责人',
  clear: '清除已保存密码',
  delete: '删除凭据登记',
}

export function CredentialEditor({
  item,
  action,
  onClose,
}: {
  item: CredentialListItem
  action: CredentialAction
  onClose: (removed?: boolean) => void
}) {
  const client = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState(item.target?.accountName ?? item.name)
  const [username, setUsername] = useState(
    item.target?.username ?? item.safeIdentifier
  )
  const [password, setPassword] = useState('')
  const [validity, setValidity] = useState(
    defaultValidityFields(item.validityPolicy)
  )
  const [startedAt, setStartedAt] = useState(
    action === 'password' ? '' : localDateTime(item.validityStartedAt)
  )
  const [owner, setOwner] = useState(item.ownerConsoleAccountId ?? 'none')
  const [confirmedIdentity, setConfirmedIdentity] = useState(false)
  const owners = useQuery({
    queryKey: ['credentials', item.id, 'owners'],
    queryFn: () => fetchCredentialOwners(item.id),
    enabled: action === 'owner',
  })
  const save = async () => {
    setSaving(true)
    setError('')
    try {
      if (action === 'account') {
        if (
          !item.targetId ||
          !item.targetAccountId ||
          !name.trim() ||
          !username.trim()
        )
          throw new Error('请填写账号名称与登录名')
        await updateTargetAccount(item.targetId, item.targetAccountId, {
          displayName: name,
          username,
          expectedRevision: item.revision,
          ...(confirmedIdentity ? { confirmIdentityMaterial: true } : {}),
        })
      } else if (action === 'password') {
        if (password.length === 0 || password.length > 256)
          throw new Error('请填写 1–256 字符的新密码')
        await replaceCredential(item.id, {
          expectedRevision: item.revision,
          password,
          validity: {
            ...toValidityWrite(validity),
            ...(startedAt
              ? { startedAt: new Date(startedAt).toISOString() }
              : {}),
          },
        })
      } else if (action === 'validity') {
        if (validity.validityMode !== 'permanent' && !startedAt)
          throw new Error('请填写有效期的起算时间')
        await updateCredentialMetadata(item.id, {
          expectedRevision: item.revision,
          validity: toValidityWrite(validity),
          ...(startedAt && startedAt !== localDateTime(item.validityStartedAt)
            ? { startedAt: new Date(startedAt).toISOString() }
            : {}),
        })
      } else if (action === 'owner') {
        await updateCredentialMetadata(item.id, {
          expectedRevision: item.revision,
          ownerConsoleAccountId: owner === 'none' ? null : owner,
        })
      } else
        await clearCredential(
          item.id,
          { expectedRevision: item.revision },
          action === 'delete'
        )
      setPassword('')
      await Promise.all([
        client.invalidateQueries({ queryKey: ['credentials'] }),
        client.invalidateQueries({ queryKey: ['target', item.targetId] }),
        client.invalidateQueries({ queryKey: ['targets'] }),
      ])
      toast.success(
        action === 'password'
          ? '密码已保存，登录状态尚未检查'
          : `${titles[action]}已完成`
      )
      onClose(action === 'delete')
    } catch (e) {
      setError(
        e instanceof ApiRequestError
          ? e.message
          : e instanceof Error && e.name !== 'ZodError'
            ? e.message
            : '请检查有效期数量、时区和起算时间'
      )
    } finally {
      setSaving(false)
    }
  }
  if (action === 'clear' || action === 'delete')
    return (
      <ConfirmDialog
        open
        onOpenChange={(v) => {
          if (!v && !saving) onClose()
        }}
        title={titles[action]}
        confirmText={titles[action]}
        destructive
        isLoading={saving}
        handleConfirm={() => void save()}
        desc={
          <div className='space-y-3'>
            <p>
              {item.subjectLabel} · {item.name}（{item.safeIdentifier}）
            </p>
            <p>
              {action === 'delete'
                ? '删除此账号的凭据登记并清除保存的密码，目标账号及历史记录仍会保留。'
                : '清除本平台保存的密码，账号和有效期信息仍会保留。'}
            </p>
            <p>
              后续自动登录需要重新录入密码。存在未完成运行或账号正在使用时会拒绝操作。
            </p>
            {error && (
              <p role='alert' className='text-destructive'>
                {error}
              </p>
            )}
          </div>
        }
      />
    )
  return (
    <Sheet
      open
      onOpenChange={(v) => {
        if (!v && !saving) {
          setPassword('')
          onClose()
        }
      }}
    >
      <SheetContent className='w-full overflow-y-auto sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>{titles[action]}</SheetTitle>
          <SheetDescription>
            {item.subjectLabel} · {item.name} · {item.safeIdentifier}
          </SheetDescription>
        </SheetHeader>
        <form
          className='space-y-5 p-4'
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          {action === 'account' && (
            <>
              <label className='block space-y-2'>
                <Label>账号名称</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={128}
                />
              </label>
              <label className='block space-y-2'>
                <Label>登录名</Label>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  maxLength={256}
                />
              </label>
              {username !== (item.target?.username ?? item.safeIdentifier) && (
                <label className='flex items-start gap-2 text-label'>
                  <input
                    type='checkbox'
                    checked={confirmedIdentity}
                    onChange={(e) => setConfirmedIdentity(e.target.checked)}
                  />
                  确认原密码仍适用于新登录名。未确认时，自动登录将等待重新核对。
                </label>
              )}
              <p className='text-label text-muted-foreground'>
                这里与目标系统页面编辑的是同一个账号。
              </p>
            </>
          )}
          {action === 'password' && (
            <>
              <label className='block space-y-2'>
                <Label>新密码</Label>
                <PasswordInput
                  autoComplete='new-password'
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={256}
                />
              </label>
              <p className='text-label text-muted-foreground'>
                保存目标系统已经设置的新密码。此操作不会替你修改目标系统上的密码。
              </p>
            </>
          )}
          {(action === 'password' || action === 'validity') && (
            <>
              <ValidityInput
                value={validity}
                onChange={setValidity}
                startedAt={
                  startedAt ||
                  (action === 'password' ? new Date().toISOString() : undefined)
                }
              />
              {validity.validityMode !== 'permanent' && (
                <label className='block space-y-2'>
                  <Label>起算时间（本机时区）</Label>
                  <Input
                    type='datetime-local'
                    value={startedAt}
                    onChange={(e) => setStartedAt(e.target.value)}
                  />
                  {action === 'password' && (
                    <p className='text-label text-muted-foreground'>
                      留空则从本次成功保存时起算，可填写实际启用的过去时间。
                    </p>
                  )}
                </label>
              )}
              <p className='text-label text-muted-foreground'>
                {action === 'password'
                  ? '新密码保存后重新计算有效期。'
                  : '仅调整提醒时间，保存的密码保持原值。'}
                到期只提醒，不会自动停用账号。
              </p>
            </>
          )}
          {action === 'owner' && (
            <div className='space-y-2'>
              <Label>负责人</Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger>
                  <SelectValue placeholder='选择负责人' />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='none'>暂不指定</SelectItem>
                  {owners.data?.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.displayName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className='text-label text-muted-foreground'>
                候选人必须有权查看该目标系统的凭据。
              </p>
              {owners.isError && (
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => void owners.refetch()}
                >
                  重新加载负责人
                </Button>
              )}
            </div>
          )}
          {error && (
            <p role='alert' className='text-label text-destructive'>
              {error}
            </p>
          )}
          <div className='flex justify-end gap-2'>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              onClick={() => {
                setPassword('')
                onClose()
              }}
            >
              取消
            </Button>
            <Button
              loading={saving}
              disabled={action === 'owner' && !owners.data}
              type='submit'
            >
              保存
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
