import { create } from 'zustand'
import { useEffect } from 'react'

export interface BreadcrumbMeta {
  title?: string
  parentTitle?: string
}

interface BreadcrumbStore {
  entities: Record<string, BreadcrumbMeta>
  setEntity: (key: string, meta: BreadcrumbMeta) => void
  removeEntity: (key: string) => void
}

export const useBreadcrumbStore = create<BreadcrumbStore>((set) => ({
  entities: {},
  setEntity: (key, meta) =>
    set((state) => ({
      entities: { ...state.entities, [key]: meta },
    })),
  removeEntity: (key) =>
    set((state) => {
      const next = { ...state.entities }
      delete next[key]
      return { entities: next }
    }),
}))

export function useBreadcrumb({
  entityId,
  title,
  parentTitle,
}: {
  entityId?: string
  title?: string
  parentTitle?: string
}) {
  const setEntity = useBreadcrumbStore((s) => s.setEntity)
  const removeEntity = useBreadcrumbStore((s) => s.removeEntity)

  useEffect(() => {
    if (!entityId || (!title && !parentTitle)) return
    setEntity(entityId, { title, parentTitle })
    return () => {
      removeEntity(entityId)
    }
  }, [entityId, title, parentTitle, setEntity, removeEntity])
}
