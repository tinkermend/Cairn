import { Logo } from '@/assets/logo'

type AuthLayoutProps = {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <main className='relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-background px-4 py-10 sm:px-6'>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0'
        style={{
          background:
            'radial-gradient(circle at 50% 42%, var(--technical-glow) 0%, transparent 54%)',
        }}
      />
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0'
        style={{
          backgroundImage:
            'linear-gradient(var(--technical-grid) 1px, transparent 1px), linear-gradient(90deg, var(--technical-grid) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          maskImage:
            'radial-gradient(ellipse 54% 62% at 50% 44%, black, transparent)',
        }}
      />
      <div
        aria-hidden='true'
        className='pointer-events-none absolute top-[42%] left-1/2 size-[min(78vw,760px)] -translate-x-1/2 -translate-y-1/2 rounded-full border border-technical-line'
      />
      <div className='relative z-10 mx-auto flex w-full max-w-[480px] flex-col'>
        <header className='mb-8 flex items-center justify-center gap-5'>
          <Logo className='size-14 shrink-0 sm:size-[72px]' alt='' />
          <div>
            <div className='text-[28px] leading-9 font-semibold text-foreground sm:text-[34px] sm:leading-[42px]'>
              识途
            </div>
            <p className='text-[15px] leading-6 font-medium text-text-secondary sm:text-section sm:leading-7'>
              可观测场景执行平台
            </p>
          </div>
        </header>
        {children}
        <footer className='mt-6 text-center text-label text-muted-foreground'>
          © 2026 新炬网络
        </footer>
      </div>
    </main>
  )
}
