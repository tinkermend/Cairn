import {
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import * as repository from "@cairn/db";
import type {
  ExternalRunBody,
  IssueServiceCredential,
  ServiceCallerBody,
  ServiceCallerQuery,
  ServiceCallerStatusBody,
  ServiceCredentialMetadataBody,
  ServiceCredentialPolicy,
  ServiceOutstandingRunQuery,
  ServicePageQuery,
  ServicePrincipal,
  ServiceIpWhitelistBody,
  ServiceRequestLogQuery,
  ServiceRequestLogRecord,
  ServiceWebhookDeliveryQuery,
  ServiceWebhookWrite,
  ServicePlaygroundRunBody,
} from "@cairn/shared";
import type { ObjectStore } from "@cairn/storage";
import { DB_HANDLE } from "../db/db.module";
import { OBJECT_STORE } from "../objects/object-store.token";
import { rethrowDomain } from "../common/domain-error";
import { config } from "../config/env";
import { PlatformConfigService } from "../platform-config/platform-config.service";
import { LocalSecretProvider } from "../secrets/local-secret-provider";

@Injectable()
export class ServicesService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: repository.DbHandle,
    private readonly secrets: LocalSecretProvider,
    @Optional() @Inject(OBJECT_STORE) private readonly store?: ObjectStore,
    @Optional() private readonly platformConfig?: PlatformConfigService,
  ) {}
  authenticate(
    header: string | undefined,
    clientIp: string | null,
    onCredentialVerified: (context: {
      callerId: string;
      credentialId: string;
    }) => void,
  ) {
    return repository
      .authenticateService(this.db, header, { clientIp, onCredentialVerified })
      .catch(rethrowDomain);
  }
  list(q: ServiceCallerQuery) {
    return repository.listServiceCallers(this.db, q).catch(rethrowDomain);
  }
  get(id: string) {
    return repository.getServiceCaller(this.db, id).catch(rethrowDomain);
  }
  save(
    id: string | null,
    body: ServiceCallerBody,
    actor: repository.AuditActor,
  ) {
    return repository
      .saveServiceCaller(this.db, id, body, actor)
      .catch(rethrowDomain);
  }
  status(
    id: string,
    body: ServiceCallerStatusBody,
    actor: repository.AuditActor,
  ) {
    return repository
      .setServiceCallerStatus(this.db, id, body, actor)
      .catch(rethrowDomain);
  }
  archive(id: string, actor: repository.AuditActor) {
    return repository
      .archiveServiceCaller(this.db, id, actor)
      .catch(rethrowDomain);
  }
  ipWhitelist(
    id: string,
    body: ServiceIpWhitelistBody,
    actor: repository.AuditActor,
  ) {
    return repository
      .setServiceCallerIpWhitelist(this.db, id, body, actor)
      .catch(rethrowDomain);
  }
  outstanding(
    id: string,
    q: ServiceOutstandingRunQuery,
    actor: repository.AuditActor,
  ) {
    return repository
      .listServiceOutstandingRuns(this.db, id, q, actor)
      .catch(rethrowDomain);
  }
  cancelOutstandingRun(
    id: string,
    runId: string,
    actor: repository.AuditActor,
  ) {
    return repository
      .cancelServiceOutstandingRun(this.db, id, runId, actor)
      .catch(rethrowDomain);
  }
  issue(
    id: string,
    body: IssueServiceCredential,
    actor: repository.AuditActor,
  ) {
    return repository
      .issueServiceCredential(this.db, id, body, actor)
      .catch(rethrowDomain);
  }
  update(
    id: string,
    keyId: string,
    body: ServiceCredentialPolicy | null,
    actor: repository.AuditActor,
  ) {
    return repository
      .updateServiceCredential(this.db, id, keyId, body, actor)
      .catch(rethrowDomain);
  }
  suspend(id: string, keyId: string, actor: repository.AuditActor) {
    return repository
      .setServiceCredentialSuspended(this.db, id, keyId, true, actor)
      .catch(rethrowDomain);
  }
  reactivate(id: string, keyId: string, actor: repository.AuditActor) {
    return repository
      .setServiceCredentialSuspended(this.db, id, keyId, false, actor)
      .catch(rethrowDomain);
  }
  metadata(
    id: string,
    keyId: string,
    body: ServiceCredentialMetadataBody,
    actor: repository.AuditActor,
  ) {
    return repository
      .updateServiceCredentialMetadata(this.db, id, keyId, body, actor)
      .catch(rethrowDomain);
  }
  catalog(actor: ServicePrincipal, q: ServicePageQuery, targetId?: string) {
    return repository
      .serviceCatalog(this.db, actor, q, targetId)
      .catch(rethrowDomain);
  }
  credentialCatalog(id: string, keyId: string, actor: repository.AuditActor) {
    return repository
      .getServiceCredentialCatalog(this.db, id, keyId, actor)
      .catch(rethrowDomain);
  }
  webhook(id: string, actor: repository.AuditActor) {
    return repository.getServiceWebhook(this.db, id, actor).catch(rethrowDomain);
  }
  async saveWebhook(
    id: string,
    body: ServiceWebhookWrite,
    actor: repository.AuditActor,
  ) {
    let sealed: { id: string; ciphertext: Buffer } | undefined;
    if (body.secret !== undefined) {
      const secretId =
        (await repository.getServiceWebhookSecretId(this.db, id, actor).catch(rethrowDomain)) ??
        repository.newId();
      sealed = {
        id: secretId,
        ciphertext: this.secrets.encrypt(secretId, body.secret),
      };
    }
    return repository
      .saveServiceWebhook(this.db, id, body, actor, sealed)
      .catch(rethrowDomain);
  }
  webhookDeliveries(
    id: string,
    query: ServiceWebhookDeliveryQuery,
    actor: repository.AuditActor,
  ) {
    return repository
      .listServiceWebhookDeliveries(this.db, id, query, actor)
      .catch(rethrowDomain);
  }
  retryWebhookDelivery(
    id: string,
    deliveryId: string,
    actor: repository.AuditActor,
  ) {
    return repository
      .retryServiceWebhookDelivery(this.db, id, deliveryId, actor)
      .catch(rethrowDomain);
  }
  async playground(
    id: string,
    body: ServicePlaygroundRunBody,
    actor: repository.AuditActor,
    requestId: string,
  ) {
    await this.platformConfig?.ensure();
    return repository
      .createServicePlaygroundRun(
        this.db,
        id,
        body,
        actor,
        requestId,
        config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      )
      .catch(rethrowDomain);
  }
  openApi(id: string, actor: repository.AuditActor) {
    return repository.buildServiceOpenApi(this.db, id, actor).catch(rethrowDomain);
  }
  logs(id: string, q: ServiceRequestLogQuery, actor: repository.AuditActor) {
    return repository
      .listServiceRequestLogs(this.db, id, q, actor)
      .catch(rethrowDomain);
  }
  log(id: string, logId: string, actor: repository.AuditActor) {
    return repository
      .getServiceRequestLog(this.db, id, logId, actor)
      .catch(rethrowDomain);
  }
  recordRequestLog(record: ServiceRequestLogRecord) {
    return repository.recordServiceRequestLog(this.db, record);
  }
  async create(
    actor: ServicePrincipal,
    body: ExternalRunBody,
    requestId: string,
  ) {
    await this.platformConfig?.ensure();
    return repository
      .createServiceRun(
        this.db,
        actor,
        body,
        requestId,
        undefined,
        config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      )
      .catch(rethrowDomain);
  }
  runs(actor: ServicePrincipal, q: ServicePageQuery) {
    return repository.listServiceRuns(this.db, actor, q).catch(rethrowDomain);
  }
  run(actor: ServicePrincipal, id: string, cancel = false) {
    return repository
      .getServiceRun(this.db, actor, id, cancel)
      .catch(rethrowDomain);
  }
  async evidence(actor: ServicePrincipal, id: string, q: ServicePageQuery) {
    const { object: _, ...result } = await repository
      .serviceEvidence(this.db, actor, id, q)
      .catch(rethrowDomain);
    return result;
  }
  release(
    runId: string,
    evidenceId: string,
    allowed: boolean,
    actor: repository.AuditActor,
  ) {
    return repository
      .releaseServiceEvidence(this.db, runId, evidenceId, allowed, actor)
      .catch(rethrowDomain);
  }
  async content(actor: ServicePrincipal, runId: string, id: string) {
    const { object } = await repository
      .serviceEvidence(this.db, actor, runId, { limit: 1 }, id)
      .catch(rethrowDomain);
    if (!object?.objectKey || !this.store)
      throw new NotFoundException("证据不可用");
    let file;
    try {
      file = await this.store.get(object.objectKey);
    } catch {
      throw new NotFoundException("证据不可用");
    }
    // Recheck after storage IO; database failures retain their service-error semantics.
    await repository
      .serviceEvidence(this.db, actor, runId, { limit: 1 }, id)
      .catch(rethrowDomain);
    return { body: file.body, contentType: object.contentType! };
  }
}
