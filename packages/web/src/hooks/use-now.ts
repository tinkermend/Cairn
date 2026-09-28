import { useEffect, useState } from 'react'

/** 本地时钟：active 时按间隔走一次，不触发任何请求。渲染里需要「现在」时用它，不直接调 Date.now()。 */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
