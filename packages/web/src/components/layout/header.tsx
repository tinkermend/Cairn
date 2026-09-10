import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

type HeaderProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean
  ref?: React.Ref<HTMLElement>
}

export function Header({ className, fixed, children, ...props }: HeaderProps) {
  return (
    <header
      className={cn(
        'z-50 h-16 bg-surface-nav',
        fixed && 'header-fixed peer/header sticky top-0 w-[inherit]',
        className
      )}
      {...props}
    >
      <div className='relative flex h-full items-center gap-3 px-6'>
        <SidebarTrigger
          variant='outline'
          className='max-md:scale-125 md:hidden'
        />
        <Separator orientation='vertical' className='h-6 md:hidden' />
        {children}
      </div>
    </header>
  )
}
