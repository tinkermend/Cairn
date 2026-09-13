import { useCallback, useState } from 'react'

export const CURSOR_PAGE_SIZES = [10, 20, 50] as const
export type CursorPageSize = (typeof CURSOR_PAGE_SIZES)[number]

export function useCursorPage(defaultSize: CursorPageSize = 20) {
  const [pageIndex, setPageIndex] = useState(0)
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [pageSize, setPageSizeState] = useState<CursorPageSize>(defaultSize)

  const reset = useCallback(() => {
    setPageIndex(0)
    setCursors([undefined])
  }, [])

  const setPageSize = useCallback((size: CursorPageSize) => {
    setPageSizeState(size)
    setPageIndex(0)
    setCursors([undefined])
  }, [])

  const goNext = useCallback(
    (nextCursor: string) => {
      setCursors((prev) => [...prev.slice(0, pageIndex + 1), nextCursor])
      setPageIndex((index) => index + 1)
    },
    [pageIndex],
  )

  const goPrev = useCallback(() => {
    setPageIndex((index) => Math.max(0, index - 1))
  }, [])

  return {
    pageIndex,
    pageSize,
    cursor: cursors[pageIndex],
    reset,
    setPageSize,
    goNext,
    goPrev,
  }
}
