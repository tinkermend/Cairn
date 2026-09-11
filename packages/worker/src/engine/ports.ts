import type { RunGrant, RunSnapshot, SessionGrant } from '@cairn/shared'

/**
 * Engine 只认这个端口，不认识 playwright / BrowserSessionManager。
 * 页面能力在 P5 扩展；本期只到 acquire / release。
 * acquire 必须带 RunGrant：会话租约的 run_fencing_token 只从执行租约取，不从控制台身份拼。
 */
export type BrowserPort = {
  acquire(run: RunSnapshot, grant: RunGrant, signal?: AbortSignal): Promise<SessionGrant>
  release(grant: SessionGrant, reason: string): Promise<void>
}

export const BROWSER_PORT = Symbol('BROWSER_PORT')
