import type { ReactNode } from 'react'
import type { TargetDto } from '@cairn/shared'
import { ExternalLink as ExternalLinkIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import {
  AUTH_METHOD_LABELS,
  CAPTCHA_MODE_LABELS,
  LOGIN_FIELD_ROLE_LABELS,
  TARGET_STATUS_LABELS,
  formatLoginFieldState,
} from './labels'

function Field({
  label,
  value,
  mono,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) {
  return (
    <div className='flex flex-col gap-1'>
      <span className='text-small text-muted-foreground'>{label}</span>
      <span className={cn('break-all text-text-primary', mono && 'font-mono text-code')}>
        {value}
      </span>
    </div>
  )
}

function ExternalLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer'
      className='inline-flex items-center gap-1 text-link hover:underline'
    >
      <span className='truncate'>{href}</span>
      <ExternalLinkIcon className='size-3.5 shrink-0' />
    </a>
  )
}

interface SystemInfoCardProps {
  target: TargetDto
  onEdit?: () => void
  onDelete?: () => void
  showActions?: boolean
}

export function SystemInfoCard({
  target,
  onEdit,
  onDelete,
  showActions = true,
}: SystemInfoCardProps) {
  return (
    <Card className='min-w-0'>
      <CardHeader className='flex flex-row items-start justify-between gap-3'>
        <CardTitle className='text-section font-semibold'>系统资料</CardTitle>
        {showActions ? (
          <div className='flex gap-2'>
            {onEdit ? (
              <Can permission='target:write'>
                <Button variant='outline' size='sm' onClick={onEdit}>
                  编辑
                </Button>
              </Can>
            ) : null}
            {onDelete ? (
              <Can allOf={['target:delete', 'run:delete']}>
                <Button
                  variant='ghost'
                  size='sm'
                  className='text-destructive'
                  onClick={onDelete}
                >
                  删除
                </Button>
              </Can>
            ) : null}
          </div>
        ) : null}
      </CardHeader>
      <CardContent className='grid gap-4 text-body sm:grid-cols-2 xl:grid-cols-1'>
        <Field label='编码' value={target.code} mono />
        <Field
          label='状态'
          value={
            <StatusBadge tone={target.status === 'active' ? 'success' : 'neutral'}>
              {TARGET_STATUS_LABELS[target.status]}
            </StatusBadge>
          }
        />
        <Field label='入口 URL' value={<ExternalLink href={target.entryUrl} />} />
        <Field
          label='登录 URL'
          value={
            target.loginUrl ? (
              <ExternalLink href={target.loginUrl} />
            ) : (
              '与入口相同'
            )
          }
        />
        <Field label='认证方式' value={AUTH_METHOD_LABELS[target.authMethod]} />
        <Field label='验证码' value={CAPTCHA_MODE_LABELS[target.captchaMode]} />
        <Field label='目标账号数' value={String(target.accountCount)} />
        <Field
          label='更新时间'
          value={new Date(target.updatedAt).toLocaleString('zh-CN', {
            hour12: false,
          })}
        />
        <details className='space-y-3 border-t border-border-divider pt-3 sm:col-span-2 xl:col-span-1'>
          <summary className='cursor-pointer text-small font-medium focus-visible:outline-2 focus-visible:outline-ring'>
            登录框定位
          </summary>
          <div className='grid gap-3'>
            <Field
              label={LOGIN_FIELD_ROLE_LABELS.username}
              value={formatLoginFieldState(
                target.authMethod,
                target.loginFields?.username,
              )}
            />
            <Field
              label={LOGIN_FIELD_ROLE_LABELS.password}
              value={formatLoginFieldState(
                target.authMethod,
                target.loginFields?.password,
              )}
            />
            <Field
              label={LOGIN_FIELD_ROLE_LABELS.submit}
              value={formatLoginFieldState(
                target.authMethod,
                target.loginFields?.submit,
              )}
            />
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
