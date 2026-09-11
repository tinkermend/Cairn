import { Inject, Injectable } from '@nestjs/common'
import {
  createRunWithSnapshot,
  getRun,
  listRunEvidence,
  listRuns,
  requestRunCancel,
  resumeRunAfterAuth,
  reviewRun,
  type DbHandle,
} from '@cairn/db'
import type { CreateRunBody, ResumeAuthBody, ReviewRunBody } from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'

@Injectable()
export class RunsService {
  constructor(@Inject(DB_HANDLE) private readonly dbHandle: DbHandle) {}

  private get db() {
    return this.dbHandle.db
  }

  list() {
    return listRuns(this.db)
  }

  get(id: string) {
    return getRun(this.db, id).catch(rethrowDomain)
  }

  evidence(id: string) {
    return listRunEvidence(this.db, id).catch(rethrowDomain)
  }

  async create(body: CreateRunBody, actor: RequestAccount) {
    try {
      return await createRunWithSnapshot(this.db, { ...body, actor: { id: actor.id } })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async cancel(id: string, actor: RequestAccount) {
    try {
      return await requestRunCancel(this.db, id, { id: actor.id })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async review(id: string, body: ReviewRunBody, actor: RequestAccount) {
    try {
      await reviewRun(this.db, {
        runId: id,
        actor: { id: actor.id },
        conclusion: body.conclusion,
        note: body.note,
      })
      return await getRun(this.db, id)
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async resumeAuth(id: string, body: ResumeAuthBody, actor: RequestAccount) {
    try {
      await resumeRunAfterAuth(this.db, {
        runId: id,
        actor: { id: actor.id },
        note: body.note,
      })
      return await getRun(this.db, id)
    } catch (error) {
      rethrowDomain(error)
    }
  }
}
