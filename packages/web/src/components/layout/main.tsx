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
        // 内容面板：侧边栏与顶栏连成一个白色的壳，内容嵌在壳里。
        // 分界线只画在面板自己的左边和上边，壳内部不再有任何切割线。
        'canvas-bloom bg-surface-page',
        'md:rounded-ss-xl md:border-t md:border-s md:border-border-default',
        fixed && 'flex grow flex-col overflow-hidden',
        !fluid && '@7xl/content:mx-auto @7xl/content:w-full',
        className
      )}
      {...props}
    />
  )
}
