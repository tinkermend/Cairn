import { Inject, Injectable } from '@nestjs/common'
import {
  getEvidence,
  listRetentionObjects,
  searchEvidence,
  summarizeEvidenceRetention,
  type DbHandle,
} from '@cairn/db'
import {
  hasPermission,
  type EvidenceRetentionObjectsQuery,
  type EvidenceSearchQuery,
} from '@cairn/shared'
import { rethrowDomain } from '../common/domain-error.js'
import { config } from '../config/env'
import type { RequestAccount } from '../common/request-account'
import { DB_HANDLE } from '../db/db.module'

@Injectable()
export class EvidenceService {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  search(query: EvidenceSearchQuery, actorId: string) {
    return searchEvidence(this.db, query, actorId).catch(rethrowDomain)
  }

  get(evidenceId: string, actorId: string) {
    return getEvidence(this.db, evidenceId, actorId).catch(rethrowDomain)
  }

  summary(account: RequestAccount) {
    return summarizeEvidenceRetention(this.db, {
      actorId: account.id,
      canListDeletedRunObjects: hasPermission(account.permissions, 'run:delete'),
      pendingTtlSeconds: config.CAIRN_OBJECT_PENDING_TTL_SECONDS,
    }).catch(rethrowDomain)
  }

  objects(query: EvidenceRetentionObjectsQuery, account: RequestAccount) {
    return listRetentionObjects(this.db, query, {
      actorId: account.id,
      canListDeletedRunObjects: hasPermission(account.permissions, 'run:delete'),
      pendingTtlSeconds: config.CAIRN_OBJECT_PENDING_TTL_SECONDS,
    }).catch(rethrowDomain)
  }
}
