/**
 * 平台在动作边和模型边共用的停止条件。
 * Midscene 的 abort 不是抢占式的；「abort 后零新动作」由这里保证。
 */
export class ActionGate {
  leaseLost = false

  constructor(public signal?: AbortSignal) {}

  markLeaseLost(): void {
    this.leaseLost = true
  }

  assertAllowed(kind: 'action' | 'model'): void {
    if (this.leaseLost) {
      throw new Error(`CAIRN_LEASE_LOST:${kind}`)
    }
    if (this.signal?.aborted) {
      throw new Error(`CAIRN_ABORTED:${kind}`)
    }
  }
}

export type GatedAction<T = unknown> = {
  name: string
  call: (param: T, context?: unknown) => Promise<unknown> | unknown
}

export function gateActions<A extends GatedAction>(actions: A[], gate: ActionGate): A[] {
  return actions.map((action) => ({
    ...action,
    call: async (param: unknown, context?: unknown) => {
      gate.assertAllowed('action')
      return action.call(param as never, context)
    },
  }))
}

export function createCallBarrier() {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let seen = 0
  return {
    async waitIf(n: number): Promise<void> {
      seen += 1
      if (seen === n) await held
    },
    release(): void {
      release()
    },
    get seen() {
      return seen
    },
  }
}
