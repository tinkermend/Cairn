/**
 * 浏览器宿主池 (Browser Host Pool)
 * 纳管共享 Chromium 进程（宿主），支持一会话一 Context、同目标分散、容量放置、回收与崩溃检测。
 */

import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext } from 'playwright'
import {
  BrowserRuntimeError,
  openSharedSession,
  type BrowserHandle,
  type LaunchSessionOpts,
} from './runtime.js'

export type HostState = 'ACTIVE' | 'DRAINING' | 'DEAD'

export type TargetSpreadMode = 'strict' | 'prefer'

export type HostPoolConfig = {
  maxContextsPerHost: number
  hostMaxAgeSeconds: number
  hostRssHighWatermarkMb: number
  targetSpread: TargetSpreadMode
  idleCloseDelayMs: number
}

export const DEFAULT_HOST_POOL_CONFIG: HostPoolConfig = {
  maxContextsPerHost: 6,
  hostMaxAgeSeconds: 14_400,
  hostRssHighWatermarkMb: 0,
  targetSpread: 'strict',
  idleCloseDelayMs: 60_000,
}

export type HostSnapshot = {
  hostId: string
  state: HostState
  isConnected: boolean
  contextsCount: number
  targetKeys: Set<string>
  rssMb?: number
  launchedAt: number
}

export type PlacementResult =
  | { action: 'USE_HOST'; hostId: string }
  | { action: 'CREATE_HOST' }
  | { action: 'CLOSE_IDLE_AND_CREATE'; idleHostId: string }
  | { action: 'CAPACITY_EXCEEDED'; reason: string }

/**
 * 提取同系统分散键（§3 第 7 条）：targetId 与 entryUrl hostname 之一相同即算同一系统
 */
export function computeTargetSpreadKeys(targetId: string, entryUrl?: string | null): string[] {
  const keys: string[] = [`target:${targetId}`]
  if (entryUrl) {
    try {
      const parsed = new URL(entryUrl)
      if (parsed.hostname) {
        keys.push(`host:${parsed.hostname.toLowerCase()}`)
      }
    } catch {
      // invalid URL ignored
    }
  }
  return keys
}

/**
 * 宿主放置算法（纯函数）
 */
export function decideHostPlacement(
  hosts: readonly HostSnapshot[],
  spreadKeys: readonly string[],
  config: {
    maxContextsPerHost: number
    maxSessions: number
    maxSharedHosts?: number
    targetSpread: TargetSpreadMode
    hostRssHighWatermarkMb: number
  },
  totalActiveSessionsCount: number,
): PlacementResult {
  if (totalActiveSessionsCount >= config.maxSessions) {
    return { action: 'CAPACITY_EXCEEDED', reason: 'worker_sessions_capacity_reached' }
  }

  const maxSharedHosts = config.maxSharedHosts ?? config.maxSessions

  // 1. 过滤候选：ACTIVE、已连接、未满、未超 RSS 高水位
  const validCandidates = hosts.filter((h) => {
    if (h.state !== 'ACTIVE' || !h.isConnected) return false
    if (h.contextsCount >= config.maxContextsPerHost) return false
    if (config.hostRssHighWatermarkMb > 0 && h.rssMb !== undefined) {
      if (h.rssMb >= config.hostRssHighWatermarkMb) return false
    }
    return true
  })

  // 2. 根据同目标分散将候选分为 clean（不含同系统键）与 colocated（含同系统键）
  const cleanCandidates: HostSnapshot[] = []
  const colocatedCandidates: HostSnapshot[] = []

  for (const candidate of validCandidates) {
    const hasSameSystem = spreadKeys.some((k) => candidate.targetKeys.has(k))
    if (hasSameSystem) {
      colocatedCandidates.push(candidate)
    } else {
      cleanCandidates.push(candidate)
    }
  }

  // 3. 排序策略：优先装满（contexts 多的优先），容量相同时选启动较早的
  const sortPacking = (a: HostSnapshot, b: HostSnapshot) => {
    if (b.contextsCount !== a.contextsCount) {
      return b.contextsCount - a.contextsCount
    }
    return a.launchedAt - b.launchedAt
  }

  if (cleanCandidates.length > 0) {
    cleanCandidates.sort(sortPacking)
    return { action: 'USE_HOST', hostId: cleanCandidates[0]!.hostId }
  }

  // 4. 无 clean 候选，判断是否可新建宿主
  const aliveSharedHosts = hosts.filter((h) => h.state !== 'DEAD')
  if (aliveSharedHosts.length < maxSharedHosts) {
    return { action: 'CREATE_HOST' }
  }

  // 已达宿主上限，检查是否有空闲的空宿主（contextsCount === 0）
  const emptyHost = aliveSharedHosts.find((h) => h.contextsCount === 0)
  if (emptyHost) {
    return { action: 'CLOSE_IDLE_AND_CREATE', idleHostId: emptyHost.hostId }
  }

  // 无法新建：若 prefer，则降级复用同目标宿主；若 strict，返回容量不足
  if (config.targetSpread === 'prefer' && colocatedCandidates.length > 0) {
    colocatedCandidates.sort(sortPacking)
    return { action: 'USE_HOST', hostId: colocatedCandidates[0]!.hostId }
  }

  return { action: 'CAPACITY_EXCEEDED', reason: 'target_spread_strict_exhausted' }
}

