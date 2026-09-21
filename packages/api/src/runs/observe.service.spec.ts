import { NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { JwtService } from '@nestjs/jwt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { diagnoseRunEventCursor } from '@cairn/db'
import { AuthService } from '../auth/auth.service'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { unusedChangeHint } from '../__tests__/http-app'
import { ObserveService } from './observe.service'

const runId = '66666666-6666-4666-8666-666666666666'
const otherRun = '77777777-7777-4777-8777-777777777777'

const mocks = vi.hoisted(() => ({
  loadRunObservation: vi.fn(),
  loadRunObservationProgress: vi.fn(),
  listRunEventsAfter: vi.fn(),
  listRunEventWatermarks: vi.fn(),
}))

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    loadRunObservation: mocks.loadRunObservation,
    loadRunObservationProgress: mocks.loadRunObservationProgress,
    listRunEventsAfter: mocks.listRunEventsAfter,
    listRunEventWatermarks: mocks.listRunEventWatermarks,
  }
})

function observation(input: { status?: string; evidenceStatus?: string; eventSeq?: number } = {}) {
  return {
    run: {
      status: input.status ?? 'QUEUED',
      evidenceStatus: input.evidenceStatus ?? 'PENDING',
    },
    evidence: { items: [] },
    eventSeq: input.eventSeq ?? 1,
    earliestEventSeq: input.eventSeq && input.eventSeq > 0 ? 1 : 0,
  }
}

function progress(input: { status?: string; evidenceStatus?: string; eventSeq?: number } = {}) {
  return {
    status: (input.status ?? 'QUEUED') as any,
    evidenceStatus: (input.evidenceStatus ?? 'PENDING') as any,
    eventSeq: input.eventSeq ?? 1,
    earliestEventSeq: input.eventSeq && input.eventSeq > 0 ? 1 : 0,
  }
}

const created = {
  schemaVersion: 1,
  eventId: '00000000-0000-4000-8000-000000000041',
  type: 'run.created' as const,
  occurredAt: '2026-09-13T00:00:00.000Z',
  runId,
  sequence: 1,
  payload: { status: 'QUEUED' },
}

function mockResponse() {
  const chunks: string[] = []
  return {
    chunks,
    status: vi.fn(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk)
      return true
    }),
    end: vi.fn(),
    on: vi.fn(),
    writableEnded: false,
  }
}

