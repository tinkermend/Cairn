import * as React from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { getAvatarDataUri } from '@/lib/avatar'
import { initials } from '@/lib/auth'
import { cn } from '@/lib/utils'

export interface UserAvatarProps extends React.ComponentProps<typeof Avatar> {
  user?: {
    name?: string | null
    displayName?: string | null
    avatar?: string | null
  } | null
  fallbackClassName?: string
}

export function UserAvatar({
  user,
  className,
  fallbackClassName,
  ...props
}: UserAvatarProps) {
  const name = user?.displayName || user?.name || ''
  const avatarSrc = React.useMemo(() => {
    return getAvatarDataUri(user?.avatar)
  }, [user?.avatar])

  return (
    <Avatar className={cn('size-8 rounded-lg', className)} {...props}>
      {avatarSrc ? <AvatarImage src={avatarSrc} alt={name} className='object-cover' /> : null}
      <AvatarFallback className={cn('rounded-lg bg-muted text-foreground text-xs font-medium', fallbackClassName)}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}
