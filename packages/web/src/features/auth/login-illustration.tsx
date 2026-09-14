import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import poster from '@/assets/brand/login-execution.webp'
import backdrop from '@/assets/brand/login-motion-base.webp'
import parts from '@/assets/brand/login-motion-parts.webp'
import './login-illustration.css'

const motionQuery =
  '(min-width: 1024px) and (prefers-reduced-motion: no-preference)'

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia(motionQuery)
  query.addEventListener('change', callback)
  return () => query.removeEventListener('change', callback)
}

// Coordinates belong to the generated 1024 × 1536 artwork, not the viewport.
const nodes = [
  { x: 159, y: 806, rx: 65, ry: 45, depth: 27, delay: 0.2, ai: false },
  { x: 360, y: 854, rx: 63, ry: 44, depth: 24, delay: 1.5, ai: true },
  { x: 570, y: 806, rx: 63, ry: 45, depth: 23, delay: 2.7, ai: false },
  { x: 785, y: 724, rx: 60, ry: 40, depth: 24, delay: 3.9, ai: true },
  { x: 912, y: 613, rx: 59, ry: 38, depth: 24, delay: 5.1, ai: false },
]

const cards = [
  {
    outline:
      'M342 978 506 943Q520 939 523 952L523 1060Q523 1070 514 1074L343 1107Q329 1111 329 1096L329 996Q329 983 342 978Z',
    delay: 1.9,
  },
  {
    outline:
      'M579 926 725 880Q738 876 739 891L739 986Q739 998 728 1003L581 1048Q566 1054 566 1037L566 947Q566 933 579 926Z',
    delay: 3.1,
  },
  {
    outline:
      'M785 849 910 793Q924 790 924 805L924 901Q924 913 913 918L789 972Q773 979 773 962L773 870Q773 855 785 849Z',
    delay: 5.3,
  },
]

function nodeOutline({ x, y, rx, ry, depth }: (typeof nodes)[number]) {
  return `M${x - rx} ${y}A${rx} ${ry} 0 0 1 ${x + rx} ${y}V${y + depth}A${rx} ${ry} 0 0 1 ${x - rx} ${y + depth}Z`
}

export function LoginIllustration() {
  const root = useRef<HTMLDivElement>(null)
  const id = useId()
  const motionAllowed = useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(motionQuery).matches,
    () => false
  )
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!motionAllowed || ready) return
    let cancelled = false
    Promise.all(
      [backdrop, parts].map((src) => {
        const image = new Image()
        image.src = src
        return image.decode()
      })
    )
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch(() => {
        // A decorative asset failure keeps the original static illustration.
      })
    return () => {
      cancelled = true
    }
  }, [motionAllowed, ready])

  useEffect(() => {
    const update = () => {
      if (root.current) root.current.dataset.paused = String(document.hidden)
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  return (
    <div
      ref={root}
      className='login-illustration'
      aria-hidden='true'
      data-motion={motionAllowed && ready ? 'ready' : 'static'}
      onPointerEnter={() => {
        const animations = root.current?.getAnimations({ subtree: true }) ?? []
        if (
          animations.length &&
          animations.every((animation) => animation.playState === 'finished')
        ) {
          animations.forEach((animation) => {
            animation.currentTime = 0
            animation.play()
          })
        }
      }}
    >
      <picture className='absolute inset-0'>
        <source media='(min-width: 1024px)' srcSet={poster} />
        <img
          src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
          alt=''
          width={1024}
          height={1536}
          fetchPriority='high'
          className='h-full w-full object-cover object-[center_40%]'
        />
      </picture>
      {motionAllowed && ready && (
        <svg
          className='login-illustration__stage'
          viewBox='0 0 1024 1536'
          focusable='false'
        >
          <defs>
            <image id={`${id}-parts`} href={parts} width='1024' height='1536' />
            {nodes.map((node, index) => (
              <clipPath key={index} id={`${id}-node-${index}`}>
                <path d={nodeOutline(node)} />
              </clipPath>
            ))}
            {cards.map((card, index) => (
              <clipPath key={index} id={`${id}-card-${index}`}>
                <path d={card.outline} />
              </clipPath>
            ))}
          </defs>
          <image href={backdrop} width='1024' height='1536' />
          <g className='login-illustration__signal'>
            <circle r='12' fill='var(--action-primary)' opacity='.3' />
            <circle r='5' fill='var(--surface-card)' />
          </g>
          {nodes.map((node, index) => (
            <g
              key={index}
              className={`login-illustration__node ${node.ai ? 'text-ai-accent' : 'text-primary'}`}
              style={{ animationDelay: `${node.delay}s` }}
            >
              <use
                href={`#${id}-parts`}
                clipPath={`url(#${id}-node-${index})`}
              />
              <ellipse
                className='login-illustration__ring'
                cx={node.x}
                cy={node.y - 2}
                rx={node.rx - 5}
                ry={node.ry - 5}
                fill='none'
                stroke='currentColor'
                strokeWidth='3'
              />
            </g>
          ))}
          {cards.map((card, index) => (
            <g
              key={index}
              className='login-illustration__card'
              style={{ animationDelay: `${card.delay}s` }}
            >
              <use
                href={`#${id}-parts`}
                clipPath={`url(#${id}-card-${index})`}
              />
            </g>
          ))}
        </svg>
      )}
    </div>
  )
}
