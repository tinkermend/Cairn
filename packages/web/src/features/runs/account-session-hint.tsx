import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { accountPickerHint, hasPermission, type TargetAccountDto } from '@cairn/shared'
import { fetchAccountSession } from '@/lib/sessions-api'
import { useAuthStore } from '@/stores/auth-store'
import { ACCOUNT_SESSION_STATUS_LABELS } from '@/features/sessions/labels'
import { AUTH_CAPABILITY_LABELS } from '@/features/targets/labels'

export function accountCapabilityLabel(
  account: Pick<TargetAccountDto, 'authCapability' | 'lastAuthSuccessAt' | 'lastAuthError'>,
) {
  return `${AUTH_CAPABILITY_LABELS[account.authCapability ?? 'LEGACY']} · ${account.lastAuthError ? '待登录' : account.lastAuthSuccessAt ? '已核验' : '未核验'}`
}

export function AccountSessionHint({ targetId, account }: { targetId: string; account?: TargetAccountDto }) {
  const canRead = useAuthStore((state) => hasPermission(state.auth.user?.permissions ?? [], 'session:read'))
  const session = useQuery({
    queryKey: ['account-session', targetId, account?.id],
    queryFn: () => fetchAccountSession(targetId, account!.id),
    enabled: canRead && Boolean(account),
  })
  if (!account) return null
  const hint = accountPickerHint({
    hasLiveSession: session.data?.session?.status === 'OPEN',
    hasPassword: account.hasPassword,
    capability: account.authCapability ?? 'LEGACY',
  })
  return (
    <p className="text-label text-muted-foreground">
      {session.data
        ? `${ACCOUNT_SESSION_STATUS_LABELS[session.data.status]} · ${hint.reuse ? '将复用现有会话' : '将准备新会话'}。`
        : session.isError
          ? '会话状态暂不可达。'
          : canRead ? '正在读取会话状态。' : ''}
      {session.data?.occupancy ? '账号正被占用，运行将等待。' : null}
      {hint.manualLikely ? '运行可能等待手工登录。' : null}
      {canRead ? (
        <Link
          className="ms-2 underline"
          to="/sessions/$targetId/$accountId"
          params={{ targetId, accountId: account.id }}
        >
          管理会话
        </Link>
      ) : null}
    </p>
  )
}
