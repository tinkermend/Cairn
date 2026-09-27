import { cn } from '@/lib/utils'

type MainProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean
  fluid?: boolean
  ref?: React.Ref<HTMLElement>
}

export function Main({ fixed, className, fluid, ...props }: MainProps) {
  return (
    <main
      id='content'
      data-layout={fixed ? 'fixed' : 'auto'}
      className={cn(
        'min-w-0 flex-1 px-6 py-6 md:px-6 xl:px-8',
        // 顶栏与内容共用同一张画布，唯一的分界是侧栏右缘；
        // 顶栏下沿只在滚动后出现，这里不再画面板边框。
        'bg-surface-page',
        fixed && 'flex grow flex-col overflow-hidden',
        !fluid && '@7xl/content:mx-auto @7xl/content:w-full',
        className
      )}
      {...props}
    />
  )
}