export type ManagedHost = {
  hostId: string
  browser: Browser
  launchedAt: number
  state: HostState
  contexts: Map<string, { context: BrowserContext; spreadKeys: string[]; explicitClose: boolean }>
  targets: Map<string, number>
  idleTimer?: NodeJS.Timeout
  maxAgeTimer?: NodeJS.Timeout
  isExplicitClose: boolean
}

export class SimpleMutex {
  private queue: Array<() => void> = []
  private locked = false

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(resolve)
    })
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }
}

export class BrowserHostPool {
  private hosts = new Map<string, ManagedHost>()
  private placementMutex = new SimpleMutex()
  private hostLostCount = 0

  constructor(
    private readonly workerId: string,
    private readonly config: HostPoolConfig = DEFAULT_HOST_POOL_CONFIG,
    private readonly launchHostOverride?: (hostId: string) => Promise<Browser>,
    private readonly onHostCrashCallback?: (hostId: string, sessionIds: string[]) => void,
    private readonly onContextCrashCallback?: (hostId: string, sessionId: string) => void,
    private readonly defaultLaunchOpts?: { headless?: boolean; executablePath?: string },
  ) {}

  getHostCount(): number {
    return [...this.hosts.values()].filter((h) => h.state !== 'DEAD').length
  }

  getContextCount(): number {
    let count = 0
    for (const h of this.hosts.values()) {
      if (h.state !== 'DEAD') count += h.contexts.size
    }
    return count
  }

  getHostLostCount(): number {
    return this.hostLostCount
  }

  getHostsSnapshot(): HostSnapshot[] {
    return [...this.hosts.values()].map((h) => ({
      hostId: h.hostId,
      state: h.state,
      isConnected: h.browser.isConnected(),
      contextsCount: h.contexts.size,
      targetKeys: new Set(h.targets.keys()),
      launchedAt: h.launchedAt,
    }))
  }

  getHost(hostId: string): ManagedHost | undefined {
    return this.hosts.get(hostId)
  }

  async acquireContext(
    sessionId: string,
    spreadKeys: string[],
    opts: LaunchSessionOpts,
    totalActiveSessionsCount: number,
    maxSessions: number,
  ): Promise<{ handle: BrowserHandle; hostId: string; colocated: boolean }> {
    return this.placementMutex.runExclusive(async () => {
      const snapshots = this.getHostsSnapshot()
      const placement = decideHostPlacement(
        snapshots,
        spreadKeys,
        {
          maxContextsPerHost: this.config.maxContextsPerHost,
          maxSessions,
          targetSpread: this.config.targetSpread,
          hostRssHighWatermarkMb: this.config.hostRssHighWatermarkMb,
        },
        totalActiveSessionsCount,
      )

      if (placement.action === 'CAPACITY_EXCEEDED') {
        throw new BrowserRuntimeError('BROWSER_UNAVAILABLE', `宿主池无可用容量: ${placement.reason}`)
      }

      if (placement.action === 'CLOSE_IDLE_AND_CREATE') {
        await this.closeHostInternal(placement.idleHostId)
      }

      let host: ManagedHost
      if (placement.action === 'CREATE_HOST' || placement.action === 'CLOSE_IDLE_AND_CREATE') {
        host = await this.createHost()
      } else {
        const found = this.hosts.get(placement.hostId)
        if (!found || found.state !== 'ACTIVE' || !found.browser.isConnected()) {
          host = await this.createHost()
        } else {
          host = found
        }
      }

      if (host.idleTimer) {
        clearTimeout(host.idleTimer)
        host.idleTimer = undefined
      }

      const colocated = spreadKeys.some((k) => host.targets.has(k))

      // 预占目标分散键
      for (const key of spreadKeys) {
        host.targets.set(key, (host.targets.get(key) ?? 0) + 1)
      }

      try {
        const handle = await openSharedSession({ browser: host.browser, hostId: host.hostId }, opts)
        const entry = { context: handle.context, spreadKeys, explicitClose: false }
        host.contexts.set(sessionId, entry)

        // 监听 Context 意外关闭
        handle.context.on('close', () => {
          if (!entry.explicitClose && host.state !== 'DEAD') {
            this.releaseContextReservation(host, sessionId, spreadKeys)
            this.onContextCrashCallback?.(host.hostId, sessionId)
          }
        })

        return { handle, hostId: host.hostId, colocated }
      } catch (error) {
        // 创建失败，回退预占
        this.releaseSpreadKeys(host, spreadKeys)
        if (host.contexts.size === 0 && host.state === 'ACTIVE') {
          this.scheduleHostIdleClose(host)
        }
        throw error
      }
    })
  }

