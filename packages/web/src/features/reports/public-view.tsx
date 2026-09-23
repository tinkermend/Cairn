import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { AlertCircle, Clock, ShieldCheck } from 'lucide-react'
import { fetchPublicReportView } from '@/lib/reports-api'
import { SuiteReportView } from '@/features/reports/suite-report-view'

export function PublicReportViewPage() {
  const { token } = useSearch({ from: '/public/reports/view' })

  const query = useQuery({
    queryKey: ['public-report-view', token],
    queryFn: () => fetchPublicReportView(token),
    enabled: Boolean(token),
    retry: false,
  })

  if (!token) {
    return (
      <div className='flex min-h-screen flex-col items-center justify-center p-6 bg-background text-foreground'>
        <div className='max-w-md w-full rounded-xl border border-border-card bg-card p-6 shadow-card text-center space-y-4'>
          <AlertCircle className='size-12 text-destructive mx-auto' />
          <h1 className='text-title font-semibold'>缺少访问令牌</h1>
          <p className='text-sm text-muted-foreground'>
            本页面需要携带有效时效签名的 Token 访问，请从移动端通知卡片重新进入。
          </p>
        </div>
      </div>
    )
  }

  if (query.isPending) {
    return (
      <div className='flex min-h-screen flex-col items-center justify-center p-6 bg-background text-foreground'>
        <div className='max-w-md w-full rounded-xl border border-border-card bg-card p-8 shadow-card text-center space-y-4'>
          <div className='size-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto' />
          <p className='text-sm text-muted-foreground'>正在验证安全签名并加载巡检总报告...</p>
        </div>
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className='flex min-h-screen flex-col items-center justify-center p-6 bg-background text-foreground'>
        <div className='max-w-md w-full rounded-xl border border-border-card bg-card p-6 shadow-card text-center space-y-4'>
          <AlertCircle className='size-12 text-destructive mx-auto' />
          <h1 className='text-title font-semibold'>报告无法访问</h1>
          <p className='text-sm text-muted-foreground'>
            签名令牌无效、已过期（有效时效 24 小时）或对应巡检报告尚未生成。
          </p>
        </div>
      </div>
    )
  }

  const { report, revision, document } = query.data

  return (
    <div className='min-h-screen bg-background text-foreground flex flex-col'>
      {/* Mobile-optimized Header */}
      <header className='sticky top-0 z-30 border-b border-border bg-card/90 backdrop-blur px-4 py-3 sm:px-8'>
        <div className='max-w-5xl mx-auto flex items-center justify-between gap-3'>
          <div className='flex items-center gap-2'>
            <ShieldCheck className='size-5 text-primary shrink-0' />
            <div>
              <span className='font-semibold text-sm sm:text-base'>识途巡检在线报告</span>
              <span className='ml-2 text-xs px-2 py-0.5 rounded bg-primary/10 text-primary font-medium'>
                只读直达
              </span>
            </div>
          </div>
          <div className='text-xs text-muted-foreground flex items-center gap-1'>
            <Clock className='size-3.5' />
            <span>v{revision.revisionNo}</span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className='flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 space-y-6'>
        <div className='space-y-1'>
          <h1 className='text-xl sm:text-2xl font-bold tracking-tight'>{document.title}</h1>
          <p className='text-xs sm:text-sm text-muted-foreground'>
            生成时间：{new Date(revision.createdAt).toLocaleString()} · 目标编号：{report.targetId.slice(0, 8)}
          </p>
        </div>

        <SuiteReportView document={document} />
      </main>

      <footer className='border-t border-border py-4 text-center text-xs text-muted-foreground'>
        识途 AI+RPA 可观测场景执行平台 · 安全只读访问链路
      </footer>
    </div>
  )
}
