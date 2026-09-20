import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  SetMetadata,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  evidenceReleaseBodySchema,
  externalRunBodySchema,
  issueServiceCredentialSchema,
  serviceCallerBodySchema,
  serviceCallerQuerySchema,
  serviceCallerStatusBodySchema,
  serviceCredentialMetadataBodySchema,
  serviceCredentialPolicySchema,
  serviceIpWhitelistBodySchema,
  serviceOutstandingRunQuerySchema,
  servicePageQuerySchema,
  serviceRequestLogQuerySchema,
  serviceWebhookDeliveryQuerySchema,
  serviceWebhookWriteSchema,
  servicePlaygroundRunBodySchema,
  type ExternalRunBody,
  type IssueServiceCredential,
  type ServiceCallerBody,
  type ServiceCallerQuery,
  type ServiceCallerStatusBody,
  type ServiceCredentialMetadataBody,
  type ServiceCredentialPolicy,
  type ServiceOutstandingRunQuery,
  type ServicePageQuery,
  type ServiceIpWhitelistBody,
  type ServiceRequestLogQuery,
  type ServiceWebhookDeliveryQuery,
  type ServiceWebhookWrite,
  type ServicePlaygroundRunBody,
  type ServiceScope,
} from "@cairn/shared";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentAccount } from "../rbac/current-account.decorator";
import { RequirePermissions } from "../rbac/require-permission.decorator";
import type { RequestAccount } from "../common/request-account";
import { ServicesService } from "./services.service";

export const IS_SERVICE_API = "cairn:service-api";
export const SERVICE_REQUIRED_SCOPES = "cairn:service-scopes";
const Scope = (...scopes: ServiceScope[]) =>
  SetMetadata(SERVICE_REQUIRED_SCOPES, scopes);
const uuid = new ParseUUIDPipe();
const page = new ZodValidationPipe(servicePageQuerySchema);
const callerQuery = new ZodValidationPipe(serviceCallerQuerySchema);
const outstandingQuery = new ZodValidationPipe(
  serviceOutstandingRunQuerySchema,
);
const requestLogQuery = new ZodValidationPipe(serviceRequestLogQuerySchema);
const webhookDeliveryQuery = new ZodValidationPipe(
  serviceWebhookDeliveryQuerySchema,
);

