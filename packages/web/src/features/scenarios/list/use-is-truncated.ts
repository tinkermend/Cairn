import { useEffect, useRef, useState } from 'react'

/** 文本是否被省略：只有真被截断时才给全文提示，避免每次悬停都弹出重复内容。 */
export function useIsTruncated<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null)
  const [truncated, setTruncated] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => {
      // 状态翻转导致 React 重建节点时，RO 会对已脱离文档的旧节点报全 0；忽略之，
      // 否则会把已检测到的截断清掉并卡死（新节点不再被观察）。
      if (el.clientWidth === 0 && el.clientHeight === 0 && el.scrollWidth === 0 && el.scrollHeight === 0) return
      setTruncated(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text])
  return [ref, truncated] as const
}
