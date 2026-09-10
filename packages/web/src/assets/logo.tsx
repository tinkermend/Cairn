import { type ImgHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'
import logoObserve from './brand/logo-observe.svg'

type LogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>

export function Logo({ className, alt = '识途', ...props }: LogoProps) {
  return (
    <img
      src={logoObserve}
      alt={alt}
      className={cn('size-6 shrink-0', className)}
      {...props}
    />
  )
}
