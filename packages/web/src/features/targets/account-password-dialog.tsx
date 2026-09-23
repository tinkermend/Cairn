import { useId, useMemo, useState } from 'react'
import { Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import type { TargetAccountDto, CredentialValidityWrite } from '@cairn/shared'
import { computeMaintenanceDueAt } from '@cairn/shared'
import { updateTargetAccount } from '@/lib/targets-api'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface TargetAccountPasswordDialogProps {
  targetId: string
  targetName?: string
  account: TargetAccountDto | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ValidityPreset = 'keep' | '30' | '90' | '180' | 'permanent' | 'custom'

export function TargetAccountPasswordDialog({
  targetId,
  targetName,
  account,
  open,
  onOpenChange,
}: TargetAccountPasswordDialogProps) {
  const queryClient = useQueryClient()
  const passwordInputId = useId()
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [preset, setPreset] = useState<ValidityPreset>('keep')
  const [customDays, setCustomDays] = useState('90')
  const [submitting, setSubmitting] = useState(false)

  // 当弹窗打开或账号变化时重置表单
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setPassword('')
      setShowPassword(false)
      setPreset('keep')
      setCustomDays('90')
    }
    onOpenChange(nextOpen)
  }

  // 计算当前选择的有效期写入结构
  const effectiveValidity = useMemo<CredentialValidityWrite>(() => {
    const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    if (preset === 'keep') {
      if (account?.validityPolicy && account.validityPolicy.mode !== 'unknown') {
        if (account.validityPolicy.mode === 'permanent') {
          return { mode: 'permanent' }
        }
        return {
          mode: account.validityPolicy.mode,
          amount: account.validityPolicy.amount ?? 90,
          timeZone: account.validityPolicy.timeZone ?? defaultTz,
        }
      }
      return { mode: 'days', amount: 90, timeZone: defaultTz }
    }
    if (preset === 'permanent') {
      return { mode: 'permanent' }
    }
    if (preset === '30' || preset === '90' || preset === '180') {
      return { mode: 'days', amount: Number(preset), timeZone: defaultTz }
    }
    const days = Math.max(1, parseInt(customDays, 10) || 90)
    return { mode: 'days', amount: days, timeZone: defaultTz }
  }, [preset, customDays, account?.validityPolicy])

  // 预览预计到期时间
  const previewText = useMemo(() => {
    if (effectiveValidity.mode === 'permanent') {
      return '永久有效（不设维护截止）'
    }
    try {
      const due = computeMaintenanceDueAt({
        policy: {
          mode: effectiveValidity.mode,
          amount: effectiveValidity.amount ?? null,
          timeZone: effectiveValidity.timeZone ?? null,
        },
        startedAt: new Date(),
      })
      if (!due) return '未能计算到期时间'
      return `预计到期：${due.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: effectiveValidity.timeZone,
      })}（${effectiveValidity.amount} 天后）`
    } catch {
      return '格式有误'
    }
  }, [effectiveValidity])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!account) return
    const trimmed = password.trim()
    if (!trimmed) {
      toast.error('请输入新密码')
      return
    }

    setSubmitting(true)
    try {
      await updateTargetAccount(targetId, account.id, {
        password: trimmed,
        validity: effectiveValidity,
        expectedRevision: account.configRevision,
      })
      toast.success(`账号 ${account.displayName} 的密码已成功更新`)
      void queryClient.invalidateQueries({ queryKey: ['target', targetId] })
      handleOpenChange(false)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '更新密码失败'
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  if (!account) return null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={handleSubmit} className='space-y-4'>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2'>
              <KeyRound className='size-5 text-primary' />
              更新目标账号密码
            </DialogTitle>
            <DialogDescription>
              仅更新识途保存的密码值与维护期限，不自动修改目标网站端密码。
            </DialogDescription>
          </DialogHeader>

          {/* 账号概况 */}
          <div className='rounded-md border border-border-divider bg-surface-subtle p-3 text-small'>
            <div className='flex justify-between'>
              <span className='text-muted-foreground'>所属系统</span>
              <span className='font-medium text-text-primary'>{targetName ?? targetId}</span>
            </div>
            <div className='mt-1.5 flex justify-between'>
              <span className='text-muted-foreground'>目标账号</span>
              <span className='font-mono font-medium text-text-primary'>
                {account.displayName} ({account.username})
              </span>
            </div>
          </div>

          {/* 新密码输入 */}
          <div className='space-y-1.5'>
            <Label htmlFor={passwordInputId}>新密码</Label>
            <div className='relative'>
              <Input
                id={passwordInputId}
                type={showPassword ? 'text' : 'password'}
                placeholder='输入新密码'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                disabled={submitting}
                className='pr-10'
              />
              <button
                type='button'
                onClick={() => setShowPassword(!showPassword)}
                className='absolute right-2.5 top-2.5 text-muted-foreground hover:text-text-primary'
                tabIndex={-1}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
              >
                {showPassword ? <EyeOff className='size-4' /> : <Eye className='size-4' />}
              </button>
            </div>
          </div>

          {/* 维护有效期选择 */}
          <div className='space-y-1.5'>
            <Label>维护有效期</Label>
            <Select
              value={preset}
              onValueChange={(val) => setPreset(val as ValidityPreset)}
              disabled={submitting}
            >
              <SelectTrigger>
                <SelectValue placeholder='选择维护期限' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='keep'>沿用当前规则</SelectItem>
                <SelectItem value='30'>30 天</SelectItem>
                <SelectItem value='90'>90 天 (一季度)</SelectItem>
                <SelectItem value='180'>180 天 (半年)</SelectItem>
                <SelectItem value='permanent'>永久有效 (不设截止)</SelectItem>
                <SelectItem value='custom'>自定义天数</SelectItem>
              </SelectContent>
            </Select>

            {preset === 'custom' && (
              <div className='mt-2 flex items-center gap-2'>
                <Input
                  type='number'
                  min={1}
                  max={3650}
                  placeholder='天数'
                  value={customDays}
                  onChange={(e) => setCustomDays(e.target.value)}
                  disabled={submitting}
                  className='w-32'
                />
                <span className='text-small text-muted-foreground'>天后到期</span>
              </div>
            )}

            <p className='text-label text-muted-foreground'>{previewText}</p>
          </div>

          <DialogFooter className='pt-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type='submit' disabled={submitting || !password.trim()}>
              {submitting ? (
                <>
                  <Loader2 className='mr-2 size-4 animate-spin' />
                  保存中...
                </>
              ) : (
                '保存新密码'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
