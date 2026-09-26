import { createContext, useContext, type ReactNode } from 'react'
import type { LocatorPlan, ResolutionPolicy } from '@cairn/shared'

type ResolutionSource = { targetId?: string; scenarioPlan?: LocatorPlan; scenarioPolicy?: ResolutionPolicy; locatorProtocol?: 2 }
const ResolutionSourceContext = createContext<ResolutionSource>({})

export function ResolutionSourceProvider({
  targetId,
  scenarioPlan,
  scenarioPolicy,
  locatorProtocol,
  children,
}: ResolutionSource & { children: ReactNode }) {
  return <ResolutionSourceContext.Provider value={{ targetId, scenarioPlan, scenarioPolicy, locatorProtocol }}>{children}</ResolutionSourceContext.Provider>
}

export function useResolutionTargetId() {
  return useContext(ResolutionSourceContext).targetId
}

export function useResolutionSource() { return useContext(ResolutionSourceContext) }
