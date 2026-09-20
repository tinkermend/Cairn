import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchTargets,
  fetchTargetAccounts,
  updateTargetAccount,
} from '@/lib/targets-api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PasswordInput } from '@/components/password-input'
import {
  defaultValidityFields,
  toValidityWrite,
  ValidityInput,
} from './validity-fields'

export function CredentialRegistration({ onClose }: { onClose: () => void }) {
  const client = useQueryClient()
  const [target, setTarget] = useState('')
  const [account, setAccount] = useState('')
  const [search, setSearch] = useState('')
  const [accountSearch, setAccountSearch] = useState('')
  const [password, setPassword] = useState('')
  const [validity, setValidity] = useState(defaultValidityFields())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const targets = useQuery({
    queryKey: ['targets', 'credential-picker', search],
    queryFn: () =>
      fetchTargets({ search, limit: 100, credentialAction: 'write' }),
  })
  const accounts = useQuery({
    queryKey: ['target', target, 'accounts', accountSearch],
    queryFn: () =>
      fetchTargetAccounts(target, { search: accountSearch, limit: 100 }),
    enabled: !!target,
  })
  const selected = accounts.data?.items.find((a) => a.id === account)
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !saving) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>添加账号凭据</DialogTitle>
          <DialogDescription>
            选择已有目标账号保存密码。已有凭据会更新到同一账号，不会创建副本。
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-4'
          onSubmit={async (e) => {
            e.preventDefault()
            setError('')
            setSaving(true)
            try {
              if (!selected || !password.length)
                throw new Error('请选择账号并填写新密码')
              await updateTargetAccount(target, account, {
                password,
                validity: toValidityWrite(validity),
                expectedRevision: selected.credentialRevision,
              })
              setPassword('')
              await Promise.all([
                client.invalidateQueries({ queryKey: ['credentials'] }),
                client.invalidateQueries({ queryKey: ['target', target] }),
              ])
              onClose()
            } catch (err) {
              setError(
                err instanceof ApiRequestError
                  ? err.message
                  : err instanceof Error && err.name !== 'ZodError'
                    ? err.message
                    : '请检查有效期设置'
              )
            } finally {
              setSaving(false)
            }
          }}
        >
          <Input
            aria-label='搜索目标系统'
            placeholder='搜索目标系统'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            value={target}
            onValueChange={(v) => {
              setTarget(v)
              setAccount('')
            }}
          >
            <SelectTrigger aria-label='目标系统'>
              <SelectValue placeholder='选择目标系统' />
            </SelectTrigger>
            <SelectContent>
              {targets.data?.items.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} · {t.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {target && (
            <>
              <Input
                aria-label='搜索目标账号'
                placeholder='搜索账号名称或登录名'
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
              />
              <Select
                value={account}
                onValueChange={(v) => {
                  setAccount(v)
                  setValidity(
                    defaultValidityFields(
                      accounts.data?.items.find((a) => a.id === v)
                        ?.validityPolicy
                    )
                  )
                }}
              >
                <SelectTrigger aria-label='目标账号'>
                  <SelectValue placeholder='选择目标账号' />
                </SelectTrigger>
                <SelectContent>
                  {accounts.data?.items.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.displayName} · {a.username}
                      {a.hasPassword ? '（已保存密码）' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <a className='text-label text-link' href={`/targets/${target}`}>
                前往目标系统创建或管理账号
              </a>
            </>
          )}
          {(targets.isError || accounts.isError) && (
            <p className='text-label text-destructive'>
              无法加载目标系统或账号，请检查权限后重新打开。
            </p>
          )}
          <label className='block space-y-2'>
            <span className='text-label'>新密码</span>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete='new-password'
              maxLength={256}
            />
          </label>
          <ValidityInput value={validity} onChange={setValidity} />
          <p className='text-label text-muted-foreground'>
            请填写目标系统已经设置的密码。保存后从当前时间计算有效期。
          </p>
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
              onClick={onClose}
            >
              取消
            </Button>
            <Button type='submit' loading={saving} disabled={!selected}>
              保存凭据
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
