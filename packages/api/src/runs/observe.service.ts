import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Response } from 'express'
import {
  diagnoseRunEventCursor,
  listRunEventWatermarks,
  listRunEventsAfter,
  loadRunObservation,
  type ChangeHintBus,
  type DbHandle,
} from '@cairn/db'
import {
  encodeRunEventCursor,
  hasPermission,
  isRunObservationComplete,
  persistedRunEventSchema,
  runStreamControlSchema,
  type PersistedRunEvent,
  type RunStreamControl,
} from '@cairn/shared'
import type { RequestAccount } from '../common/request-account'
import { AuthService } from '../auth/auth.service'
import { classifyAccountRecheck } from '../common/domain-error'
import { config } from '../config/env'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'

type StreamListener = (eventSeq: number) => void

@Injectable()
export class ObserveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ObserveService.name)
  private readonly listeners = new Map<string, Set<StreamListener>>()
  private reconcile: NodeJS.Timeout | undefined
  private subscribed = false

  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(CHANGE_HINT) private readonly bus: ChangeHintBus,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.bus.realtime) return
    try {
      await this.bus.subscribe(
        (hint) => this.notify(hint.runId, hint.eventSeq),
        () => {
          for (const runId of this.listeners.keys()) {
            void loadRunObservation(this.db, runId)
              .then((observation) => {
                if (observation) this.notify(runId, observation.eventSeq)
              })
              .catch((error) => this.logger.error(error, 'change-hint reconnect catch-up failed'))
          }
        },
      )
      this.subscribed = true
    } catch (error) {
      this.subscribed = false
      this.logger.error(error, 'change-hint subscribe failed')
    }
    this.reconcile = setInterval(() => {
      void this.reconcileWatermarks()
    }, config.CAIRN_OBSERVE_RECONCILE_MS)
    this.reconcile.unref()
  }

  onModuleDestroy(): void {
    if (this.reconcile) clearInterval(this.reconcile)
  }

  status(): 'up' | 'down' | 'unused' {
    if (!this.bus.realtime) return 'unused'
    return this.subscribed ? 'up' : 'down'
  }

  async ping(): Promise<'up' | 'down' | 'unused'> {
    if (!this.bus.realtime) return 'unused'
    return (await this.bus.ping()) ? 'up' : 'down'
  }

  observation(runId: string) {
    return loadRunObservation(this.db, runId)
  }

  async stream(
    input: {
      runId: string
      lastEventId?: string
      authorization?: string
      account: RequestAccount
      response: Response
      signal: AbortSignal
    },
  ): Promise<void> {
    const res = input.response
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const expiresAt = this.tokenExpiresAt(input.authorization)
    let closed = false
    let applied = 0
    let acceptHints = false
    let readySent = false
    let catchingUp = Promise.resolve()
    let heartbeat: NodeJS.Timeout | undefined
    let authTick: NodeJS.Timeout | undefined
    const close = () => {
      if (closed) return
      closed = true
      if (heartbeat) clearInterval(heartbeat)
      if (authTick) clearInterval(authTick)
      this.unwatch(input.runId, onHint)
      if (!res.writableEnded) res.end()
    }
    const sendEvent = (event: PersistedRunEvent) => {
      if (closed) return
      writeFrame(res, {
        id: encodeRunEventCursor(event.runId, event.sequence),
        event: event.type,
        data: persistedRunEventSchema.parse(event),
      })
      applied = event.sequence
    }
    const sendControl = (control: RunStreamControl) => {
      if (closed) return
      writeControl(res, control)
    }

    const catchUp = async () => {
      const watermark = await loadRunObservation(this.db, input.runId)
      if (!watermark) {
        sendControl({
          kind: 'error',
          runId: input.runId,
          code: 'INTERNAL',
          message: '运行不存在',
        })
        close()
        return
      }
      if (watermark.eventSeq - applied > config.CAIRN_SSE_BACKLOG) {
        sendControl({ kind: 'reset', runId: input.runId, reason: 'backlog' })
        applied = watermark.eventSeq
      } else {
        for (;;) {
          const page = await listRunEventsAfter(
            this.db,
            input.runId,
            applied,
            config.CAIRN_RUN_EVENT_PAGE_SIZE,
          )
          for (const event of page) sendEvent(event)
          if (closed) return
          if (page.length < config.CAIRN_RUN_EVENT_PAGE_SIZE) break
        }
      }
      const latest = await loadRunObservation(this.db, input.runId)
      if (readySent && latest && isRunObservationComplete(latest.run)) {
        sendControl({ kind: 'complete', runId: input.runId, eventSeq: latest.eventSeq })
        close()
      }
    }
    const enqueueCatchUp = () => {
      catchingUp = catchingUp
        .then(() => (closed ? undefined : catchUp()))
        .catch((error) => this.logger.error(error, 'run event catch-up failed'))
      return catchingUp
    }

    const onHint: StreamListener = () => {
      if (!acceptHints) return
      void enqueueCatchUp()
    }

    this.watch(input.runId, onHint)
    input.signal.addEventListener('abort', close)
    res.on('close', close)

    const initial = await loadRunObservation(this.db, input.runId)
    if (!initial) {
      sendControl({
        kind: 'error',
        runId: input.runId,
        code: 'INTERNAL',
        message: '运行不存在',
      })
      close()
      return
    }
    const cursor = diagnoseRunEventCursor({
      runId: input.runId,
      lastEventId: input.lastEventId,
      eventSeq: initial.eventSeq,
      earliestEventSeq: initial.earliestEventSeq,
    })
    if (!cursor.ok) {
      sendControl({ kind: 'reset', runId: input.runId, reason: cursor.reason })
      applied = initial.earliestEventSeq > 0 ? initial.earliestEventSeq - 1 : 0
    } else {
      applied = cursor.after
    }
    acceptHints = true
    if (Date.now() >= expiresAt) {
      sendControl({
        kind: 'error',
        runId: input.runId,
        code: 'UNAUTHORIZED',
        message: '登录已过期或无效',
      })
      close()
      return
    }

    await enqueueCatchUp()
    if (closed) return
    sendControl({
      kind: 'ready',
      runId: input.runId,
      eventSeq: applied,
      earliestEventSeq: initial.earliestEventSeq,
      realtime: this.subscribed,
    })
    readySent = true
    const afterReady = await loadRunObservation(this.db, input.runId)
    if (afterReady && isRunObservationComplete(afterReady.run)) {
      sendControl({ kind: 'complete', runId: input.runId, eventSeq: afterReady.eventSeq })
      close()
      return
    }

    heartbeat = setInterval(() => {
      if (closed) return
      res.write(': keepalive\n\n')
    }, config.CAIRN_SSE_HEARTBEAT_MS)
    heartbeat.unref()

    authTick = setInterval(() => {
      void this.recheck(input.account.id, expiresAt)
        .then((code) => {
          if (!code) return
          sendControl({
            kind: 'error',
            runId: input.runId,
            code,
            message:
              code === 'UNAUTHORIZED'
                ? '登录已过期或无效'
                : code === 'FORBIDDEN'
                  ? '没有运行读取权限'
                  : '服务暂时不可用',
          })
          close()
        })
        .catch((error) => this.logger.error(error, 'sse auth refresh failed'))
    }, config.CAIRN_SSE_AUTH_REFRESH_MS)
    authTick.unref()
  }

  private watch(runId: string, listener: StreamListener): void {
    const set = this.listeners.get(runId) ?? new Set()
    set.add(listener)
    this.listeners.set(runId, set)
  }

  private unwatch(runId: string, listener: StreamListener): void {
    const set = this.listeners.get(runId)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) this.listeners.delete(runId)
  }

  private notify(runId: string, eventSeq: number): void {
    const set = this.listeners.get(runId)
    if (!set) return
    for (const listener of set) listener(eventSeq)
  }

  private async reconcileWatermarks(): Promise<void> {
    const runIds = [...this.listeners.keys()]
    if (runIds.length === 0) return
    const marks = await listRunEventWatermarks(this.db, runIds)
    for (const [runId, eventSeq] of marks) this.notify(runId, eventSeq)
  }

  private tokenExpiresAt(authorization?: string): number {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    if (!token) return Date.now() + 12 * 3600 * 1000
    const payload = this.jwt.decode(token)
    if (payload && typeof payload === 'object' && 'exp' in payload && typeof payload.exp === 'number') {
      return payload.exp * 1000
    }
    return Date.now() + 12 * 3600 * 1000
  }

  private async recheck(
    accountId: string,
    expiresAt: number,
  ): Promise<'UNAUTHORIZED' | 'FORBIDDEN' | 'INTERNAL' | null> {
    if (Date.now() >= expiresAt) return 'UNAUTHORIZED'
    try {
      const account = await this.auth.resolveAccount(accountId)
      if (account.status === 'disabled') return 'FORBIDDEN'
      if (!hasPermission(account.permissions, 'run:read')) return 'FORBIDDEN'
      return null
    } catch (error) {
      return classifyAccountRecheck(error)
    }
  }
}

function writeControl(res: Response, control: RunStreamControl): void {
  writeFrame(res, { event: control.kind, data: runStreamControlSchema.parse(control) })
}

function writeFrame(res: Response, frame: { id?: string; event: string; data: unknown }): void {
  if (frame.id) res.write(`id: ${frame.id}\n`)
  res.write(`event: ${frame.event}\n`)
  const text = JSON.stringify(frame.data)
  for (const line of text.split('\n')) res.write(`data: ${line}\n`)
  res.write('\n')
}
