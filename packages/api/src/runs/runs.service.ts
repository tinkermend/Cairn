import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import {
  createRunWithSnapshot,
  getEvidenceForRun,
  getRun,
  listRunEvidence,
  listRuns,
  requestRunCancel,
  resumeRunAfterAuth,
  reviewRun,
  type DbHandle,
} from '@cairn/db'
import type { CreateRunBody, ResumeAuthBody, ReviewRunBody } from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'
import { OBJECT_STORE } from '../objects/object-store.token'

export type EvidenceContent = {
  body: Uint8Array
  contentType: string
  byteSize: number
  filename: string
}

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Optional() @Inject(OBJECT_STORE) private readonly store?: ObjectStore,
  ) {}

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

  async evidenceContent(runId: string, evidenceId: string): Promise<EvidenceContent> {
    const row = await getEvidenceForRun(this.db, { runId, evidenceId }).catch(rethrowDomain)
    if (!row) {
      throw new NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' })
    }
    if (row.status !== 'available' || !row.objectKey) {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_AVAILABLE',
        message: row.missingReason ? `证据不可用：${row.missingReason}` : '证据不可用',
      })
    }
    if (!this.store) {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_AVAILABLE',
        message: '证据不可用：object_store_unavailable',
      })
    }
    try {
      const got = await this.store.get(row.objectKey)
      return {
        body: got.body,
        contentType: row.contentType ?? 'application/octet-stream',
        byteSize: row.byteSize ?? got.body.byteLength,
        filename: filenameFor(row.type),
      }
    } catch {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_AVAILABLE',
        message: '证据不可用：object_store_unavailable',
      })
    }
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

function filenameFor(type: string): string {
  if (type === 'screenshot') return 'screenshot.png'
  if (type === 'trace') return 'trace.zip'
  return 'evidence.bin'
}
