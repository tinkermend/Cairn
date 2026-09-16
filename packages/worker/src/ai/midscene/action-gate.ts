/**
 * 平台在动作边和模型边共用的停止条件。
 * Midscene 的 abort 不是抢占式的；「abort 后零新动作」由这里保证。
 */
export class ActionGate {
  leaseLost = false
  /** 通过检查、真正交给页面执行的动作数。丢租时据此判断页面上是否可能已有副作用。 */
  actionsStarted = 0

  /**
   * @param leaseCheck 进程内租约校验，抛错即视为丢租且不再恢复。续租失败只 revoke
   *   SessionGuard、不会 abort 步骤信号，只看 signal 的 gate 在真实丢租后仍会放行动作。
   */
  constructor(
    public signal?: AbortSignal,
    private readonly leaseCheck?: () => void,
    private readonly authCheck?: () => void,
    readonly beforeAction?: () => Promise<void>,
    readonly afterAction?: () => Promise<void>,
  ) {}

  markLeaseLost(): void {
    this.leaseLost = true
  }

  assertAllowed(kind: 'action' | 'model'): void {
    if (this.authCheck) {
      try {
        this.authCheck()
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        if (code === 'AUTH_GATE_CLOSED' || (error instanceof Error && error.message.includes('AUTH_GATE'))) {
          throw new Error(`CAIRN_AUTH_GATE:${kind}`)
        }
        throw error
      }
    }
    if (!this.leaseLost && this.leaseCheck) {
      try {
        this.leaseCheck()
      } catch {
        this.leaseLost = true
      }
    }
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

export function gateActions<A extends { name: string; call: (...args: never[]) => unknown }>(
  actions: readonly A[],
  gate: ActionGate,
): A[] {
  return actions.map((action) => ({
    ...action,
    call: (async (...args: never[]) => {
      await gate.beforeAction?.()
      gate.assertAllowed('action')
      gate.actionsStarted += 1
      try { return await action.call(...args) }
      finally { await gate.afterAction?.() }
    }) as A['call'],
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
