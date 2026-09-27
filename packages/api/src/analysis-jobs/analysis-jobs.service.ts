import { Inject, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  cancelAnalysisJob,
  getAnalysisJob,
  getJobInsight,
  getJobInsights,
  listAnalysisJobEvents,
  listAnalysisJobs,
  reviewAnalysisCandidate,
  type ChangeHintBus,
  type DbHandle,
} from '@cairn/db'
import type { AnalysisJobCancelBody, AnalysisJobListQuery, ReviewAnalysisCandidateBody } from '@cairn/shared'
import { redactKnowledgeQuestion } from '@cairn/map'
import { rethrowDomain } from '../common/domain-error.js'
import { observeObject } from '../common/observe-object.js'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'

@Injectable()
export class AnalysisJobsService {
  constructor(
    @Inject(DB_HANDLE) private readonly database: DbHandle,
    @Inject(CHANGE_HINT) private readonly hints: ChangeHintBus,
  ) {}

  list(query: AnalysisJobListQuery, actorId: string) {
    return listAnalysisJobs(this.database, query, actorId).catch(rethrowDomain)
  }

  get(jobId: string, actorId: string) {
    return getAnalysisJob(this.database, jobId, actorId).catch(rethrowDomain)
  }

  review(candidateId: string, body: ReviewAnalysisCandidateBody, account: RequestAccount) {
    const safe = body.kind === 'term' ? { ...body, canonicalName: redactKnowledgeQuestion(body.canonicalName), aliases: body.aliases.map(redactKnowledgeQuestion), meaning: redactKnowledgeQuestion(body.meaning) }
      : body.kind === 'reject' ? { ...body, reason: redactKnowledgeQuestion(body.reason) } : body
    return reviewAnalysisCandidate(this.database, candidateId, safe, { kind: 'console', id: account.id }).catch(rethrowDomain)
  }

  cancel(jobId: string, body: AnalysisJobCancelBody, account: RequestAccount) {
    return cancelAnalysisJob(this.database, jobId, { kind: 'console', id: account.id }, body.idempotencyKey).catch(
      rethrowDomain,
    )
  }

  insights(jobId: string, actorId: string) {
    return getJobInsights(this.database, jobId, actorId).catch(rethrowDomain)
  }

  insight(jobId: string, insightId: string, actorId: string) {
    return getJobInsight(this.database, jobId, insightId, actorId).catch(rethrowDomain)
  }

  async observe(jobId: string, actorId: string, req: Request, res: Response, after = 0) {
    return observeObject({ req, res, after, hints: this.hints, objectId: jobId, event: 'job',
      matches: hint => hint.objectType === 'analysis_job' && hint.objectId === jobId,
      snapshot: () => this.get(jobId, actorId),
      events: async cursor => (await listAnalysisJobEvents(this.database, jobId, cursor, actorId)).map(({ id, createdAt, ...event }) => ({ ...event, eventId: id, createdAt: createdAt.toISOString() })),
      finished: job => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status),
    })
  }
}
