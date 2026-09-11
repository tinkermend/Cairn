import type { RunSnapshot, SessionGrant } from '@cairn/shared'

/**
 * Engine 只认这个端口，不认识 playwright / BrowserSessionManager。
 * 页面能力在 P5 扩展；本期只到 acquire / release。
 */
export type BrowserPort = {
  acquire(run: RunSnapshot, signal?: AbortSignal): Promise<SessionGrant>
  release(grant: SessionGrant, reason: string): Promise<void>
}

export const BROWSER_PORT = Symbol('BROWSER_PORT')
