import {
  ConflictException,
  ForbiddenException,
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
  ExternalRunDto,
  ExternalToolAttention,
  ExternalToolCall,
  ExternalToolReceipt,
  ExternalToolResult,
} from "@cairn/shared";
import {
  externalToolReceiptSchema,
  externalToolResultSchema,
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

  async tools(actor: ServicePrincipal, q: ServicePageQuery) {
    const catalog = await repository
      .serviceToolsCatalog(this.db, actor, q)
      .catch(rethrowDomain);
    return {
      revision: 1,
      principalScopeDigest: actor.id,
      items: catalog.items,
      nextCursor: catalog.nextCursor,
    };
  }

  async tool(actor: ServicePrincipal, toolKey: string) {
    const catalog = await repository
      .serviceToolsCatalog(this.db, actor, { limit: 1 }, toolKey)
      .catch(rethrowDomain);
    const item = catalog.items[0];
    if (!item) {
      throw new NotFoundException(`工具「${toolKey}」不存在或未授权`);
    }
    return item;
  }

  async callTool(
    actor: ServicePrincipal,
    toolKey: string,
    body: ExternalToolCall,
    requestId: string,
  ): Promise<
    | { sync: true; data: ExternalToolResult }
    | { sync: false; data: ExternalToolReceipt }
  > {
    // 同步等待要读 Run；先拦下，避免 Run 已受理而调用方只收到 403。
    if (!body.async && !actor.scopes.includes("run:read"))
      throw new ForbiddenException({
        code: "SERVICE_SCOPE_DENIED",
        message: "同步调用需要读取运行权限（run:read），或改用 async: true",
      });
    const descriptor = await this.tool(actor, toolKey);
    if (
      body.descriptorVersion &&
      body.descriptorVersion !== descriptor.descriptorVersion
    )
      throw new ConflictException({
        code: "TOOL_DESCRIPTOR_CHANGED",
        message: `工具已更新为 ${descriptor.descriptorVersion}，请重新读取工具描述后再调用`,
        details: { descriptorVersion: descriptor.descriptorVersion },
      });

    const runBody: ExternalRunBody = {
      scenarioId: descriptor.scenarioId,
      scenarioVersionId: descriptor.scenarioVersionId,
      targetAccountId: body.targetAccountId,
      input: body.arguments as ExternalRunBody["input"],
      idempotencyKey: body.requestKey,
    };

    const createResult = await this.create(actor, runBody, requestId);
    let currentRun = createResult.detail;
    if (body.async) return { sync: false, data: toolReceipt(currentRun, "ACCEPTED") };

    // 同步等待有上限（默认 30 秒，防 HTTP 网关超时），到时转为可轮询回执。
    const start = Date.now();
    const timeoutMs = Number(process.env.CAIRN_TOOL_CALL_TIMEOUT_MS || 30_000);
    const pollIntervalMs = Math.min(500, Math.max(10, Math.floor(timeoutMs / 10)));
    while (true) {
      if (FINISHED_TOOL_STATUSES.has(currentRun.status))
        return { sync: true, data: toolResult(currentRun) };
      // 需要人来处理的状态不会在等待窗口内自行结束，立即交回回执。
      if (HUMAN_WAIT_STATUSES.has(currentRun.status))
        return { sync: false, data: toolReceipt(currentRun, "RUNNING") };
      if (Date.now() - start >= timeoutMs) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      currentRun = await this.run(actor, currentRun.id);
    }
    return { sync: false, data: toolReceipt(currentRun, "RUNNING") };
  }
}


const FINISHED_TOOL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
/** WAITING_FOR_AUTH 可能被自动重登恢复，继续等；这两类只能等人。 */
const HUMAN_WAIT_STATUSES = new Set(["NEEDS_REVIEW", "HOLDING"]);

function toolAttention(run: ExternalRunDto): ExternalToolAttention | null {
  if (run.status === "WAITING_FOR_AUTH")
    return {
      reason: "WAITING_FOR_AUTH",
      message: "运行在等待目标系统登录，自动重登未完成时需在控制台完成认证",
    };
  if (run.status === "NEEDS_REVIEW")
    return { reason: "NEEDS_REVIEW", message: "运行需要人工复核后才能给出结论" };
  if (run.status === "HOLDING")
    return { reason: "HOLDING", message: "运行已挂起，需在控制台继续或取消" };
  return null;
}

function toolReceipt(
  run: ExternalRunDto,
  status: ExternalToolReceipt["status"],
): ExternalToolReceipt {
  return externalToolReceiptSchema.parse({
    callId: run.id,
    runId: run.id,
    status,
    executionStatus: run.status,
    attention: toolAttention(run),
    pollUrl: `/api/open/v1/runs/${run.id}`,
    createdAt: run.createdAt,
  });
}

function toolResult(run: ExternalRunDto): ExternalToolResult {
  const outputs: ExternalToolResult["outputs"] = [];
  const errors: ExternalToolResult["errors"] = [];
  for (const step of run.stepRuns) {
    // 以最后一次尝试为准：重试成功后不再报告前面的失败。
    const last = step.attempts[step.attempts.length - 1];
    if (!last) continue;
    if (last.output !== null) outputs.push({ stepName: step.name, payload: last.output });
    if (last.errorCode)
      errors.push({
        stepName: step.name,
        errorCode: last.errorCode,
        errorCategory: last.errorCategory,
        retryable: last.retryable,
      });
  }
  return externalToolResultSchema.parse({
    callId: run.id,
    runId: run.id,
    statusRefs: { runId: run.id },
    executionStatus: run.status,
    outcomeStatus: run.outcomeStatus,
    outcomeResults: run.outcomeResults,
    evidenceStatus: run.evidenceStatus,
    outputs,
    errors,
    unknowns: [],
  });
}
