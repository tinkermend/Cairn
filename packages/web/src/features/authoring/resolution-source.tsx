import { createContext, useContext, type ReactNode } from 'react'

const ResolutionSourceContext = createContext<string | undefined>(undefined)

export function ResolutionSourceProvider({
  targetId,
  children,
}: {
  targetId?: string
  children: ReactNode
}) {
  return <ResolutionSourceContext.Provider value={targetId}>{children}</ResolutionSourceContext.Provider>
}

export function useResolutionTargetId() {
  return useContext(ResolutionSourceContext)
}
