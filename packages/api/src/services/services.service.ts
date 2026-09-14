import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import * as repository from '@cairn/db'
import type {
  ExternalRunBody,
  IssueServiceCredential,
  ServiceCallerBody,
  ServiceCredentialPolicy,
  ServicePageQuery,
  ServicePrincipal,
} from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { DB_HANDLE } from '../db/db.module'
import { OBJECT_STORE } from '../objects/object-store.token'
import { rethrowDomain } from '../common/domain-error'
import { config } from '../config/env'
import { PlatformConfigService } from '../platform-config/platform-config.service'

@Injectable()
export class ServicesService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: repository.DbHandle,
    @Optional() @Inject(OBJECT_STORE) private readonly store?: ObjectStore,
    @Optional() private readonly platformConfig?: PlatformConfigService,
  ) {}
  authenticate(header?: string) {
    return repository.authenticateService(this.db, header).catch(rethrowDomain)
  }
  list(q: ServicePageQuery) {
    return repository.listServiceCallers(this.db, q).catch(rethrowDomain)
  }
  get(id: string) {
    return repository.getServiceCaller(this.db, id).catch(rethrowDomain)
  }
  save(id: string | null, body: ServiceCallerBody, actor: repository.AuditActor) {
    return repository.saveServiceCaller(this.db, id, body, actor).catch(rethrowDomain)
  }
  issue(id: string, body: IssueServiceCredential, actor: repository.AuditActor) {
    return repository.issueServiceCredential(this.db, id, body, actor).catch(rethrowDomain)
  }
  update(
    id: string,
    keyId: string,
    body: ServiceCredentialPolicy | null,
    actor: repository.AuditActor,
  ) {
    return repository.updateServiceCredential(this.db, id, keyId, body, actor).catch(rethrowDomain)
  }
  catalog(actor: ServicePrincipal, q: ServicePageQuery, targetId?: string) {
    return repository.serviceCatalog(this.db, actor, q, targetId).catch(rethrowDomain)
  }
  async create(actor: ServicePrincipal, body: ExternalRunBody, requestId: string) {
    await this.platformConfig?.ensure()
    return repository
      .createServiceRun(this.db, actor, body, requestId, undefined, config.CAIRN_BROWSER_AI_HANG_WAIT_MS)
      .catch(rethrowDomain)
  }
  runs(actor: ServicePrincipal, q: ServicePageQuery) {
    return repository.listServiceRuns(this.db, actor, q).catch(rethrowDomain)
  }
  run(actor: ServicePrincipal, id: string, cancel = false) {
    return repository.getServiceRun(this.db, actor, id, cancel).catch(rethrowDomain)
  }
  async evidence(actor: ServicePrincipal, id: string, q: ServicePageQuery) {
    const { object: _, ...result } = await repository
      .serviceEvidence(this.db, actor, id, q)
      .catch(rethrowDomain)
    return result
  }
  release(runId: string, evidenceId: string, allowed: boolean, actor: repository.AuditActor) {
    return repository
      .releaseServiceEvidence(this.db, runId, evidenceId, allowed, actor)
      .catch(rethrowDomain)
  }
  async content(actor: ServicePrincipal, runId: string, id: string) {
    const { object } = await repository
      .serviceEvidence(this.db, actor, runId, { limit: 1 }, id)
      .catch(rethrowDomain)
    if (!object?.objectKey || !this.store) throw new NotFoundException('证据不可用')
    let file
    try {
      file = await this.store.get(object.objectKey)
    } catch {
      throw new NotFoundException('证据不可用')
    }
    // Recheck after storage IO; database failures retain their service-error semantics.
    await repository.serviceEvidence(this.db, actor, runId, { limit: 1 }, id).catch(rethrowDomain)
    return { body: file.body, contentType: object.contentType! }
  }
}
