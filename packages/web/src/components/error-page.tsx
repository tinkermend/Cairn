import type { ReactNode } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type ErrorPageProps = {
  code: string
  title: string
  description: ReactNode
  className?: string
  actions?: ReactNode
  showHome?: boolean
}

export function ErrorPage({
  code,
  title,
  description,
  className,
  actions,
  showHome = true,
}: ErrorPageProps) {
  const navigate = useNavigate()
  const { history } = useRouter()

  return (
    <div className={cn('h-svh w-full bg-background', className)}>
      <div className='m-auto flex h-full w-full max-w-lg flex-col items-center justify-center gap-3 px-6 text-center'>
        {code ? (
          <p className='text-5xl font-semibold tabular-nums text-text-primary'>
            {code}
          </p>
        ) : null}
        <h1 className='text-xl font-semibold'>{title}</h1>
        <p className='text-sm text-muted-foreground'>{description}</p>
        {actions ?? (
          <div className='mt-4 flex flex-wrap justify-center gap-3'>
            <Button variant='outline' onClick={() => history.go(-1)}>
              返回上一页
            </Button>
            {showHome ? (
              <Button onClick={() => navigate({ to: '/' })}>返回首页</Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