  async releaseContext(sessionId: string, spreadKeys?: string[]): Promise<void> {
    let host: ManagedHost | undefined
    for (const h of this.hosts.values()) {
      if (h.contexts.has(sessionId)) {
        host = h
        break
      }
    }
    if (!host) return

    const entry = host.contexts.get(sessionId)
    const keys = spreadKeys ?? entry?.spreadKeys ?? []
    if (entry) {
      entry.explicitClose = true
      await entry.context.close().catch(() => {})
      host.contexts.delete(sessionId)
    }

    this.releaseSpreadKeys(host, keys)

    if (host.contexts.size === 0) {
      if (host.state === 'DRAINING') {
        await this.closeHostInternal(host.hostId)
      } else if (host.state === 'ACTIVE') {
        this.scheduleHostIdleClose(host)
      }
    }
  }

  private releaseSpreadKeys(host: ManagedHost, spreadKeys: string[]) {
    for (const key of spreadKeys) {
      const cur = host.targets.get(key)
      if (cur !== undefined) {
        if (cur <= 1) host.targets.delete(key)
        else host.targets.set(key, cur - 1)
      }
    }
  }

  private releaseContextReservation(host: ManagedHost, sessionId: string, spreadKeys: string[]) {
    host.contexts.delete(sessionId)
    this.releaseSpreadKeys(host, spreadKeys)
    if (host.contexts.size === 0) {
      if (host.state === 'DRAINING') {
        void this.closeHostInternal(host.hostId)
      } else if (host.state === 'ACTIVE') {
        this.scheduleHostIdleClose(host)
      }
    }
  }

  private scheduleHostIdleClose(host: ManagedHost) {
    if (host.idleTimer) clearTimeout(host.idleTimer)
    host.idleTimer = setTimeout(() => {
      if (host.contexts.size === 0 && host.state === 'ACTIVE') {
        void this.closeHostInternal(host.hostId)
      }
    }, this.config.idleCloseDelayMs)
  }

  private async createHost(): Promise<ManagedHost> {
    const hostId = randomUUID()
    let browser: Browser
    try {
      if (this.launchHostOverride) {
        browser = await this.launchHostOverride(hostId)
      } else {
        const { chromium } = await import('playwright')
        browser = await chromium.launch({
          headless: this.defaultLaunchOpts?.headless ?? true,
          executablePath: this.defaultLaunchOpts?.executablePath,
          args: ['--disable-dev-shm-usage', `--cairn-host=${this.workerId}/${hostId}`],
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new BrowserRuntimeError('BROWSER_LAUNCH_FAILED', `启动宿主失败: ${message}`)
    }

    const host: ManagedHost = {
      hostId,
      browser,
      launchedAt: Date.now(),
      state: 'ACTIVE',
      contexts: new Map(),
      targets: new Map(),
      isExplicitClose: false,
    }

    // 监听意外断开
    browser.on('disconnected', () => {
      if (!host.isExplicitClose) {
        host.state = 'DEAD'
        this.hostLostCount += 1
        const activeSessions = [...host.contexts.keys()]
        host.contexts.clear()
        host.targets.clear()
        this.onHostCrashCallback?.(host.hostId, activeSessions)
      }
    })

    // 到龄进入 DRAINING
    if (this.config.hostMaxAgeSeconds > 0) {
      host.maxAgeTimer = setTimeout(() => {
        if (host.state === 'ACTIVE') {
          host.state = 'DRAINING'
          if (host.contexts.size === 0) {
            void this.closeHostInternal(host.hostId)
          }
        }
      }, this.config.hostMaxAgeSeconds * 1000)
    }

    this.hosts.set(hostId, host)
    return host
  }

  async closeHostInternal(hostId: string): Promise<void> {
    const host = this.hosts.get(hostId)
    if (!host) return
    host.isExplicitClose = true
    if (host.idleTimer) clearTimeout(host.idleTimer)
    if (host.maxAgeTimer) clearTimeout(host.maxAgeTimer)
    for (const entry of host.contexts.values()) {
      entry.explicitClose = true
      await entry.context.close().catch(() => {})
    }
    host.contexts.clear()
    host.targets.clear()
    await host.browser.close().catch(() => {})
    this.hosts.delete(hostId)
  }

  async shutdown(): Promise<void> {
    const hostIds = [...this.hosts.keys()]
    for (const hostId of hostIds) {
      await this.closeHostInternal(hostId)
    }
  }
}
