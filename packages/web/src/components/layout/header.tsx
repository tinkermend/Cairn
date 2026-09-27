import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

type HeaderProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean
  ref?: React.Ref<HTMLElement>
}

/** 页面离开顶部后才需要分界：静止时顶栏就是内容画布的上沿。 */
function useScrolled(threshold = 4) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > threshold)
    update()
    window.addEventListener('scroll', update, { passive: true })
    return () => window.removeEventListener('scroll', update)
  }, [threshold])
  return scrolled
}

export function Header({ className, fixed, children, ...props }: HeaderProps) {
  const scrolled = useScrolled()

  return (
    <header
      data-scrolled={scrolled ? 'true' : 'false'}
      className={cn(
        // 与内容区同一底色，连成一张画布；半透明让滚动内容从下方透出。
        'group/header z-50 h-14 border-b border-transparent bg-surface-page/85 backdrop-blur-md',
        'transition-[border-color,box-shadow] duration-200',
        'data-[scrolled=true]:border-border-default data-[scrolled=true]:shadow-card',
        fixed && 'header-fixed peer/header sticky top-0 w-[inherit]',
        className
      )}
      {...props}
    >
      {/* 左右内边距与 Main 保持一致，面包屑与页面标题竖向对齐 */}
      <div className='relative flex h-full items-center gap-2 px-3 sm:gap-3 sm:px-4 md:px-6 xl:px-8'>
        <SidebarTrigger
          variant='outline'
          aria-label='打开侧栏导航'
          className='size-9 shrink-0 md:hidden'
        />
        <Separator orientation='vertical' className='h-5 md:hidden shrink-0' />
        {children}
      </div>
    </header>
  )
}
