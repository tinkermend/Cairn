import { cn } from '@/lib/utils'
import { ErrorPage } from '@/components/error-page'

type GeneralErrorProps = React.HTMLAttributes<HTMLDivElement> & {
  minimal?: boolean
}

export function GeneralError({
  className,
  minimal = false,
}: GeneralErrorProps) {
  return (
    <ErrorPage
      className={cn(className)}
      code={minimal ? '' : '500'}
      title='服务暂时不可用'
      description='请稍后重试。未保存的输入仍保留在当前页，不会丢失。'
    />
  )
}
