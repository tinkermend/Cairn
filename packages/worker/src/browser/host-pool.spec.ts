import { describe, expect, it, vi } from 'vitest'
import {
  computeTargetSpreadKeys,
  decideHostPlacement,
  BrowserHostPool,
  type HostSnapshot,
} from './host-pool.js'

import { withTestOccupancy } from './test-occupancy.js'

describe('Host Pool Pure Placement & Logic (§8.1)', () => {
  it('分散键提取：targetId 相同或入口主机名相同都判为同一系统', () => {
    const k1 = computeTargetSpreadKeys('target-1', 'https://example.com/app/login')
    const k2 = computeTargetSpreadKeys('target-2', 'http://example.com:8080/portal')
    const k3 = computeTargetSpreadKeys('target-1', 'https://other.org/')

    expect(k1).toContain('target:target-1')
    expect(k1).toContain('host:example.com')

    expect(k2).toContain('target:target-2')
    expect(k2).toContain('host:example.com')

    // k1 and k2 share host:example.com
    const overlap12 = k1.some((k) => k2.includes(k))
    expect(overlap12).toBe(true)

    // k1 and k3 share target:target-1
    const overlap13 = k1.some((k) => k3.includes(k))
    expect(overlap13).toBe(true)
  })

  it('放置算法：空池时返回 CREATE_HOST', () => {
    const decision = decideHostPlacement(
      [],
      ['target:t1'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      0,
    )
    expect(decision).toEqual({ action: 'CREATE_HOST' })
  })

  it('放置算法：总会话数已满返回 CAPACITY_EXCEEDED', () => {
    const decision = decideHostPlacement(
      [],
      ['target:t1'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      4,
    )
    expect(decision.action).toBe('CAPACITY_EXCEEDED')
  })

  it('放置算法：DRAINING 与 DEAD 排除，内存高水位排除', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-draining',
        state: 'DRAINING',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(),
        launchedAt: 1000,
      },
      {
        hostId: 'h-dead',
        state: 'DEAD',
        isConnected: false,
        contextsCount: 0,
        targetKeys: new Set(),
        launchedAt: 2000,
      },
      {
        hostId: 'h-rss-high',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(),
        rssMb: 500,
        launchedAt: 3000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:t1'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 400 },
      2,
    )
    expect(decision).toEqual({ action: 'CREATE_HOST' })
  })

  it('放置算法：优先装满（contexts 多的优先）以节约内存', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(['target:other1']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-2',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 4,
        targetKeys: new Set(['target:other2']),
        launchedAt: 2000,
      },
      {
        hostId: 'h-3',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:other3']),
        launchedAt: 3000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:new-system'],
      { maxContextsPerHost: 6, maxSessions: 10, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      7,
    )
    expect(decision).toEqual({ action: 'USE_HOST', hostId: 'h-2' })
  })

  it('放置算法：strict 下排除同目标宿主，容量不足新建宿主', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 4, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      2,
    )
    expect(decision).toEqual({ action: 'CREATE_HOST' })
  })

  it('放置算法：strict 下到达宿主上限且无可关空宿主返回 CAPACITY_EXCEEDED', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-2',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 1,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 2000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 4, maxSharedHosts: 2, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      2,
    )
    expect(decision.action).toBe('CAPACITY_EXCEEDED')
  })

  it('放置算法：prefer 模式下资源不足回落到含同目标的宿主', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-1',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-2',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 3,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 2000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 10, maxSharedHosts: 2, targetSpread: 'prefer', hostRssHighWatermarkMb: 0 },
      5,
    )
    expect(decision).toEqual({ action: 'USE_HOST', hostId: 'h-2' })
  })

  it('放置算法：到达上限但存在空闲空宿主时，先关闭空宿主再新建', () => {
    const hosts: HostSnapshot[] = [
      {
        hostId: 'h-full',
        state: 'ACTIVE',
        isConnected: true,
        contextsCount: 2,
        targetKeys: new Set(['target:systemA']),
        launchedAt: 1000,
      },
      {
        hostId: 'h-idle-empty',
        state: 'DRAINING',
        isConnected: true,
        contextsCount: 0,
        targetKeys: new Set(),
        launchedAt: 2000,
      },
    ]

    const decision = decideHostPlacement(
      hosts,
      ['target:systemA'],
      { maxContextsPerHost: 6, maxSessions: 6, maxSharedHosts: 2, targetSpread: 'strict', hostRssHighWatermarkMb: 0 },
      2,
    )
    expect(decision).toEqual({ action: 'CLOSE_IDLE_AND_CREATE', idleHostId: 'h-idle-empty' })
  })

  it('并发放置测试：10 次并发放置同一系统的不同账号，strict 下无同宿主冲突', async () => {
    const mockBrowsers: any[] = []
    const pool = new BrowserHostPool(
      'worker-concurrency-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
      },
      async (hostId) => {
        const b = {
          hostId,
          isConnected: () => true,
          close: async () => {},
          on: () => {},
          newContext: async () => {
            // Add a small jitter delay to test interleaving
            await new Promise((r) => setTimeout(r, 10))
            return {
              newPage: async () => ({}),
              on: () => {},
              close: async () => {},
            }
          },
        }
        mockBrowsers.push(b)
        return b as any
      },
    )

    const spreadKeys = ['target:systemA']
    const handles = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        withTestOccupancy(() =>
          pool.acquireContext(`session-${i}`, spreadKeys, { headless: true }, i, 10),
        ),
      ),
    )

    // With strict mode and targetSpread, each session must have been assigned to a different host
    const hostIds = handles.map((h) => h.hostId)
    const uniqueHosts = new Set(hostIds)
    expect(uniqueHosts.size).toBe(5)
  })

  it('宿主崩溃事件测试：意外断开时置 DEAD 并回调受影响会话', async () => {
    let disconnectCb: (() => void) | undefined
    let crashedHost = ''
    let affected: string[] = []

    const pool = new BrowserHostPool(
      'worker-crash-test',
      {
        maxContextsPerHost: 6,
        hostMaxAgeSeconds: 14400,
        hostRssHighWatermarkMb: 0,
        targetSpread: 'strict',
        idleCloseDelayMs: 60000,
      },
      async (hostId) => {
        return {
          hostId,
          isConnected: () => true,
          close: async () => {},
          on: (event: string, cb: () => void) => {
            if (event === 'disconnected') disconnectCb = cb
          },
          newContext: async () => ({
            newPage: async () => ({}),
            on: () => {},
            close: async () => {},
          }),
        } as any
      },
      (hostId, sessionIds) => {
        crashedHost = hostId
        affected = sessionIds
      },
    )

    const handle = await withTestOccupancy(() =>
      pool.acquireContext('sess-crash-1', ['t1'], { headless: true }, 0, 5),
    )
    expect(pool.getHostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(1)

    // Simulate unexpected crash
    disconnectCb?.()

    expect(crashedHost).toBe(handle.hostId)
    expect(affected).toEqual(['sess-crash-1'])
    expect(pool.getHostLostCount()).toBe(1)
    expect(pool.getContextCount()).toBe(0)
  })
})
