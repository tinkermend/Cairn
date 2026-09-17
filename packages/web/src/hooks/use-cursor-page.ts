import { useCallback, useEffect, useState } from 'react'

export const CURSOR_PAGE_SIZES = [10, 20, 50] as const
export type CursorPageSize = (typeof CURSOR_PAGE_SIZES)[number]

type SavedCursorPage = {
  pageIndex: number
  cursors: (string | undefined)[]
  pageSize: CursorPageSize
}

function asPageCursor(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isCursorPageSize(value: unknown): value is CursorPageSize {
  return (CURSOR_PAGE_SIZES as readonly number[]).includes(value as number)
}

export function readCursorPageState(
  storageKey: string | undefined,
  defaultSize: CursorPageSize,
): SavedCursorPage {
  const fallback: SavedCursorPage = { pageIndex: 0, cursors: [undefined], pageSize: defaultSize }
  if (!storageKey) return fallback
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as {
      pageIndex?: unknown
      cursors?: unknown
      pageSize?: unknown
    } | null
    if (!raw || typeof raw !== 'object') return fallback
    const cursors = Array.isArray(raw.cursors) ? raw.cursors.map(asPageCursor) : [undefined]
    const pageSize = isCursorPageSize(raw.pageSize) ? raw.pageSize : defaultSize
    const parsedIndex = Number(raw.pageIndex)
    const pageIndex =
      Number.isInteger(parsedIndex) && parsedIndex > 0 && asPageCursor(cursors[parsedIndex])
        ? parsedIndex
        : 0
    return { pageIndex, cursors: cursors.length > 0 ? cursors : [undefined], pageSize }
  } catch {
    return fallback
  }
}

export function useCursorPage(defaultSize: CursorPageSize = 20, storageKey?: string) {
  const [saved] = useState(() => readCursorPageState(storageKey, defaultSize))
  const [pageIndex, setPageIndex] = useState<number>(saved.pageIndex)
  const [cursors, setCursors] = useState<(string | undefined)[]>(saved.cursors)
  const [pageSize, setPageSizeState] = useState<CursorPageSize>(saved.pageSize)

  useEffect(() => {
    if (storageKey) sessionStorage.setItem(storageKey, JSON.stringify({ pageIndex, cursors, pageSize }))
  }, [storageKey, pageIndex, cursors, pageSize])

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
    cursor: asPageCursor(cursors[pageIndex]),
    reset,
    setPageSize,
    goNext,
    goPrev,
  }
}