@Controller("services")
export class ServicesController {
  constructor(private readonly services: ServicesService) {}
  @Get()
  @RequirePermissions("service:read")
  list(@Query(callerQuery) q: ServiceCallerQuery) {
    return this.services.list(q);
  }
  @Post()
  @RequirePermissions("service:write")
  create(
    @Body(new ZodValidationPipe(serviceCallerBodySchema))
    body: ServiceCallerBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.save(null, body, actor);
  }
  @Get(":id/outstanding-runs")
  @RequirePermissions("service:read", "run:read")
  outstanding(
    @Param("id", uuid) id: string,
    @Query(outstandingQuery) q: ServiceOutstandingRunQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.outstanding(id, q, actor);
  }
  @Post(":id/status")
  @HttpCode(200)
  @RequirePermissions("service:write")
  status(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(serviceCallerStatusBodySchema))
    body: ServiceCallerStatusBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.status(id, body, actor);
  }
  @Post(":id/archive")
  @HttpCode(200)
  @RequirePermissions("service:write")
  archive(
    @Param("id", uuid) id: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.archive(id, actor);
  }
  @Post(":id/ip-whitelist")
  @HttpCode(200)
  @RequirePermissions("service:write")
  ipWhitelist(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(serviceIpWhitelistBodySchema))
    body: ServiceIpWhitelistBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.ipWhitelist(id, body, actor);
  }
  @Post(":id/runs/:runId/cancel")
  @HttpCode(200)
  @RequirePermissions("service:write", "run:cancel")
  cancelRun(
    @Param("id", uuid) id: string,
    @Param("runId", uuid) runId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.cancelOutstandingRun(id, runId, actor);
  }
  @Get(":id/webhook")
  @RequirePermissions("service:read")
  webhook(
    @Param("id", uuid) id: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.webhook(id, actor);
  }
  @Post(":id/webhook")
  @HttpCode(200)
  @RequirePermissions("service:write")
  saveWebhook(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(serviceWebhookWriteSchema))
    body: ServiceWebhookWrite,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.saveWebhook(id, body, actor);
  }
  @Get(":id/webhook/deliveries")
  @RequirePermissions("service:read")
  webhookDeliveries(
    @Param("id", uuid) id: string,
    @Query(webhookDeliveryQuery) query: ServiceWebhookDeliveryQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.webhookDeliveries(id, query, actor);
  }
  @Post(":id/webhook/deliveries/:deliveryId/retry")
  @HttpCode(200)
  @RequirePermissions("service:write")
  retryWebhookDelivery(
    @Param("id", uuid) id: string,
    @Param("deliveryId", uuid) deliveryId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.retryWebhookDelivery(id, deliveryId, actor);
  }
  @Post(":id/playground/runs")
  @RequirePermissions("service:write", "run:execute", "run:read")
  async playground(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(servicePlaygroundRunBodySchema))
    body: ServicePlaygroundRunBody,
    @CurrentAccount() actor: RequestAccount,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.services.playground(
      id,
      body,
      actor,
      req.requestId ?? `playground-${id}`,
    );
    res.status(result.created ? 201 : 200);
    return result.detail;
  }
  @Get(":id/openapi.json")
  @Header("Content-Type", "application/json; charset=utf-8")
  @Header("Content-Disposition", "attachment; filename=\"cairn-openapi.json\"")
  @RequirePermissions("service:read")
  openApi(
    @Param("id", uuid) id: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.openApi(id, actor);
  }
  @Get(":id")
  @RequirePermissions("service:read")
  get(@Param("id", uuid) id: string) {
    return this.services.get(id);
  }
  @Get(":id/logs")
  @RequirePermissions("service:read")
  logs(
    @Param("id", uuid) id: string,
    @Query(requestLogQuery) q: ServiceRequestLogQuery,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.logs(id, q, actor);
  }
  @Get(":id/logs/:logId")
  @RequirePermissions("service:read")
  log(
    @Param("id", uuid) id: string,
    @Param("logId", uuid) logId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.log(id, logId, actor);
  }
  @Post(":id/update")
  @HttpCode(200)
  @RequirePermissions("service:write")
  update(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(serviceCallerBodySchema))
    body: ServiceCallerBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.save(id, body, actor);
  }
  @Post(":id/credentials")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("service:write")
  issue(
    @Param("id", uuid) id: string,
    @Body(new ZodValidationPipe(issueServiceCredentialSchema))
    body: IssueServiceCredential,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.issue(id, body, actor);
  }
  @Post(":id/credentials/:keyId/update")
  @HttpCode(200)
  @RequirePermissions("service:write")
  policy(
    @Param("id", uuid) id: string,
    @Param("keyId", uuid) keyId: string,
    @Body(new ZodValidationPipe(serviceCredentialPolicySchema))
    body: ServiceCredentialPolicy,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.update(id, keyId, body, actor);
  }
  @Post(":id/credentials/:keyId/suspend")
  @HttpCode(200)
  @RequirePermissions("service:write")
  suspend(
    @Param("id", uuid) id: string,
    @Param("keyId", uuid) keyId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.suspend(id, keyId, actor);
  }
  @Post(":id/credentials/:keyId/reactivate")
  @HttpCode(200)
  @RequirePermissions("service:write")
  reactivate(
    @Param("id", uuid) id: string,
    @Param("keyId", uuid) keyId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.reactivate(id, keyId, actor);
  }
  @Get(":id/credentials/:keyId/catalog")
  @RequirePermissions("service:read")
  credentialCatalog(
    @Param("id", uuid) id: string,
    @Param("keyId", uuid) keyId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.credentialCatalog(id, keyId, actor);
  }
  @Post(":id/credentials/:keyId/rename")
  @HttpCode(200)
  @RequirePermissions("service:write")
  metadata(
    @Param("id", uuid) id: string,
    @Param("keyId", uuid) keyId: string,
    @Body(new ZodValidationPipe(serviceCredentialMetadataBodySchema))
    body: ServiceCredentialMetadataBody,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.metadata(id, keyId, body, actor);
  }
  @Post(":id/credentials/:keyId/revoke")
  @HttpCode(200)
  @RequirePermissions("service:write")
  revoke(
    @Param("id", uuid) id: string,
    @Param("keyId", uuid) keyId: string,
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.update(id, keyId, null, actor);
  }
  @Post("evidence/:runId/:evidenceId/release")
  @HttpCode(200)
  @RequirePermissions("service:write", "run:read")
  release(
    @Param("runId", uuid) runId: string,
    @Param("evidenceId", uuid) evidenceId: string,
    @Body(new ZodValidationPipe(evidenceReleaseBodySchema))
    body: { allowed: boolean },
    @CurrentAccount() actor: RequestAccount,
  ) {
    return this.services.release(runId, evidenceId, body.allowed, actor);
  }
}
@Controller("open/v1")
@SetMetadata(IS_SERVICE_API, true)
export class OpenExecutionController {
  constructor(private readonly services: ServicesService) {}
  @Get("targets")
  @Scope("run:execute")
  targets(@Req() req: Request, @Query(page) q: ServicePageQuery) {
    return this.services.catalog(req.servicePrincipal!, q);
  }
  @Get("targets/:id/scenarios")
  @Scope("run:execute")
  scenarios(
    @Req() req: Request,
    @Param("id", uuid) id: string,
    @Query(page) q: ServicePageQuery,
  ) {
    return this.services.catalog(req.servicePrincipal!, q, id);
  }
  @Post("runs")
  @Scope("run:execute")
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(externalRunBodySchema)) body: ExternalRunBody,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.services.create(
      req.servicePrincipal!,
      body,
      req.requestId!,
    );
    res.status(result.created ? 201 : 200);
    return result.detail;
  }
  @Get("runs")
  @Scope("run:read")
  list(@Req() req: Request, @Query(page) q: ServicePageQuery) {
    return this.services.runs(req.servicePrincipal!, q);
  }
  @Get("runs/:id")
  @Scope("run:read")
  get(@Req() req: Request, @Param("id", uuid) id: string) {
    return this.services.run(req.servicePrincipal!, id);
  }
  @Post("runs/:id/cancel")
  @HttpCode(200)
  @Scope("run:cancel")
  cancel(@Req() req: Request, @Param("id", uuid) id: string) {
    return this.services.run(req.servicePrincipal!, id, true);
  }
  @Get("runs/:id/evidence")
  @Scope("run:read", "evidence:read")
  evidence(
    @Req() req: Request,
    @Param("id", uuid) id: string,
    @Query(page) q: ServicePageQuery,
  ) {
    return this.services.evidence(req.servicePrincipal!, id, q);
  }
  @Get("runs/:id/evidence/:evidenceId/content")
  @Scope("run:read", "evidence:read")
  async content(
    @Req() req: Request,
    @Param("id", uuid) id: string,
    @Param("evidenceId", uuid) evidenceId: string,
    @Res() res: Response,
  ) {
    const file = await this.services.content(
      req.servicePrincipal!,
      id,
      evidenceId,
    );
    res
      .set({
        "Content-Type": file.contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": 'attachment; filename="screenshot"',
        "Accept-Ranges": "bytes",
      })
      .status(200)
      .send(Buffer.from(file.body));
  }
}
