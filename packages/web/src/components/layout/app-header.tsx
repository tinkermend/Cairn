import type { ReactNode } from 'react'
import { Header } from '@/components/layout/header'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'

type AppHeaderProps = {
  leading?: ReactNode
  fixed?: boolean
  className?: string
}

export function AppHeader({ leading, fixed, className }: AppHeaderProps) {
  return (
    <Header fixed={fixed} className={className}>
      {leading ?? <Search className='me-auto' />}
      <ProfileDropdown />
    </Header>
  )
}
