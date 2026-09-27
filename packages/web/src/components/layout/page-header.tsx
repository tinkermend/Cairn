import { useEffect, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { usePageHeadingStore } from '@/stores/page-heading-store'
import { findMenuItem } from './data/menu-lookup'

type PageHeaderProps = {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  parent?: ReactNode
  className?: string
}

/**
 * 一级菜单页由顶栏显示页名，页内不再重复大标题。
 * 不强依赖路由：脱离 RouterProvider 渲染（单测、样本）时按普通页处理。
 */
function useIsMenuPage() {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined
  const pathname = router?.state.location.pathname
  return pathname ? findMenuItem(pathname) !== null : false
}

export function PageHeader({
  title,
  description,
  actions,
  parent,
  className,
}: PageHeaderProps) {
  const titleInHeader = useIsMenuPage() && !parent
  const setHeaderDescription = usePageHeadingStore((s) => s.setDescription)

  useEffect(() => {
    if (!titleInHeader) return
    setHeaderDescription(description ?? null)
    return () => setHeaderDescription(null)
  }, [titleInHeader, description, setHeaderDescription])

  if (titleInHeader) {
    // 页名与描述由顶栏显示（lg 以下顶栏放不下描述，退回页内）；语义标题保留给读屏
    const heading = <h1 className='sr-only'>{title}</h1>
    if (!description && !actions) return heading
    return (
      <div
        className={cn(
          '-mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-3',
          !actions && 'lg:hidden',
          className
        )}
      >
        {heading}
        {description ? (
          <p className='min-w-0 max-w-[72ch] flex-1 basis-80 text-body text-muted-foreground lg:hidden'>
            {description}
          </p>
        ) : null}
        {actions ? (
          <div className='ms-auto flex flex-wrap items-center gap-2'>{actions}</div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-end justify-between gap-3',
        className
      )}
    >
      <div className='min-w-0 space-y-1'>
        {parent ? (
          <div className='text-small text-muted-foreground'>{parent}</div>
        ) : null}
        <h1 className='text-page font-semibold break-words'>{title}</h1>
        {description ? (
          <p className='max-w-[72ch] text-body text-muted-foreground'>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className='flex flex-wrap items-center gap-2'>{actions}</div>
      ) : null}
    </div>
  )
}
