import { Header } from '@/components/layout/header'
import { AppBreadcrumb } from '@/components/layout/breadcrumb'
import { Search } from '@/components/search'
import { HeaderAssistantTrigger } from '@/features/assistant/header-assistant-trigger'
import { NavUser } from '@/components/layout/nav-user'

export function AppHeader() {
  return (
    <Header fixed>
      <div className='flex min-w-0 flex-1 items-center gap-2'>
        <AppBreadcrumb />
      </div>
      <div className='flex shrink-0 items-center gap-2'>
        <Search />
        <HeaderAssistantTrigger />
        <NavUser />
      </div>
    </Header>
  )
}
