import { Inject, Injectable } from '@nestjs/common'
import {
  getBusinessSource,
  previewBusinessSource,
  createBusinessSourceCandidate,
  getBusinessSourceCandidate,
  approveBusinessSourceCandidate,
  revokeBusinessSource,
  listBusinessRecords,
  type DbHandle,
} from '@cairn/db'
import type {
  ApproveCandidateBody,
  BusinessRecordsListQuery,
  CreateBusinessSourceCandidateBody,
  PreviewBusinessSourceBody,
  RevokeSourceBody,
} from '@cairn/shared'
import { DB_HANDLE } from '../db/db.module.js'
import { rethrowDomain } from '../common/domain-error.js'

@Injectable()
export class BusinessSourcesService {
  constructor(@Inject(DB_HANDLE) private readonly database: DbHandle) {}

  getBusinessSource(targetId: string, entityType: string, actorId: string) {
    return getBusinessSource(this.database, targetId, entityType, actorId).catch(rethrowDomain)
  }

  previewBusinessSource(targetId: string, input: PreviewBusinessSourceBody, actorId: string) {
    return previewBusinessSource(this.database, targetId, input, actorId).catch(rethrowDomain)
  }

  createCandidate(targetId: string, input: CreateBusinessSourceCandidateBody, actorId: string) {
    return createBusinessSourceCandidate(this.database, targetId, input, actorId).catch(rethrowDomain)
  }

  getCandidate(targetId: string, candidateId: string, actorId: string) {
    return getBusinessSourceCandidate(this.database, targetId, candidateId, actorId).catch(rethrowDomain)
  }

  approveCandidate(
    targetId: string,
    candidateId: string,
    input: ApproveCandidateBody,
    actorId: string,
  ) {
    return approveBusinessSourceCandidate(this.database, targetId, candidateId, input, actorId).catch(rethrowDomain)
  }

  revokeSource(
    targetId: string,
    entityType: string,
    input: RevokeSourceBody,
    actorId: string,
  ) {
    return revokeBusinessSource(
      this.database,
      targetId,
      entityType,
      input,
      actorId,
    ).catch(rethrowDomain)
  }

  listBusinessRecords(targetId: string, query: BusinessRecordsListQuery, actorId: string) {
    return listBusinessRecords(this.database, targetId, query, actorId).catch(rethrowDomain)
  }
}
