import { Logo } from '@/assets/logo'
import { LoginIllustration } from './login-illustration'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <main className='grid min-h-[100dvh] bg-card bg-[radial-gradient(ellipse_at_50%_0%,var(--technical-glow),transparent_65%),linear-gradient(110deg,var(--surface-card)_5%,var(--action-secondary)_100%)] p-6 lg:grid-cols-2 lg:gap-6'>
      <section className='flex min-w-0 flex-col sm:px-6 sm:py-4 xl:px-10'>
        <header className='flex items-center gap-4'>
          <Logo className='size-16 shrink-0' alt='' />
          <div className='space-y-1'>
            <div className='text-stat font-semibold text-foreground'>识途</div>
            <p className='text-body leading-6 text-text-secondary'>
              可观测场景执行平台
            </p>
          </div>
        </header>
        <div className='flex flex-1 items-center justify-center py-12 sm:py-16'>
          <div className='w-full max-w-[400px]'>{children}</div>
        </div>
        <footer className='text-center text-label text-muted-foreground'>
          © 2026 新炬网络
        </footer>
      </section>
      <aside
        aria-labelledby='login-story-title'
        className='relative hidden min-h-[640px] min-w-0 flex-col overflow-hidden rounded-xl border border-technical-line bg-secondary shadow-card lg:flex'
      >
        <LoginIllustration />
        <h2
          id='login-story-title'
          className='relative px-8 pt-10 text-center text-[28px] leading-snug font-semibold text-foreground sm:text-[34px] xl:pt-12'
        >
          化繁为简，<span className='text-primary'>识途即行</span>
        </h2>
      </aside>
    </main>
  )
}
