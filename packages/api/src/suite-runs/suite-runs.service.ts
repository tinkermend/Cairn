import { Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  cancelSuiteRun,
  createSuiteRun,
  getSuiteRunObservation,
  listSuiteRunEventsAfter,
  listSuiteRuns,
  previewSuiteRun,
  type DbHandle,
} from '@cairn/db'
import type { CreateSuiteRunBody, SuiteRunListQuery } from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import { abortWhenSseClientDrops } from '../common/sse-abort.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class SuiteRunsService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  private actor(account: RequestAccount) {
    return { kind: 'console' as const, id: account.id }
  }

  list(query: SuiteRunListQuery, actorId: string) {
    return listSuiteRuns(this.database, query, actorId).catch(rethrowDomain)
  }

  preview(body: CreateSuiteRunBody, actorId: string) {
    return previewSuiteRun(this.database, body, actorId).catch(rethrowDomain)
  }

  create(body: CreateSuiteRunBody, account: RequestAccount) {
    return createSuiteRun(this.database, body, this.actor(account)).catch(rethrowDomain)
  }

  observation(suiteRunId: string, actorId: string) {
    return getSuiteRunObservation(this.database, suiteRunId, actorId).catch(rethrowDomain)
  }

  cancel(suiteRunId: string, account: RequestAccount) {
    return cancelSuiteRun(this.database, suiteRunId, this.actor(account)).catch(rethrowDomain)
  }

  async stream(suiteRunId: string, actorId: string, req: Request, res: Response) {
    const first = await this.observation(suiteRunId, actorId)
    const signal = abortWhenSseClientDrops(req, res)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.flushHeaders?.()
    let after = 0
    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    try {
      write('observation', first)
      after = first.eventSeq
      if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(first.status) && first.evidenceStatus !== 'PENDING' && first.automaticReport?.status !== 'pending') return
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (signal.aborted) break
        const observation = await getSuiteRunObservation(this.database, suiteRunId, actorId)
        const events = await listSuiteRunEventsAfter(this.database, suiteRunId, after)
        for (const event of events) write('event', event)
        after = events.at(-1)?.seq ?? after
        write('observation', observation)
        if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(observation.status) && observation.evidenceStatus !== 'PENDING' && observation.automaticReport?.status !== 'pending') break
      }
    } catch (error) {
      if (!signal.aborted) write('error', { message: '集合运行进度不可访问，请刷新检查当前权限' })
    } finally {
      if (!res.writableEnded) res.end()
    }
  }
}