describe('ObserveService.stream', () => {
  let service: ObserveService

  beforeEach(async () => {
    mocks.loadRunObservation.mockReset()
    mocks.loadRunObservationProgress.mockReset()
    mocks.listRunEventsAfter.mockReset()
    mocks.listRunEventWatermarks.mockReset()
    mocks.loadRunObservation.mockResolvedValue(observation())
    mocks.loadRunObservationProgress.mockResolvedValue(progress())
    const moduleRef = await Test.createTestingModule({
      providers: [
        ObserveService,
        { provide: DB_HANDLE, useValue: { ping: async () => true, close: async () => undefined, driver: 'postgres' } },
        { provide: CHANGE_HINT, useValue: unusedChangeHint },
        { provide: JwtService, useValue: { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 3600 }) } },
        { provide: AuthService, useValue: { resolveAccount: vi.fn() } },
      ],
    }).compile()
    service = moduleRef.get(ObserveService)
    await moduleRef.init()
  })

  afterEach(() => {
    service.onModuleDestroy()
  })

  it('补读持久事件后发 ready，realtime 反映订阅是否成功', async () => {
    mocks.loadRunObservation.mockResolvedValue(observation())
    mocks.listRunEventsAfter.mockResolvedValueOnce([created]).mockResolvedValue([])
    const res = mockResponse()
    const controller = new AbortController()
    await service.stream({
      runId,
      lastEventId: `${runId}:0`,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: controller.signal,
    })
    const text = res.chunks.join('')
    expect(text).toContain('event: run.created')
    expect(text).toContain(`id: ${runId}:1`)
    expect(text).toContain('"kind":"ready"')
    expect(text).toContain('"realtime":false')
    expect(text).not.toMatch(/id: [^\n]+\nevent: ready/)
    controller.abort()
  })

  it('建连时 JWT 已过期发 error 后关流', async () => {
    service.onModuleDestroy()
    const moduleRef = await Test.createTestingModule({
      providers: [
        ObserveService,
        { provide: DB_HANDLE, useValue: { ping: async () => true, close: async () => undefined, driver: 'postgres' } },
        { provide: CHANGE_HINT, useValue: unusedChangeHint },
        { provide: JwtService, useValue: { decode: () => ({ exp: 1 }) } },
        { provide: AuthService, useValue: { resolveAccount: vi.fn() } },
      ],
    }).compile()
    service = moduleRef.get(ObserveService)
    await moduleRef.init()
    mocks.loadRunObservation.mockResolvedValue(observation())
    mocks.listRunEventsAfter.mockResolvedValue([])
    const res = mockResponse()
    await service.stream({
      runId,
      authorization: 'Bearer expired',
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: new AbortController().signal,
    })
    const text = res.chunks.join('')
    expect(text).toContain('"code":"UNAUTHORIZED"')
    expect(text).not.toContain('"kind":"ready"')
    expect(res.end).toHaveBeenCalled()
  })

  it('存活期间撤权发 error 后关流', async () => {
    vi.useFakeTimers()
    try {
      service.onModuleDestroy()
      const moduleRef = await Test.createTestingModule({
        providers: [
          ObserveService,
          { provide: DB_HANDLE, useValue: { ping: async () => true, close: async () => undefined, driver: 'postgres' } },
          { provide: CHANGE_HINT, useValue: unusedChangeHint },
          { provide: JwtService, useValue: { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 3600 }) } },
          {
            provide: AuthService,
            useValue: {
              resolveAccount: vi.fn(async () => ({
                id: 'acc',
                displayName: 't',
                email: null,
                status: 'disabled',
                roles: [],
                permissions: ['run:read'],
              })),
            },
          },
        ],
      }).compile()
      service = moduleRef.get(ObserveService)
      await moduleRef.init()
      mocks.loadRunObservation.mockResolvedValue(observation())
      mocks.listRunEventsAfter.mockResolvedValue([])
      const res = mockResponse()
      const controller = new AbortController()
      await service.stream({
        runId,
        authorization: 'Bearer live',
        account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
        response: res as never,
        signal: controller.signal,
      })
      expect(res.chunks.join('')).toContain('"kind":"ready"')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(res.chunks.join('')).toContain('"code":"FORBIDDEN"')
      expect(res.end).toHaveBeenCalled()
      controller.abort()
    } finally {
      vi.useRealTimers()
    }
  })

  it('存活期间库故障发 INTERNAL，不把登录判失效', async () => {
    vi.useFakeTimers()
    try {
      service.onModuleDestroy()
      const moduleRef = await Test.createTestingModule({
        providers: [
          ObserveService,
          { provide: DB_HANDLE, useValue: { ping: async () => true, close: async () => undefined, driver: 'postgres' } },
          { provide: CHANGE_HINT, useValue: unusedChangeHint },
          { provide: JwtService, useValue: { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 3600 }) } },
          {
            provide: AuthService,
            useValue: {
              resolveAccount: vi.fn(async () => {
                throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
              }),
            },
          },
        ],
      }).compile()
      service = moduleRef.get(ObserveService)
      await moduleRef.init()
      mocks.loadRunObservation.mockResolvedValue(observation())
      mocks.listRunEventsAfter.mockResolvedValue([])
      const res = mockResponse()
      const controller = new AbortController()
      await service.stream({
        runId,
        authorization: 'Bearer live',
        account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
        response: res as never,
        signal: controller.signal,
      })
      expect(res.chunks.join('')).toContain('"kind":"ready"')
      await vi.advanceTimersByTimeAsync(15_000)
      const text = res.chunks.join('')
      expect(text).toContain('"code":"INTERNAL"')
      expect(text).toContain('服务暂时不可用')
      expect(text).not.toContain('"code":"UNAUTHORIZED"')
      expect(res.end).toHaveBeenCalled()
      controller.abort()
    } finally {
      vi.useRealTimers()
    }
  })

  it('存活期间账号不存在才发 UNAUTHORIZED', async () => {
    vi.useFakeTimers()
    try {
      service.onModuleDestroy()
      const moduleRef = await Test.createTestingModule({
        providers: [
          ObserveService,
          { provide: DB_HANDLE, useValue: { ping: async () => true, close: async () => undefined, driver: 'postgres' } },
          { provide: CHANGE_HINT, useValue: unusedChangeHint },
          { provide: JwtService, useValue: { decode: () => ({ exp: Math.floor(Date.now() / 1000) + 3600 }) } },
          {
            provide: AuthService,
            useValue: {
              resolveAccount: vi.fn(async () => {
                throw new NotFoundException('账号不存在')
              }),
            },
          },
        ],
      }).compile()
      service = moduleRef.get(ObserveService)
      await moduleRef.init()
      mocks.loadRunObservation.mockResolvedValue(observation())
      mocks.listRunEventsAfter.mockResolvedValue([])
      const res = mockResponse()
      const controller = new AbortController()
      await service.stream({
        runId,
        authorization: 'Bearer live',
        account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
        response: res as never,
        signal: controller.signal,
      })
      await vi.advanceTimersByTimeAsync(15_000)
      expect(res.chunks.join('')).toContain('"code":"UNAUTHORIZED"')
      expect(res.end).toHaveBeenCalled()
      controller.abort()
    } finally {
      vi.useRealTimers()
    }
  })

  it('历史终态且无事件时先 ready 再 complete', async () => {
    mocks.loadRunObservation.mockResolvedValue(
      observation({ status: 'SUCCEEDED', evidenceStatus: 'COMPLETE', eventSeq: 0 }),
    )
    mocks.loadRunObservationProgress.mockResolvedValue(
      progress({ status: 'SUCCEEDED', evidenceStatus: 'COMPLETE', eventSeq: 0 }),
    )
    mocks.listRunEventsAfter.mockResolvedValue([])
    const res = mockResponse()
    await service.stream({
      runId,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: new AbortController().signal,
    })
    const text = res.chunks.join('')
    expect(text).toContain('"kind":"ready"')
    expect(text.indexOf('"kind":"ready"')).toBeLessThan(text.indexOf('"kind":"complete"'))
    expect(res.end).toHaveBeenCalled()
  })

  it('跨 Run 游标发 reset，不把坏游标当业务失败', async () => {
    mocks.loadRunObservation.mockResolvedValue(observation())
    mocks.listRunEventsAfter.mockResolvedValue([])
    const res = mockResponse()
    const controller = new AbortController()
    await service.stream({
      runId,
      lastEventId: `${otherRun}:3`,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: controller.signal,
    })
    expect(res.chunks.join('')).toContain('"reason":"cursor_run_mismatch"')
    controller.abort()
  })

  it('运行已删除或不存在时结束流并说明运行不存在', async () => {
    mocks.loadRunObservation.mockResolvedValue(null)
    mocks.loadRunObservationProgress.mockResolvedValue(null)
    const res = mockResponse()
    const controller = new AbortController()
    await service.stream({
      runId,
      lastEventId: `${runId}:0`,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: controller.signal,
    })
    const text = res.chunks.join('')
    expect(text).toContain('"kind":"error"')
    expect(text).toContain('"message":"运行不存在"')
    expect(res.end).toHaveBeenCalled()
    controller.abort()
  })

  it('积压过大时 skip 到高水位并 reset', async () => {
    mocks.loadRunObservation.mockResolvedValue(observation({ eventSeq: 400 }))
    mocks.loadRunObservationProgress.mockResolvedValue(progress({ eventSeq: 400 }))
    mocks.listRunEventsAfter.mockResolvedValue([])
    const res = mockResponse()
    const controller = new AbortController()
    await service.stream({
      runId,
      lastEventId: `${runId}:0`,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: controller.signal,
    })
    const text = res.chunks.join('')
    expect(text).toContain('"reason":"backlog"')
    expect(mocks.listRunEventsAfter).not.toHaveBeenCalled()
    controller.abort()
  })

  it('全量观测只在初始化调用 1 次，随后 catch-up 走轻量 progress 并折叠并发 hint', async () => {
    mocks.loadRunObservation.mockResolvedValue(observation({ eventSeq: 1 }))
    mocks.listRunEventsAfter.mockResolvedValue([])
    const res = mockResponse()
    const controller = new AbortController()
    const streamPromise = service.stream({
      runId,
      lastEventId: `${runId}:0`,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: controller.signal,
    })
    await streamPromise

    // 初始化时仅调用 1 次全量 loadRunObservation
    expect(mocks.loadRunObservation).toHaveBeenCalledTimes(1)
    // catchUp 水位及终态判断调用轻量 loadRunObservationProgress
    expect(mocks.loadRunObservationProgress).toHaveBeenCalled()
    const initialProgressCalls = mocks.loadRunObservationProgress.mock.calls.length

    // 模拟连续 5 个变化提示瞬时到达（在途合并）
    ;(service as any).notify(runId, 2)
    ;(service as any).notify(runId, 3)
    ;(service as any).notify(runId, 4)
    ;(service as any).notify(runId, 5)
    ;(service as any).notify(runId, 6)

    // 等待 microtasks/event loop 轮转
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 全量 loadRunObservation 仍然保持 1 次，没有多余的全量查询
    expect(mocks.loadRunObservation).toHaveBeenCalledTimes(1)
    // 轻量 progress 被调用，5 次提示在途折叠为至多 2 轮 catchUp（4 次读），远少于未折叠时的 10 次
    expect(mocks.loadRunObservationProgress.mock.calls.length).toBeLessThanOrEqual(initialProgressCalls + 4)
    controller.abort()
  })

  it('catch-up 失败不产生未处理拒绝，在途提示的等待者被放行', async () => {
    mocks.loadRunObservation.mockResolvedValue(observation({ eventSeq: 1 }))
    mocks.listRunEventsAfter.mockResolvedValue([])
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const res = mockResponse()
    const controller = new AbortController()
    await service.stream({
      runId,
      lastEventId: `${runId}:0`,
      account: { id: 'acc', displayName: 't', email: null, status: 'active', roles: [], permissions: ['run:read'] },
      response: res as never,
      signal: controller.signal,
    })

    // 此后每轮 catch-up 都失败：第一条提示启动循环，第二条在途生成等待者
    mocks.listRunEventsAfter.mockRejectedValue(new Error('db connection reset'))
    ;(service as any).notify(runId, 2)
    ;(service as any).notify(runId, 3)

    await new Promise((resolve) => setTimeout(resolve, 100))
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
    controller.abort()
  })

})

describe('diagnoseRunEventCursor', () => {
  it('区分过期、超前与格式错误', () => {
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: `${runId}:1`,
        eventSeq: 9,
        earliestEventSeq: 4,
      }),
    ).toEqual({ ok: false, reason: 'cursor_expired' })
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: `${runId}:12`,
        eventSeq: 9,
        earliestEventSeq: 1,
      }),
    ).toEqual({ ok: false, reason: 'cursor_ahead' })
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: 'not-a-cursor',
        eventSeq: 9,
        earliestEventSeq: 1,
      }),
    ).toEqual({ ok: false, reason: 'cursor_invalid' })
  })
})
