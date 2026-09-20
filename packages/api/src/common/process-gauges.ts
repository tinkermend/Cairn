let sseConnections = 0
let internalForwards = 0

function onceDecrement(read: () => number, write: (value: number) => void): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    write(Math.max(0, read() - 1))
  }
}

export function trackSseConnection(): () => void {
  sseConnections += 1
  return onceDecrement(
    () => sseConnections,
    (value) => {
      sseConnections = value
    },
  )
}

export function trackInternalForward(): () => void {
  internalForwards += 1
  return onceDecrement(
    () => internalForwards,
    (value) => {
      internalForwards = value
    },
  )
}

export function currentSseConnections(): number {
  return sseConnections
}

export function currentInternalForwards(): number {
  return internalForwards
}
