import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { accountPickerHint, hasPermission, sessionStatusSchema, type TargetAccountDto } from '@cairn/shared'
import { fetchAccountSession } from '@/lib/sessions-api'
import { fetchTarget } from '@/lib/targets-api'
import { useAuthStore } from '@/stores/auth-store'
import { ACCOUNT_SESSION_STATUS_LABELS } from '@/features/sessions/labels'

export function AccountSessionHint({ targetId, account }: { targetId: string; account?: TargetAccountDto }) {
  const canRead = useAuthStore((state) => hasPermission(state.auth.user?.permissions ?? [], 'session:read'))
  const session = useQuery({
    queryKey: ['account-session', targetId, account?.id],
    queryFn: () => fetchAccountSession(targetId, account!.id),
    enabled: canRead && Boolean(account),
  })
  const targetQuery = useQuery({
    queryKey: ['target', targetId],
    queryFn: () => fetchTarget(targetId),
    enabled: Boolean(account),
  })
  if (!account) return null
  const hint = accountPickerHint({
    liveStatus: sessionStatusSchema.safeParse(session.data?.session?.status).data,
    hasPassword: account.hasPassword,
    authMethod: targetQuery.data?.authMethod,
    captchaMode: targetQuery.data?.captchaMode,
  })
  const nextAction = hint.lost
    ? '会话失联，处置并确认旧浏览器停止后才会继续'
    : hint.reuse
      ? '将复用现有会话'
      : '将准备新会话'
  return (
    <p className="text-label text-muted-foreground">
      {session.data
        ? `${ACCOUNT_SESSION_STATUS_LABELS[session.data.status]} · ${nextAction}。`
        : session.isError
          ? '会话状态暂不可达。'
          : canRead ? '正在读取会话状态。' : ''}
      {session.data?.occupancy ? '账号正被占用，运行将等待。' : null}
      {hint.lost ? null : hint.manualLikely ? '运行可能等待手工登录。' : null}
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
