import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import {
  createRunWithSnapshot,
  deleteRun,
  getEvidenceForRun,
  getRun,
  getRunCleanupStatus,
  listMapSelectionDecisions,
  listRunEvidence,
  listRuns,
  loadScenarioVersion,
  previewDeleteRun,
  requestRunCancel,
  retryRunCleanup,
  reviewRun,
  type DbHandle,
} from '@cairn/db'
import { assertAiExecutePermission } from '../config/browser-ai'
import { config } from '../config/env'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import type { CreateRunBody, DeleteResourceBody, MapDecisionListQuery, ReviewRunBody, RunListQuery } from '@cairn/shared'
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
    @Optional() private readonly platformConfig?: PlatformConfigService,
  ) {}

  private get db() {
    return this.dbHandle
  }

  list(query?: RunListQuery) {
    return listRuns(this.db, query).catch(rethrowDomain)
  }

  get(id: string) {
    return getRun(this.db, id).catch(rethrowDomain)
  }

  mapDecisions(id: string, query: MapDecisionListQuery) {
    return listMapSelectionDecisions(this.db, id, query).catch(rethrowDomain)
  }

  previewDelete(id: string) {
    return previewDeleteRun(this.db, id).catch(rethrowDomain)
  }

  delete(id: string, actor: RequestAccount, body?: DeleteResourceBody) {
    return deleteRun(this.db, id, actor, body).catch(rethrowDomain)
  }

  cleanupStatus(id: string) {
    return getRunCleanupStatus(this.db, id).catch(rethrowDomain)
  }

  retryCleanup(id: string, actor: RequestAccount) {
    return retryRunCleanup(this.db, id, actor).catch(rethrowDomain)
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
        filename: filenameFor(row.type, runId),
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
      await this.platformConfig?.ensure()
      const { version } = await loadScenarioVersion(this.db, body.scenarioId, body.scenarioVersionId)
      assertAiExecutePermission(actor, version.definition.steps)
      return await createRunWithSnapshot(this.db, {
        ...body,
        actor: { id: actor.id },
        hangWaitMs: config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      })
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

}

function filenameFor(type: string, runId: string): string {
  if (type === 'screenshot') return 'screenshot.png'
  if (type === 'trace') return 'trace.zip'
  if (type === 'video') return `run-${runId.slice(0, 8)}.webm`
  return 'evidence.bin'
}
