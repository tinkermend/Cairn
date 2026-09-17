import { Header } from '@/components/layout/header'
import { Search } from '@/components/search'

export function AppHeader() {
  return (
    <Header fixed>
      <Search className='me-auto' />
    </Header>
  )
}
