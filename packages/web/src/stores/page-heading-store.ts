import type { ReactNode } from 'react'
import { create } from 'zustand'

/**
 * 一级菜单页的页名由顶栏显示，描述作为页名下方的副标题一并进入顶栏。
 * PageHeader 挂载时登记描述，卸载时清空；顶栏只读。
 */
interface PageHeadingStore {
  description: ReactNode
  setDescription: (description: ReactNode) => void
}

export const usePageHeadingStore = create<PageHeadingStore>((set) => ({
  description: null,
  setDescription: (description) => set({ description }),
}))
